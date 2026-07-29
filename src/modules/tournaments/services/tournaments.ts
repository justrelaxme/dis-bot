import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import { UserError } from '../../../core/errors.js';
import type { EventBus } from '../../../core/events/bus.js';
import { advanceTarget, assignSeeds, bracketSize, buildBracket, totalRounds } from '../bracket.js';
import {
  tournamentEntrantMembers,
  tournamentEntrants,
  tournamentMatchReports,
  tournamentMatches,
  tournaments,
  type EntrantRow,
  type EntryMode,
  type MatchRow,
  type SeedingMode,
  type TournamentGame,
  type TournamentRow,
} from '../schema.js';

/** Сколько ждать подтверждения соперника, прежде чем принять результат самому. */
export const AUTO_CONFIRM_AFTER_MS = 60 * 60 * 1_000;

export interface CreateTournamentInput {
  guildId: string;
  name: string;
  game: TournamentGame;
  entryMode: EntryMode;
  teamSize: number;
  maxEntrants: number;
  seeding: SeedingMode;
  bestOf: number;
  requireVerified: boolean;
  createdBy: string;
  announceChannelId?: string;
  teamCategoryId?: string;
  matchParentId?: string;
}

export interface BracketView {
  tournament: TournamentRow;
  entrants: EntrantRow[];
  matches: MatchRow[];
}

function required<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`операция с ${what} не вернула строку`);
  return row;
}

export function createTournamentsService(deps: { db: Database; bus?: EventBus }) {
  const { db } = deps;

  /**
   * Публикация в шину. Шина необязательна намеренно: сервис используется и там, где её нет
   * (регистрация команд с заглушками), и падать из-за отсутствия подписчиков он не должен.
   *
   * Состав победителя уходит списком идентификаторов, а не ссылкой на участника: подписчику
   * (прогрессии) нужны люди, которым начислять, а лезть в таблицы турниров он не может —
   * модули друг друга не импортируют.
   */
  async function publishFinished(tournament: TournamentRow, winnerEntrantId: number): Promise<void> {
    if (!deps.bus) return;
    const winners = await db
      .select({ userId: tournamentEntrantMembers.userId })
      .from(tournamentEntrantMembers)
      .where(eq(tournamentEntrantMembers.entrantId, winnerEntrantId));

    await deps.bus.emit('tournament.finished', {
      guildId: tournament.guildId,
      tournamentId: tournament.id,
      winnerEntrantId,
      winnerUserIds: winners.map((row) => row.userId),
    });
  }

  async function byId(tournamentId: number): Promise<TournamentRow> {
    const [row] = await db.select().from(tournaments).where(eq(tournaments.id, tournamentId));
    if (!row) throw new UserError('Турнир не найден.');
    return row;
  }

  async function activeEntrants(tournamentId: number): Promise<EntrantRow[]> {
    return db
      .select()
      .from(tournamentEntrants)
      .where(and(eq(tournamentEntrants.tournamentId, tournamentId), isNull(tournamentEntrants.withdrawnAt)))
      .orderBy(asc(tournamentEntrants.id));
  }

  /** Участник, за которого играет этот человек, или null. Ограничение БД гарантирует, что он один. */
  async function entrantOfUser(tournamentId: number, userId: string): Promise<EntrantRow | null> {
    const [row] = await db
      .select({ entrant: tournamentEntrants })
      .from(tournamentEntrantMembers)
      .innerJoin(tournamentEntrants, eq(tournamentEntrants.id, tournamentEntrantMembers.entrantId))
      .where(
        and(
          eq(tournamentEntrantMembers.tournamentId, tournamentId),
          eq(tournamentEntrantMembers.userId, userId),
        ),
      );
    return row?.entrant ?? null;
  }

  async function membersOf(entrantId: number): Promise<string[]> {
    const rows = await db
      .select({ userId: tournamentEntrantMembers.userId })
      .from(tournamentEntrantMembers)
      .where(eq(tournamentEntrantMembers.entrantId, entrantId));
    return rows.map((row) => row.userId);
  }

  async function logAction(
    matchId: number,
    actorId: string,
    action: 'report' | 'confirm' | 'dispute' | 'resolve' | 'walkover' | 'auto-confirm',
    claimedWinnerId: number | null,
    byOrganizer: boolean,
  ): Promise<void> {
    await db.insert(tournamentMatchReports).values({ matchId, actorId, action, claimedWinnerId, byOrganizer });
  }

  /**
   * Продвигает победителя в родительский матч. Идемпотентно: если в целевом слоте уже
   * стоит этот же участник, повторный вызов ничего не меняет. Это важно, потому что
   * продвижение может быть вызвано дважды — двойным нажатием кнопки, повторной доставкой
   * взаимодействия Discord или наложением автоподтверждения на ручное.
   *
   * Финал родителя не имеет: если матч последнего круга подтверждён, турнир завершён.
   */
  async function promote(match: MatchRow, winnerEntrantId: number): Promise<{ finished: boolean }> {
    const entrantCount = (await activeEntrants(match.tournamentId)).length;
    const rounds = totalRounds(bracketSize(entrantCount));

    if (match.round >= rounds) {
      const [closed] = await db
        .update(tournaments)
        .set({ state: 'finished', finishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(tournaments.id, match.tournamentId), eq(tournaments.state, 'running')))
        .returning();

      // Событие публикуется только тем вызовом, который действительно закрыл турнир:
      // условие на state = 'running' в WHERE делает это гарантией, поэтому повторная
      // доставка не начислит награду победителю дважды.
      if (closed) await publishFinished(closed, winnerEntrantId);
      return { finished: true };
    }

    const target = advanceTarget(match.round, match.slot);
    const column = target.side === 'a' ? tournamentMatches.entrantAId : tournamentMatches.entrantBId;

    // Условие «слот ещё пуст» прямо в WHERE: иначе повторный вызов перезаписал бы уже
    // продвинутого участника, а конкурентный — затёр бы чужого.
    await db
      .update(tournamentMatches)
      .set(target.side === 'a' ? { entrantAId: winnerEntrantId } : { entrantBId: winnerEntrantId })
      .where(
        and(
          eq(tournamentMatches.tournamentId, match.tournamentId),
          eq(tournamentMatches.round, target.round),
          eq(tournamentMatches.slot, target.slot),
          isNull(column),
        ),
      );

    // Матч готов к игре, когда известны оба соперника.
    await db
      .update(tournamentMatches)
      .set({ state: 'ready', updatedAt: new Date() })
      .where(
        and(
          eq(tournamentMatches.tournamentId, match.tournamentId),
          eq(tournamentMatches.round, target.round),
          eq(tournamentMatches.slot, target.slot),
          eq(tournamentMatches.state, 'pending'),
          sql`${tournamentMatches.entrantAId} is not null`,
          sql`${tournamentMatches.entrantBId} is not null`,
        ),
      );

    return { finished: false };
  }

  return {
    async create(input: CreateTournamentInput): Promise<TournamentRow> {
      const [row] = await db
        .insert(tournaments)
        .values({
          guildId: input.guildId,
          name: input.name,
          game: input.game,
          entryMode: input.entryMode,
          teamSize: input.entryMode === 'solo' ? 1 : input.teamSize,
          maxEntrants: input.maxEntrants,
          seeding: input.seeding,
          bestOf: input.bestOf,
          requireVerified: input.requireVerified,
          createdBy: input.createdBy,
          ...(input.announceChannelId ? { announceChannelId: input.announceChannelId } : {}),
          ...(input.teamCategoryId ? { teamCategoryId: input.teamCategoryId } : {}),
          ...(input.matchParentId ? { matchParentId: input.matchParentId } : {}),
        })
        .returning();
      return required(row, 'tournaments');
    },

    byId,
    activeEntrants,
    entrantOfUser,
    membersOf,

    /** Турнир гильдии, который сейчас идёт или набирает участников. Их не может быть двух. */
    async current(guildId: string): Promise<TournamentRow | null> {
      const [row] = await db
        .select()
        .from(tournaments)
        .where(and(eq(tournaments.guildId, guildId), inArray(tournaments.state, ['registration', 'running'])))
        .orderBy(asc(tournaments.id));
      return row ?? null;
    },

    async openRegistration(tournamentId: number, closesAt: Date): Promise<void> {
      await db
        .update(tournaments)
        .set({ state: 'registration', registrationClosesAt: closesAt, updatedAt: new Date() })
        .where(and(eq(tournaments.id, tournamentId), eq(tournaments.state, 'draft')));
    },

    async cancel(tournamentId: number): Promise<void> {
      await db
        .update(tournaments)
        .set({ state: 'cancelled', finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(tournaments.id, tournamentId));
    },

    /**
     * Создаёт участника: для соло это сам игрок, для командного режима — команда с
     * капитаном. Дальше состав добирается кнопкой «Вступить», а не рассылкой приглашений:
     * капитану 5v5 иначе пришлось бы позвать четверых по одному.
     */
    async createEntrant(
      tournamentId: number,
      captainUserId: string,
      displayName: string,
    ): Promise<EntrantRow> {
      const tournament = await byId(tournamentId);
      if (tournament.state !== 'registration') {
        throw new UserError('Регистрация на этот турнир закрыта.');
      }

      const existing = await entrantOfUser(tournamentId, captainUserId);
      if (existing) {
        throw new UserError(`Ты уже участвуешь в этом турнире за «${existing.displayName}».`);
      }

      const entrants = await activeEntrants(tournamentId);
      if (entrants.length >= tournament.maxEntrants) {
        throw new UserError(`Мест больше нет: максимум ${tournament.maxEntrants}.`);
      }

      const name = displayName.trim();
      if (name.length === 0) throw new UserError('Название не может быть пустым.');

      // Уникальность имени и «один человек — один участник» гарантирует база, а не эти
      // проверки: между проверкой и вставкой всегда может встать конкурентный вызов.
      // Проверки выше нужны, чтобы дать человеку понятный текст в обычном случае.
      const [entrant] = await db
        .insert(tournamentEntrants)
        .values({ tournamentId, displayName: name, captainUserId })
        .returning();
      const created = required(entrant, 'tournament_entrants');

      await db.insert(tournamentEntrantMembers).values({
        entrantId: created.id,
        tournamentId,
        userId: captainUserId,
        role: 'captain',
      });

      return created;
    },

    async joinEntrant(entrantId: number, userId: string): Promise<EntrantRow> {
      const [entrant] = await db.select().from(tournamentEntrants).where(eq(tournamentEntrants.id, entrantId));
      if (!entrant) throw new UserError('Такой команды нет.');
      if (entrant.withdrawnAt) throw new UserError('Эта команда снялась с турнира.');

      const tournament = await byId(entrant.tournamentId);
      if (tournament.state !== 'registration') {
        throw new UserError('Регистрация на этот турнир закрыта.');
      }
      if (tournament.entryMode === 'solo') {
        throw new UserError('Это турнир одиночек, команды в нём не собираются.');
      }

      const already = await entrantOfUser(entrant.tournamentId, userId);
      if (already) {
        throw new UserError(
          already.id === entrantId
            ? 'Ты уже в этой команде.'
            : `Ты уже играешь за «${already.displayName}». Сначала выйди оттуда.`,
        );
      }

      const members = await membersOf(entrantId);
      if (members.length >= tournament.teamSize) {
        throw new UserError(`В команде уже ${tournament.teamSize} человек — это полный состав.`);
      }

      await db.insert(tournamentEntrantMembers).values({ entrantId, tournamentId: entrant.tournamentId, userId });
      return entrant;
    },

    async leaveEntrant(tournamentId: number, userId: string): Promise<void> {
      const entrant = await entrantOfUser(tournamentId, userId);
      if (!entrant) throw new UserError('Ты не участвуешь в этом турнире.');

      const tournament = await byId(tournamentId);
      if (tournament.state !== 'registration') {
        throw new UserError('Турнир уже начался — выйти из состава нельзя.');
      }

      // Капитан уходит вместе с командой: команда без капитана не сможет ни добрать
      // состав, ни отчитаться о результате, и застопорит вечер.
      if (entrant.captainUserId === userId) {
        await db
          .update(tournamentEntrants)
          .set({ withdrawnAt: new Date() })
          .where(eq(tournamentEntrants.id, entrant.id));
        await db.delete(tournamentEntrantMembers).where(eq(tournamentEntrantMembers.entrantId, entrant.id));
        return;
      }

      await db
        .delete(tournamentEntrantMembers)
        .where(and(eq(tournamentEntrantMembers.entrantId, entrant.id), eq(tournamentEntrantMembers.userId, userId)));
    },

    /** Организатор снимает участника. До старта — иначе сетка уже построена. */
    async removeEntrant(tournamentId: number, entrantId: number): Promise<EntrantRow> {
      const tournament = await byId(tournamentId);
      if (tournament.state === 'running') {
        throw new UserError('Турнир уже идёт: снятому участнику соперник получает победу без игры (`/match walkover`).');
      }
      const [row] = await db
        .update(tournamentEntrants)
        .set({ withdrawnAt: new Date() })
        .where(and(eq(tournamentEntrants.id, entrantId), eq(tournamentEntrants.tournamentId, tournamentId)))
        .returning();
      if (!row) throw new UserError('Такого участника в турнире нет.');
      return row;
    },

    /**
     * Чек-ин обязывающий: не отметился — не попал в сетку. При ежедневном автомате
     * неявки — обычное дело, и сетка, наполовину состоящая из неявившихся, превращает
     * турнир в череду технических побед.
     */
    async checkIn(tournamentId: number, userId: string): Promise<EntrantRow> {
      const entrant = await entrantOfUser(tournamentId, userId);
      if (!entrant) throw new UserError('Ты не участвуешь в этом турнире.');
      if (entrant.captainUserId !== userId) {
        throw new UserError('Отмечать состав может только капитан.');
      }
      const [row] = await db
        .update(tournamentEntrants)
        .set({ checkedInAt: new Date() })
        .where(eq(tournamentEntrants.id, entrant.id))
        .returning();
      return required(row, 'tournament_entrants');
    },

    /**
     * Закрывает регистрацию, раскладывает сеяных и строит сетку — одной транзакцией.
     * `strengths` приходит снаружи: силу состава считает мост к этапу 1, а этот сервис
     * про ранги ничего не знает.
     *
     * В сетку идут только отметившиеся и не снявшиеся: чек-ин обязывающий.
     */
    async start(tournamentId: number, strengths: Map<number, number>): Promise<BracketView> {
      const tournament = await byId(tournamentId);
      if (tournament.state !== 'registration') {
        throw new UserError('Этот турнир не в состоянии регистрации.');
      }

      const eligible = (await activeEntrants(tournamentId)).filter((entrant) => entrant.checkedInAt !== null);
      if (eligible.length < 2) {
        throw new UserError('Играть некому: отметилось меньше двух участников.');
      }

      const seeded = assignSeeds(
        eligible.map((entrant) => ({ entrantId: entrant.id, strength: strengths.get(entrant.id) ?? 0 })),
      );
      const planned = buildBracket(seeded);

      await db.transaction(async (tx) => {
        for (const entrant of seeded) {
          await tx
            .update(tournamentEntrants)
            .set({ seed: entrant.seed, seedScore: entrant.score })
            .where(eq(tournamentEntrants.id, entrant.entrantId));
        }

        await tx.insert(tournamentMatches).values(
          planned.map((match) => ({
            tournamentId,
            round: match.round,
            slot: match.slot,
            entrantAId: match.entrantAId,
            entrantBId: match.entrantBId,
            // Матч с одним известным участником — это пропуск: играть не с кем.
            state:
              match.entrantAId !== null && match.entrantBId !== null
                ? ('ready' as const)
                : ('pending' as const),
          })),
        );

        await tx
          .update(tournaments)
          .set({ state: 'running', startedAt: new Date(), updatedAt: new Date() })
          .where(eq(tournaments.id, tournamentId));
      });

      // Пропуски первого круга проводим сразу: участник, оказавшийся один в паре,
      // проходит дальше без игры, иначе сетка встанет на матче, который никто не сыграет.
      const firstRound = await db
        .select()
        .from(tournamentMatches)
        .where(and(eq(tournamentMatches.tournamentId, tournamentId), eq(tournamentMatches.round, 1)));

      for (const match of firstRound) {
        const lone = match.entrantAId ?? match.entrantBId;
        if (match.entrantAId !== null && match.entrantBId !== null) continue;
        if (lone === null) continue;
        await db
          .update(tournamentMatches)
          .set({ state: 'walkover', winnerEntrantId: lone, confirmedAt: new Date(), updatedAt: new Date() })
          .where(eq(tournamentMatches.id, match.id));
        await promote(match, lone);
      }

      return this.bracket(tournamentId);
    },

    /**
     * Запоминает голосовой канал участника. Уборка потом ищет канал по этому
     * идентификатору, а не по имени: имя администратор может переименовать, и тогда
     * уборка либо не найдёт нужное, либо снесёт чужое.
     */
    async attachVoice(entrantId: number, channelId: string): Promise<void> {
      await db
        .update(tournamentEntrants)
        .set({ voiceChannelId: channelId })
        .where(eq(tournamentEntrants.id, entrantId));
    },

    /**
     * Матчи, которым нужна комната: оба соперника известны, играть можно, а ветки ещё нет.
     * Выборка идёт по факту отсутствия `threadId`, а не по «только что созданным», поэтому
     * повторный вызов сам добирает то, что не удалось создать в прошлый раз — отказ Discord
     * лечится следующей попыткой, а не остаётся навсегда.
     */
    async matchesNeedingThread(tournamentId: number): Promise<MatchRow[]> {
      return db
        .select()
        .from(tournamentMatches)
        .where(
          and(
            eq(tournamentMatches.tournamentId, tournamentId),
            inArray(tournamentMatches.state, ['ready', 'reported', 'disputed']),
            isNull(tournamentMatches.threadId),
            sql`${tournamentMatches.entrantAId} is not null`,
            sql`${tournamentMatches.entrantBId} is not null`,
          ),
        )
        .orderBy(asc(tournamentMatches.round), asc(tournamentMatches.slot));
    },

    async attachThread(matchId: number, threadId: string): Promise<void> {
      await db.update(tournamentMatches).set({ threadId }).where(eq(tournamentMatches.id, matchId));
    },

    /** Ветки закрытых матчей — чтобы архивировать их при уборке. */
    async closedThreads(tournamentId: number): Promise<string[]> {
      const rows = await db
        .select({ threadId: tournamentMatches.threadId })
        .from(tournamentMatches)
        .where(eq(tournamentMatches.tournamentId, tournamentId));
      return rows.map((row) => row.threadId).filter((id): id is string => id !== null);
    },

    async bracket(tournamentId: number): Promise<BracketView> {
      const tournament = await byId(tournamentId);
      const [entrants, matches] = await Promise.all([
        db
          .select()
          .from(tournamentEntrants)
          .where(eq(tournamentEntrants.tournamentId, tournamentId))
          .orderBy(asc(tournamentEntrants.seed), asc(tournamentEntrants.id)),
        db
          .select()
          .from(tournamentMatches)
          .where(eq(tournamentMatches.tournamentId, tournamentId))
          .orderBy(asc(tournamentMatches.round), asc(tournamentMatches.slot)),
      ]);
      return { tournament, entrants, matches };
    },

    async matchById(matchId: number): Promise<MatchRow> {
      const [row] = await db.select().from(tournamentMatches).where(eq(tournamentMatches.id, matchId));
      if (!row) throw new UserError('Матч не найден.');
      return row;
    },

    /** Матч этого человека, который сейчас можно играть или репортить. */
    async currentMatchOf(tournamentId: number, userId: string): Promise<MatchRow | null> {
      const entrant = await entrantOfUser(tournamentId, userId);
      if (!entrant) return null;
      const rows = await db
        .select()
        .from(tournamentMatches)
        .where(
          and(
            eq(tournamentMatches.tournamentId, tournamentId),
            inArray(tournamentMatches.state, ['ready', 'reported', 'disputed']),
          ),
        )
        .orderBy(asc(tournamentMatches.round), asc(tournamentMatches.slot));
      return rows.find((row) => row.entrantAId === entrant.id || row.entrantBId === entrant.id) ?? null;
    },

    /**
     * Заявка результата. CAS по состоянию `ready`: повторная заявка на уже заявленный
     * матч не проходит, и это не ошибка сети, а именно то, что нужно.
     */
    async report(matchId: number, actorId: string, winnerEntrantId: number): Promise<MatchRow> {
      const match = await this.matchById(matchId);
      if (match.entrantAId === null || match.entrantBId === null) {
        throw new UserError('В этом матче ещё не известны оба соперника.');
      }
      if (winnerEntrantId !== match.entrantAId && winnerEntrantId !== match.entrantBId) {
        throw new UserError('Победитель должен быть одним из соперников этого матча.');
      }

      const entrant = await entrantOfUser(match.tournamentId, actorId);
      if (!entrant || (entrant.id !== match.entrantAId && entrant.id !== match.entrantBId)) {
        throw new UserError('Заявить результат может только участник этого матча.');
      }

      const now = new Date();
      const [row] = await db
        .update(tournamentMatches)
        .set({
          state: 'reported',
          reportedBy: actorId,
          reportedWinnerId: winnerEntrantId,
          reportedAt: now,
          updatedAt: now,
        })
        .where(and(eq(tournamentMatches.id, matchId), eq(tournamentMatches.state, 'ready')))
        .returning();

      if (!row) throw new UserError('Результат этого матча уже заявлен или матч уже закрыт.');
      await logAction(matchId, actorId, 'report', winnerEntrantId, false);
      return row;
    },

    /**
     * Подтверждение соперником. Подтвердить может только игрок **другого** участника:
     * проверка идёт по составу, а не по тому, кто нажал кнопку, иначе заявивший
     * подтвердил бы сам себя и репорт стал бы формальностью.
     */
    async confirm(matchId: number, actorId: string): Promise<{ match: MatchRow; finished: boolean }> {
      const match = await this.matchById(matchId);
      if (match.state !== 'reported') throw new UserError('Этот матч не ждёт подтверждения.');

      const reportedWinner = match.reportedWinnerId;
      if (reportedWinner === null) throw new UserError('У матча нет заявленного результата.');

      const entrant = await entrantOfUser(match.tournamentId, actorId);
      if (!entrant || (entrant.id !== match.entrantAId && entrant.id !== match.entrantBId)) {
        throw new UserError('Подтвердить результат может только участник этого матча.');
      }
      const reporterEntrant = match.reportedBy ? await entrantOfUser(match.tournamentId, match.reportedBy) : null;
      if (reporterEntrant && reporterEntrant.id === entrant.id) {
        throw new UserError('Результат подтверждает соперник, а не тот, кто его заявил.');
      }

      return this.settle(matchId, reportedWinner, actorId, 'confirm', false);
    },

    async dispute(matchId: number, actorId: string): Promise<MatchRow> {
      const match = await this.matchById(matchId);
      if (match.state !== 'reported') throw new UserError('Этот матч не ждёт подтверждения.');

      const entrant = await entrantOfUser(match.tournamentId, actorId);
      if (!entrant || (entrant.id !== match.entrantAId && entrant.id !== match.entrantBId)) {
        throw new UserError('Оспорить результат может только участник этого матча.');
      }

      const now = new Date();
      const [row] = await db
        .update(tournamentMatches)
        .set({ state: 'disputed', disputedAt: now, updatedAt: now })
        .where(and(eq(tournamentMatches.id, matchId), eq(tournamentMatches.state, 'reported')))
        .returning();
      if (!row) throw new UserError('Матч уже закрыт.');

      await logAction(matchId, actorId, 'dispute', match.reportedWinnerId, false);
      return row;
    },

    /**
     * Общий путь закрытия матча: подтверждение, решение организатора, автоподтверждение,
     * неявка. CAS по ожидаемому состоянию — единственное место, которое пишет победителя,
     * поэтому двойное нажатие, повторная доставка и гонка автоподтверждения с ручным
     * дают один результат, а не два продвижения по сетке.
     */
    async settle(
      matchId: number,
      winnerEntrantId: number,
      actorId: string,
      action: 'confirm' | 'resolve' | 'walkover' | 'auto-confirm',
      byOrganizer: boolean,
    ): Promise<{ match: MatchRow; finished: boolean }> {
      const expected =
        action === 'confirm' || action === 'auto-confirm'
          ? (['reported'] as const)
          : (['ready', 'reported', 'disputed'] as const);

      const now = new Date();
      const [row] = await db
        .update(tournamentMatches)
        .set({
          state: action === 'walkover' ? 'walkover' : 'confirmed',
          winnerEntrantId,
          confirmedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(tournamentMatches.id, matchId),
            inArray(tournamentMatches.state, [...expected]),
            isNull(tournamentMatches.winnerEntrantId),
          ),
        )
        .returning();

      if (!row) {
        const current = await this.matchById(matchId);
        // Уже закрыт тем же победителем — считаем успехом: повторная доставка не ошибка.
        if (current.winnerEntrantId === winnerEntrantId) return { match: current, finished: false };
        throw new UserError('Результат этого матча уже закрыт.');
      }

      await logAction(matchId, actorId, action, winnerEntrantId, byOrganizer);
      const { finished } = await promote(row, winnerEntrantId);
      return { match: row, finished };
    },

    async resolve(matchId: number, actorId: string, winnerEntrantId: number): Promise<{ finished: boolean }> {
      const match = await this.matchById(matchId);
      if (winnerEntrantId !== match.entrantAId && winnerEntrantId !== match.entrantBId) {
        throw new UserError('Победитель должен быть одним из соперников этого матча.');
      }
      const { finished } = await this.settle(matchId, winnerEntrantId, actorId, 'resolve', true);
      return { finished };
    },

    async walkover(matchId: number, actorId: string, winnerEntrantId: number): Promise<{ finished: boolean }> {
      const match = await this.matchById(matchId);
      if (winnerEntrantId !== match.entrantAId && winnerEntrantId !== match.entrantBId) {
        throw new UserError('Победитель должен быть одним из соперников этого матча.');
      }
      const { finished } = await this.settle(matchId, winnerEntrantId, actorId, 'walkover', true);
      return { finished };
    },

    /**
     * Автоподтверждение: соперник молчит час — результат принимается. Без этого один
     * неотвечающий игрок останавливает всю сетку, и турнир упирается в присутствие
     * организатора ровно так же, как если бы результаты вбивал он сам.
     */
    async autoConfirmDue(now: Date, limit: number): Promise<MatchRow[]> {
      const threshold = new Date(now.getTime() - AUTO_CONFIRM_AFTER_MS);
      const due = await db
        .select()
        .from(tournamentMatches)
        .where(and(eq(tournamentMatches.state, 'reported'), lt(tournamentMatches.reportedAt, threshold)))
        .orderBy(asc(tournamentMatches.reportedAt))
        .limit(limit);

      const settled: MatchRow[] = [];
      for (const match of due) {
        if (match.reportedWinnerId === null) continue;
        const result = await this.settle(match.id, match.reportedWinnerId, 'system', 'auto-confirm', false);
        settled.push(result.match);
      }
      return settled;
    },
  };
}

export type TournamentsService = ReturnType<typeof createTournamentsService>;
