import { and, asc, desc, eq, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import { auditLog } from '../../../core/db/schema/core.js';
import { UserError } from '../../../core/errors.js';
import type { EventBus } from '../../../core/events/bus.js';
import type { BotEvents } from '../../../core/events/events.js';
import type { Logger } from '../../../core/logger.js';
import {
  arrivalPlan,
  assignSeeds,
  buildBracket,
  effectiveFormat,
  loserTarget,
  positionKey,
  winnerTarget,
  type AdvanceTarget,
  type BracketFormat,
  type MatchBracket,
  type MatchPosition,
} from '../bracket.js';
import { scoreDisagrees, type MatchScore } from '../score.js';
import { correctionBlocker, type CorrectionTarget } from './correction.js';
import { autoTeamName, formTeams, type Signup } from '../teams.js';
import {
  draftChoices,
  matchDrafts,
  tournamentCycles,
  tournamentEntrantMembers,
  tournamentEntrants,
  tournamentMatchReports,
  tournamentMatches,
  tournaments,
  type EntrantRow,
  type EntryMode,
  type MatchRow,
  type MatchState,
  type SeedingMode,
  type TournamentFormat,
  type TournamentGame,
  type TournamentRow,
} from '../schema.js';

/** Сколько ждать подтверждения соперника, прежде чем принять результат самому. */
export const AUTO_CONFIRM_AFTER_MS = 60 * 60 * 1_000;

/** Действия, которые закрывают матч, — в отличие от заявки и спора. */
export const SETTLE_ACTIONS = ['confirm', 'resolve', 'walkover', 'auto-confirm', 'verified'] as const;
export type SettleAction = (typeof SETTLE_ACTIONS)[number];

export interface CreateTournamentInput {
  guildId: string;
  name: string;
  game: TournamentGame;
  format: TournamentFormat;
  entryMode: EntryMode;
  teamSize: number;
  maxEntrants: number;
  seeding: SeedingMode;
  bestOf: number;
  /**
   * Играют ли со способностями. Не задано — да: обычный турнир играется ими, а дуэль на
   * прицел это отдельный случай. Выключенные способности означают турнир без драфта вовсе.
   */
  abilities?: boolean;
  /** Собирает ли бот составы сам из записавшихся по одному. Только для командного турнира. */
  autoTeams?: boolean;
  /**
   * Потолок стоимости состава в очках у турниров Genshin. `null` и отсутствие означают одно —
   * без потолка, играют чем есть.
   *
   * Поле объявлено здесь не для порядка: пока его тут не было, вызывающие передавали потолок
   * россыпью (`...{ costCap }`), TypeScript такие спреды не проверяет, и вставка молча его
   * теряла. Формат задавал бюджет, а в строке турнира его не оказывалось.
   */
  costCap?: number | null;
  /** Сколько персонажей игрок защитит от бана. Ноль — иммунов в турнире нет. */
  immunities?: number;
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

/** Итог замены: команда, размер состава после и признак того, что турнир уже идёт. */
export interface RosterChange {
  entrant: EntrantRow;
  rosterSize: number;
  duringTournament: boolean;
}

function required<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`операция с ${what} не вернула строку`);
  return row;
}

export function createTournamentsService(deps: { db: Database; bus?: EventBus; logger?: Logger }) {
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

  /**
   * Старт — в шину: прогрессия начисляет опыт за участие и выдаёт «Дебют» и «Капитана».
   * Капитаны — только у команд, собранных руками: капитан, назначенный автосбором, команду
   * не собирал, и достижение «Собрал команду» было бы неправдой.
   */
  async function publishStarted(tournament: TournamentRow, entrantIds: number[]): Promise<void> {
    if (!deps.bus || entrantIds.length === 0) return;
    // Турнир к этому моменту уже стартовал в базе, и сбой здесь не должен выглядеть как
    // несостоявшийся старт: вызывающий не отправил бы объявление первого круга, а повторить
    // старт уже нельзя. Потеря — только награды за участие; она записывается.
    try {
      await emitStarted(deps.bus, tournament, entrantIds);
    } catch (error) {
      deps.logger?.error({ err: error, tournamentId: tournament.id }, 'турнир стартовал, но событие о старте не опубликовано');
    }
  }

  async function emitStarted(bus: EventBus, tournament: TournamentRow, entrantIds: number[]): Promise<void> {
    const rows = await db
      .select({ userId: tournamentEntrantMembers.userId, captainUserId: tournamentEntrants.captainUserId })
      .from(tournamentEntrantMembers)
      .innerJoin(tournamentEntrants, eq(tournamentEntrants.id, tournamentEntrantMembers.entrantId))
      .where(inArray(tournamentEntrantMembers.entrantId, entrantIds));

    const handPicked = tournament.entryMode === 'team' && !tournament.autoTeams;
    await bus.emit('tournament.started', {
      guildId: tournament.guildId,
      tournamentId: tournament.id,
      entrants: entrantIds.length,
      participantUserIds: [...new Set(rows.map((row) => row.userId))],
      captainUserIds: handPicked ? [...new Set(rows.map((row) => row.captainUserId))] : [],
    });
  }

  /**
   * Сервер турнира — для событий: слушателю он нужен, а у матча его нет. Запоминается на
   * время жизни сервиса: сервер у турнира не меняется никогда.
   */
  const guilds = new Map<number, string>();
  async function guildOf(tournamentId: number): Promise<string> {
    const known = guilds.get(tournamentId);
    if (known) return known;
    const [row] = await db
      .select({ guildId: tournaments.guildId })
      .from(tournaments)
      .where(eq(tournaments.id, tournamentId));
    if (!row) throw new Error(`турнир ${tournamentId} не найден`);
    guilds.set(tournamentId, row.guildId);
    return row.guildId;
  }

  /**
   * Событие матча — после того, как переход уже в базе. Шина необязательна: без неё сервис
   * работает как раньше. Сбой публикации переход не отменяет: он уже случился, а витрина
   * догонит его по следующему событию или по перезагрузке.
   */
  async function emitMatch<
    K extends
      | 'match.ready'
      | 'match.reported'
      | 'match.disputed'
      | 'match.confirmed'
      | 'match.live'
      | 'match.corrected'
      | 'match.reset',
  >(
    event: K,
    tournamentId: number,
    payload: Omit<BotEvents[K], 'guildId' | 'tournamentId'>,
  ): Promise<void> {
    if (!deps.bus) return;
    try {
      const guildId = await guildOf(tournamentId);
      await deps.bus.emit(event, { guildId, tournamentId, ...payload } as BotEvents[K]);
    } catch (error) {
      deps.logger?.warn({ err: error, event, tournamentId }, 'событие матча не опубликовано');
    }
  }

  /** Список участников изменился — для витрины, которая показывает его во время регистрации. */
  async function emitEntrants(tournamentId: number): Promise<void> {
    if (!deps.bus) return;
    try {
      await deps.bus.emit('tournament.entrants', { guildId: await guildOf(tournamentId), tournamentId });
    } catch (error) {
      deps.logger?.warn({ err: error, tournamentId }, 'событие о составе участников не опубликовано');
    }
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

  /**
   * Все комнаты турнира — включая комнаты вышедших участников.
   *
   * Отдельно от `activeEntrants` намеренно. Уборка отвечает не на вопрос «кто играет», а на
   * вопрос «что было создано»: у вышедшего участника голосовой канал остаётся ровно там же,
   * где был, и `withdrawnAt` его не удаляет. Пока уборка ходила по активным, каждый снявшийся
   * с турнира оставлял на сервере комнату навсегда — и на отменённом турнире это была уже
   * половина комнат, потому что снятие как раз и есть обычная причина отмены.
   */
  async function tournamentVoiceRooms(tournamentId: number): Promise<string[]> {
    const rows = await db
      .select({ voiceChannelId: tournamentEntrants.voiceChannelId })
      .from(tournamentEntrants)
      .where(eq(tournamentEntrants.tournamentId, tournamentId));
    return rows.map((row) => row.voiceChannelId).filter((id): id is string => id !== null);
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

  /**
   * Названия сторон матча. Нужны для отказа по счёту: сказать «счёт против победителя» мало,
   * человеку надо назвать, кто с кем перепутан, иначе он будет гадать, что именно исправить.
   */
  async function sideNames(
    tournamentId: number,
    entrantAId: number,
    entrantBId: number,
  ): Promise<{ a: string; b: string }> {
    const rows = await db
      .select({ id: tournamentEntrants.id, name: tournamentEntrants.displayName })
      .from(tournamentEntrants)
      .where(eq(tournamentEntrants.tournamentId, tournamentId));
    const nameOf = (id: number): string => rows.find((row) => row.id === id)?.name ?? `#${id}`;
    return { a: nameOf(entrantAId), b: nameOf(entrantBId) };
  }

  async function membersOf(entrantId: number): Promise<string[]> {
    const rows = await db
      .select({ userId: tournamentEntrantMembers.userId })
      .from(tournamentEntrantMembers)
      .where(eq(tournamentEntrantMembers.entrantId, entrantId));
    return rows.map((row) => row.userId);
  }

  /**
   * Команда капитана и её состав — с проверкой, что зовущий действительно капитан и что
   * турнир ещё живой. Одна функция вместо повторения четырёх проверок в каждой замене.
   */
  async function captainEntrant(
    tournamentId: number,
    captainUserId: string,
  ): Promise<{ tournament: TournamentRow; entrant: EntrantRow }> {
    const tournament = await byId(tournamentId);
    if (tournament.state !== 'registration' && tournament.state !== 'running') {
      throw new UserError('Этот турнир уже закрыт — состав менять не в чем.');
    }

    const entrant = await entrantOfUser(tournamentId, captainUserId);
    if (!entrant) throw new UserError('Ты не участвуешь в этом турнире.');
    if (entrant.captainUserId !== captainUserId) {
      throw new UserError('Состав меняет только капитан.');
    }
    return { tournament, entrant };
  }

  /** След замены в общем журнале: «кто это сделал» спрашивают уже после турнира. */
  async function audit(
    tournament: TournamentRow,
    actorId: string,
    action: string,
    targetId: string,
    entrant: EntrantRow,
  ): Promise<void> {
    await db.insert(auditLog).values({
      guildId: tournament.guildId,
      actorId,
      action,
      targetId,
      details: {
        tournamentId: tournament.id,
        entrantId: entrant.id,
        team: entrant.displayName,
        state: tournament.state,
      },
    });
  }

  async function logAction(
    matchId: number,
    actorId: string,
    action: 'report' | 'confirm' | 'dispute' | 'resolve' | 'walkover' | 'auto-confirm' | 'verified' | 'replay' | 'correct',
    claimedWinnerId: number | null,
    byOrganizer: boolean,
  ): Promise<void> {
    await db.insert(tournamentMatchReports).values({ matchId, actorId, action, claimedWinnerId, byOrganizer });
  }

  /**
   * Форма построенной сетки. Читается из самих матчей, а не считается из числа участников
   * — и это не стилистика, а исправление живой ошибки: в сетку идут только отметившиеся,
   * а зарегистрированных бывает больше. Прежний код брал число участников из регистраций,
   * и стоило зарегистрироваться десяти при пяти пришедших — сетка строилась на 8, а
   * продвижение считало её на 16, финал не распознавался финалом, турнир не закрывался
   * никогда. При ежедневном автомате, где неявки — норма, это случилось бы в первую неделю.
   */
  interface BracketShape {
    size: number;
    format: BracketFormat;
    byPosition: Map<string, MatchRow>;
    /** Сколько участников матч получит за всё время: 0, 1 или 2. */
    arrivals: Map<string, number>;
  }

  const BRACKET_ORDER: Record<MatchBracket, number> = { upper: 0, lower: 1, grand: 2 };

  /**
   * Порядок зависимостей: вся верхняя сетка, потом нижняя по кругам, потом гранд-финал.
   * Нижняя зависит от верхней, верхняя от нижней — никогда, поэтому такой обход гарантирует,
   * что к моменту разбора матча все его источники уже разобраны.
   */
  function inDependencyOrder(positions: MatchPosition[]): MatchPosition[] {
    return [...positions].sort(
      (a, b) =>
        BRACKET_ORDER[a.bracket] - BRACKET_ORDER[b.bracket] || a.round - b.round || a.slot - b.slot,
    );
  }

  async function loadShape(tournamentId: number): Promise<BracketShape> {
    const rows = await db
      .select()
      .from(tournamentMatches)
      .where(eq(tournamentMatches.tournamentId, tournamentId));

    const byPosition = new Map<string, MatchRow>();
    for (const row of rows) byPosition.set(positionKey(row), row);

    const occupancy = rows
      .filter((row) => row.bracket === 'upper' && row.round === 1)
      .sort((a, b) => a.slot - b.slot)
      .map((row) => (row.entrantAId === null ? 0 : 1) + (row.entrantBId === null ? 0 : 1));

    // Формат — по факту наличия гранд-финала в построенной сетке, а не по настройке
    // турнира: настройку можно поменять, а сетка уже сложена и переигрывать её нечем.
    const format: BracketFormat = byPosition.has(
      positionKey({ bracket: 'grand', round: 1, slot: 0 }),
    )
      ? 'double-elim'
      : 'single-elim';

    return {
      size: occupancy.length * 2,
      format,
      byPosition,
      arrivals: arrivalPlan(occupancy, format),
    };
  }

  /**
   * Ставит участника в целевой слот. Идемпотентно: условие «слот ещё пуст» стоит прямо в
   * WHERE, поэтому повторный вызов не перезапишет уже продвинутого, а конкурентный не
   * затрёт чужого. Это важно, потому что доставка может случиться дважды — двойным
   * нажатием кнопки, повторной доставкой взаимодействия Discord или наложением
   * автоподтверждения на ручное.
   */
  async function deliver(
    shape: BracketShape,
    target: AdvanceTarget | null,
    entrantId: number,
  ): Promise<void> {
    if (!target) return;
    const key = positionKey(target);
    const existing = shape.byPosition.get(key);
    if (!existing) return;

    const column = target.side === 'a' ? tournamentMatches.entrantAId : tournamentMatches.entrantBId;
    const [placed] = await db
      .update(tournamentMatches)
      .set(target.side === 'a' ? { entrantAId: entrantId } : { entrantBId: entrantId })
      .where(and(eq(tournamentMatches.id, existing.id), isNull(column)))
      .returning();
    if (!placed) return;
    shape.byPosition.set(key, placed);

    // Пришёл единственный, кого этот матч когда-либо получит: играть не с кем, проходит
    // дальше без игры. Без этого нижняя сетка неполного турнира встала бы навсегда.
    if ((shape.arrivals.get(key) ?? 0) <= 1) {
      await settleWalkover(shape, placed, entrantId);
      return;
    }

    if (placed.entrantAId !== null && placed.entrantBId !== null) {
      const [ready] = await db
        .update(tournamentMatches)
        .set({ state: 'ready', updatedAt: new Date() })
        .where(and(eq(tournamentMatches.id, placed.id), eq(tournamentMatches.state, 'pending')))
        .returning({ id: tournamentMatches.id });
      if (ready) await emitMatch('match.ready', placed.tournamentId, { matchId: ready.id });
    }
  }

  /** Проход без игры: пропуск в сетке или неявка. Дальше продвигается тем же путём. */
  async function settleWalkover(
    shape: BracketShape,
    match: MatchRow,
    winnerEntrantId: number,
  ): Promise<void> {
    const now = new Date();
    const [row] = await db
      .update(tournamentMatches)
      .set({ state: 'walkover', winnerEntrantId, confirmedAt: now, updatedAt: now })
      .where(and(eq(tournamentMatches.id, match.id), isNull(tournamentMatches.winnerEntrantId)))
      .returning();
    if (!row) return;

    shape.byPosition.set(positionKey(row), row);
    await logAction(row.id, 'system', 'walkover', winnerEntrantId, false);
    const { finished } = await advanceIn(shape, row, winnerEntrantId);
    await emitMatch('match.confirmed', row.tournamentId, { matchId: row.id, winnerEntrantId, via: 'bye', finished });
  }

  /**
   * Разводит итог матча: проигравший — в нижнюю сетку (при double elimination), победитель
   * — дальше. Если победителю идти некуда, этот матч и был последним: так финал
   * определяется формой сетки, а не арифметикой о числе кругов.
   */
  async function advanceIn(
    shape: BracketShape,
    match: MatchRow,
    winnerEntrantId: number,
  ): Promise<{ finished: boolean }> {
    const position: MatchPosition = {
      bracket: match.bracket,
      round: match.round,
      slot: match.slot,
    };

    const loserId =
      match.entrantAId === winnerEntrantId ? match.entrantBId : match.entrantAId;
    if (loserId !== null) {
      await deliver(shape, loserTarget(shape.size, shape.format, position), loserId);
    }

    const target = winnerTarget(shape.size, shape.format, position);
    const targetRow = target ? shape.byPosition.get(positionKey(target)) : undefined;

    if (!target || !targetRow) {
      const [closed] = await db
        .update(tournaments)
        .set({
          state: 'finished',
          winnerEntrantId,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(tournaments.id, match.tournamentId), eq(tournaments.state, 'running')))
        .returning();

      // Событие публикуется только тем вызовом, который действительно закрыл турнир:
      // условие на state = 'running' в WHERE делает это гарантией, поэтому повторная
      // доставка не начислит награду победителю дважды.
      if (closed) await publishFinished(closed, winnerEntrantId);
      return { finished: true };
    }

    await deliver(shape, target, winnerEntrantId);
    return { finished: false };
  }

  async function promote(match: MatchRow, winnerEntrantId: number): Promise<{ finished: boolean }> {
    const shape = await loadShape(match.tournamentId);
    return advanceIn(shape, match, winnerEntrantId);
  }

  return {
    async create(input: CreateTournamentInput): Promise<TournamentRow> {
      const [row] = await db
        .insert(tournaments)
        .values({
          guildId: input.guildId,
          name: input.name,
          game: input.game,
          format: input.format,
          entryMode: input.entryMode,
          teamSize: input.entryMode === 'solo' ? 1 : input.teamSize,
          maxEntrants: input.maxEntrants,
          seeding: input.seeding,
          bestOf: input.bestOf,
          abilities: input.abilities ?? true,
          // Автосбор только у командного турнира: в матче один на один делить нечего.
          autoTeams: input.entryMode === 'team' && (input.autoTeams ?? false),
          requireVerified: input.requireVerified,
          // Потолок стоимости состава: `null` означает «без потолка», и его надо отличать от
          // «не передали». Пока поле было в типе, но не в этой вставке, бюджет турнира молча
          // терялся — формат его задавал, а строка турнира оставалась без него.
          ...(input.costCap === undefined || input.costCap === null ? {} : { costCap: input.costCap }),
          ...(input.immunities === undefined ? {} : { immunities: input.immunities }),
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
    tournamentVoiceRooms,
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

    /**
     * Ручные турниры в регистрации, у которых время старта уже наступило или наступит до
     * `until`. Турниры суточного автомата сюда не попадают: их стартует сам автомат, и два
     * старта одного турнира с разных путей дали бы отказ на втором — каждую минуту.
     */
    async manualRegistrationsClosingBy(until: Date): Promise<TournamentRow[]> {
      return db
        .select()
        .from(tournaments)
        .where(
          and(
            eq(tournaments.state, 'registration'),
            sql`${tournaments.registrationClosesAt} is not null`,
            lte(tournaments.registrationClosesAt, until),
            sql`not exists (select 1 from ${tournamentCycles} where ${tournamentCycles.tournamentId} = ${tournaments.id})`,
          ),
        )
        .orderBy(asc(tournaments.registrationClosesAt));
    },

    async openRegistration(tournamentId: number, closesAt: Date): Promise<void> {
      await db
        .update(tournaments)
        .set({ state: 'registration', registrationClosesAt: closesAt, updatedAt: new Date() })
        .where(and(eq(tournaments.id, tournamentId), eq(tournaments.state, 'draft')));
    },

    /**
     * Собирает составы из тех, кто записался по одному. Вызывается перед жеребьёвкой.
     *
     * Участник первого игрока становится составом и переименовывается, остальные переходят в
     * него, а их прежние участники помечаются вышедшими. Так сделано вместо создания новых
     * строк, чтобы не потерять отметку о готовности: она уже стоит у каждого, и переносить её
     * на новую строку значило бы решать за человека, готов он или нет.
     *
     * Лишние (те, кого не хватило на полный состав) выходят из турнира. Это честнее, чем
     * добрать команду до размера: место в неполном составе выглядит участием, а на деле им не
     * является — против полной пятёрки такой состав проигрывает механически.
     */
    async assembleTeams(
      tournamentId: number,
      strengths: Map<number, number>,
    ): Promise<{ teams: number; benched: string[] }> {
      const tournament = await byId(tournamentId);
      if (!tournament.autoTeams || tournament.entryMode !== 'team') return { teams: 0, benched: [] };

      const ready = (await activeEntrants(tournamentId)).filter((entrant) => entrant.checkedInAt !== null);
      const signups: Signup[] = [];
      for (const entrant of ready) {
        const members = await membersOf(entrant.id);
        // Состав больше одного означает, что команду собрали руками. Такую не разбираем:
        // люди пришли вместе, и разводить их по разным составам нельзя.
        if (members.length !== 1) return { teams: 0, benched: [] };
        signups.push({
          entrantId: entrant.id,
          userId: members[0] as string,
          strength: strengths.get(entrant.id) ?? null,
        });
      }

      const formation = formTeams(signups, tournament.teamSize);
      if (formation.teams.length === 0) return { teams: 0, benched: [] };

      const now = new Date();
      for (const [index, team] of formation.teams.entries()) {
        const captain = team.members[0] as Signup;
        await db
          .update(tournamentEntrants)
          .set({ displayName: autoTeamName(index), captainUserId: captain.userId })
          .where(eq(tournamentEntrants.id, captain.entrantId));
        await db
          .update(tournamentEntrantMembers)
          .set({ role: 'captain' })
          .where(eq(tournamentEntrantMembers.entrantId, captain.entrantId));

        for (const member of team.members.slice(1)) {
          // Сначала уводим человека, потом закрываем его прежнего участника: обратный порядок
          // упёрся бы в уникальность «один человек — один участник в турнире».
          await db
            .update(tournamentEntrantMembers)
            .set({ entrantId: captain.entrantId, role: 'player' })
            .where(eq(tournamentEntrantMembers.entrantId, member.entrantId));
          await db
            .update(tournamentEntrants)
            .set({ withdrawnAt: now })
            .where(eq(tournamentEntrants.id, member.entrantId));
        }
      }

      for (const spare of formation.benched) {
        await db
          .update(tournamentEntrants)
          .set({ withdrawnAt: now })
          .where(eq(tournamentEntrants.id, spare.entrantId));
      }

      return { teams: formation.teams.length, benched: formation.benched.map((spare) => spare.userId) };
    },

    /** Запоминает афишу турнира — событие Discord, которое её показывает. */
    async attachScheduledEvent(tournamentId: number, eventId: string): Promise<void> {
      await db
        .update(tournaments)
        .set({ scheduledEventId: eventId, updatedAt: new Date() })
        .where(eq(tournaments.id, tournamentId));
    },

    /**
     * Турниры, которые формально идут, а на самом деле брошены: с момента старта прошло
     * больше отведённого времени и **ни один матч не менялся** всё это время.
     *
     * Зачем это вообще нужно. Автоподтверждение закрывает только те матчи, где кто-то
     * заявил результат. Матч, где оба соперника просто разошлись и никто ничего не написал,
     * остаётся играбельным навсегда — значит турнир навсегда остаётся running. А суточный
     * автомат намеренно не начинает новый день, пока предыдущий турнир не закрыт, и
     * пропускает день. Каждый день. То есть один скучный вечер выключал ежедневные турниры
     * до вмешательства человека — автомат перестаёт быть автоматом.
     *
     * Признак безделья — время последнего изменения матчей, а не число сыгранных: турнир
     * могут играть медленно, и обрывать живой вечер нельзя.
     *
     * Вместе с турниром отдаём число незакрытых матчей. Если их ноль, турнир обязан был
     * закрыться сам, и отменять его нельзя — это уничтожило бы уже определённого победителя.
     * Такой случай вызывающий должен разобрать, а не замести.
     */
    async staleRunning(
      now: Date,
      idleMs: number,
    ): Promise<{ tournament: TournamentRow; openMatches: number }[]> {
      const threshold = new Date(now.getTime() - idleMs);

      const running = await db
        .select()
        .from(tournaments)
        .where(
          and(
            eq(tournaments.state, 'running'),
            sql`${tournaments.startedAt} is not null`,
            lt(tournaments.startedAt, threshold),
          ),
        );

      const stale: { tournament: TournamentRow; openMatches: number }[] = [];
      for (const tournament of running) {
        const rows = await db
          .select({ state: tournamentMatches.state, updatedAt: tournamentMatches.updatedAt })
          .from(tournamentMatches)
          .where(eq(tournamentMatches.tournamentId, tournament.id));

        const lastTouched = rows.reduce<Date | null>(
          (latest, row) => (latest === null || row.updatedAt > latest ? row.updatedAt : latest),
          null,
        );
        if (lastTouched !== null && lastTouched >= threshold) continue;

        stale.push({
          tournament,
          openMatches: rows.filter((row) =>
            (['pending', 'ready', 'reported', 'disputed'] as MatchState[]).includes(row.state),
          ).length,
        });
      }

      return stale;
    },

    /**
     * Отмена. Отметка о закрытии ставится сразу: каждый путь отмены убирает за турниром сам и
     * тут же, а объявлять у отменённого нечего — синхронизатору здесь делать нечего.
     */
    async cancel(tournamentId: number): Promise<void> {
      const now = new Date();
      // CAS по состоянию: отменить можно только незакрытый, и событие — ровно одно.
      const [row] = await db
        .update(tournaments)
        .set({ state: 'cancelled', finishedAt: now, closedOutAt: now, updatedAt: now })
        .where(and(eq(tournaments.id, tournamentId), inArray(tournaments.state, ['draft', 'registration', 'running'])))
        .returning();
      if (row && deps.bus) {
        await deps.bus
          .emit('tournament.cancelled', { guildId: row.guildId, tournamentId })
          .catch((error: unknown) => deps.logger?.warn({ err: error, tournamentId }, 'событие отмены не опубликовано'));
      }
    },

    /**
     * Занять закрытие доигранного турнира. Отдаёт турнир только тому вызову, который занял
     * отметку первым: кнопка подтверждения и джоба могут прийти к одному финалу одновременно,
     * и без этого итог объявлялся бы дважды.
     */
    async claimCloseOut(tournamentId: number): Promise<TournamentRow | null> {
      const [row] = await db
        .update(tournaments)
        .set({ closedOutAt: new Date() })
        .where(
          and(
            eq(tournaments.id, tournamentId),
            eq(tournaments.state, 'finished'),
            isNull(tournaments.closedOutAt),
          ),
        )
        .returning();
      return row ?? null;
    },

    /**
     * Турниры, которым синхронизатор ещё может быть нужен: идущие — у них могут появиться
     * играбельные матчи без ветки и драфта — и доигранные, за которыми ещё не убрали.
     */
    async needingSync(): Promise<TournamentRow[]> {
      return db
        .select()
        .from(tournaments)
        .where(
          sql`${tournaments.state} = 'running' or (${tournaments.state} = 'finished' and ${tournaments.closedOutAt} is null)`,
        )
        .orderBy(asc(tournaments.id));
    },

    /**
     * Как закрылся последний матч турнира: подтверждением, молчанием, решением организатора
     * или проверкой по данным игры. Нужно итогу: оговорка «принято по молчанию» верна только
     * про молчание, и раньше она стояла под каждым итогом.
     */
    async finalClosure(tournamentId: number): Promise<SettleAction | null> {
      const [row] = await db
        .select({ action: tournamentMatchReports.action })
        .from(tournamentMatchReports)
        .innerJoin(tournamentMatches, eq(tournamentMatches.id, tournamentMatchReports.matchId))
        .where(
          and(
            eq(tournamentMatches.tournamentId, tournamentId),
            inArray(tournamentMatchReports.action, [...SETTLE_ACTIONS]),
            // Проход без игры по пропуску в сетке делает сам бот, и финалом он не бывает.
            sql`not (${tournamentMatchReports.actorId} = 'system' and ${tournamentMatchReports.action} = 'walkover')`,
          ),
        )
        .orderBy(desc(tournamentMatchReports.id))
        .limit(1);
      return (row?.action as SettleAction | undefined) ?? null;
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

      await emitEntrants(tournamentId);
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
      await emitEntrants(entrant.tournamentId);
      return entrant;
    },

    async leaveEntrant(tournamentId: number, userId: string): Promise<void> {
      const entrant = await entrantOfUser(tournamentId, userId);
      if (!entrant) throw new UserError('Ты не участвуешь в этом турнире.');

      const tournament = await byId(tournamentId);

      // Капитан уходит вместе с командой: команда без капитана не сможет ни добрать
      // состав, ни отчитаться о результате, и застопорит вечер. Поэтому во время турнира
      // капитану выйти нельзя — это снятие всей команды из уже построенной сетки.
      if (entrant.captainUserId === userId) {
        if (tournament.state !== 'registration') {
          throw new UserError(
            'Турнир идёт: капитан не может выйти, это снимет всю команду из сетки. Передать команду нельзя — доиграйте или попросите организатора присудить победу сопернику (`/match walkover`).',
          );
        }
        await db
          .update(tournamentEntrants)
          .set({ withdrawnAt: new Date() })
          .where(eq(tournamentEntrants.id, entrant.id));
        await db.delete(tournamentEntrantMembers).where(eq(tournamentEntrantMembers.entrantId, entrant.id));
        await emitEntrants(tournamentId);
        return;
      }

      await db
        .delete(tournamentEntrantMembers)
        .where(and(eq(tournamentEntrantMembers.entrantId, entrant.id), eq(tournamentEntrantMembers.userId, userId)));
      await emitEntrants(tournamentId);
    },

    /**
     * Замена в составе: капитан убирает игрока. Работает и во время турнира — сетка сводит
     * **участников**, а не людей, поэтому смена состава её не задевает вовсе.
     *
     * Без замен капитан ничего не мог сделать с неявившимся за пять минут до старта:
     * команда либо снималась целиком, либо вопрос решался вручную через организатора. Это
     * укусило бы на первом же турнире, потому что кто-то не приходит всегда.
     */
    async removeMember(
      tournamentId: number,
      captainUserId: string,
      userId: string,
    ): Promise<RosterChange> {
      const { tournament, entrant } = await captainEntrant(tournamentId, captainUserId);
      if (userId === captainUserId) {
        throw new UserError('Капитан выходит вместе с командой — это `/team leave`, а не замена.');
      }

      const [removed] = await db
        .delete(tournamentEntrantMembers)
        .where(
          and(
            eq(tournamentEntrantMembers.entrantId, entrant.id),
            eq(tournamentEntrantMembers.userId, userId),
          ),
        )
        .returning();
      if (!removed) throw new UserError('Этого игрока нет в твоём составе.');

      await audit(tournament, captainUserId, 'tournament.roster.remove', userId, entrant);
      return {
        entrant,
        rosterSize: (await membersOf(entrant.id)).length,
        duringTournament: tournament.state === 'running',
      };
    },

    /**
     * Замена в составе: капитан добавляет игрока. Согласия кнопкой не спрашиваем — замена
     * происходит за минуты до матча, когда заменяющий стоит рядом в голосовом канале и уже
     * согласился словами. Если это не так, он выходит сам: `/team leave` во время турнира
     * рядовому игроку разрешён.
     */
    async addMember(
      tournamentId: number,
      captainUserId: string,
      userId: string,
    ): Promise<RosterChange> {
      const { tournament, entrant } = await captainEntrant(tournamentId, captainUserId);
      if (tournament.entryMode === 'solo') {
        throw new UserError('Это турнир одиночек — составов в нём нет.');
      }

      const members = await membersOf(entrant.id);
      if (members.includes(userId)) throw new UserError('Он уже в твоём составе.');
      if (members.length >= tournament.teamSize) {
        throw new UserError(
          `В составе уже ${tournament.teamSize} — сначала убери кого-то: \`/team kick\`.`,
        );
      }

      const elsewhere = await entrantOfUser(tournamentId, userId);
      if (elsewhere) {
        throw new UserError(`Он уже играет за «${elsewhere.displayName}» — сначала пусть выйдет оттуда.`);
      }

      // Пришедший посреди турнира записывается заменой: в составе видно, кто играл
      // изначально, а кто вышел вместо кого-то.
      await db.insert(tournamentEntrantMembers).values({
        entrantId: entrant.id,
        tournamentId,
        userId,
        role: tournament.state === 'running' ? 'sub' : 'player',
      });

      await audit(tournament, captainUserId, 'tournament.roster.add', userId, entrant);
      return {
        entrant,
        rosterSize: members.length + 1,
        duringTournament: tournament.state === 'running',
      };
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
      await emitEntrants(tournamentId);
      return required(row, 'tournament_entrants');
    },

    /**
     * Закрывает регистрацию, раскладывает сеяных и строит сетку — одной транзакцией.
     * `strengths` приходит снаружи: силу состава считает мост к этапу 1, а этот сервис
     * про ранги ничего не знает.
     *
     * В сетку идут только отметившиеся и не снявшиеся: чек-ин обязывающий.
     */
    async start(
      tournamentId: number,
      strengths: Map<number, number>,
      /**
       * Источник случая для жеребьёвки `random`. Внедряется ради тестов: проверить, что
       * жеребьёвка действительно случайная, а не по силе, можно только подставив свой.
       */
      random: () => number = Math.random,
    ): Promise<BracketView> {
      const tournament = await byId(tournamentId);
      if (tournament.state !== 'registration') {
        throw new UserError('Этот турнир не в состоянии регистрации.');
      }

      const eligible = (await activeEntrants(tournamentId)).filter((entrant) => entrant.checkedInAt !== null);
      if (eligible.length < 2) {
        throw new UserError('Играть некому: отметилось меньше двух участников.');
      }

      // Формат может выродиться: двойное устранение на двух участниках это та же пара
      // второй раз, а не второй шанс. Фактический формат записывается в турнир, чтобы
      // витрина и подсказки говорили то же, что построено.
      const format = effectiveFormat(eligible.length, tournament.format);

      // Случайная жеребьёвка — это сила, выпавшая на кубике, а не отдельный алгоритм: сетка
      // раскладывается тем же кодом, и отличается только то, кто окажется первым сидом.
      // Раньше настройка сохранялась и показывалась, но жеребьёвка всё равно шла по силе.
      const seeded = assignSeeds(
        eligible.map((entrant) => ({
          entrantId: entrant.id,
          // Целым числом: сила хранится в `seed_score`, а колонка целая.
          strength:
            tournament.seeding === 'random'
              ? Math.floor(random() * 1_000_000)
              : (strengths.get(entrant.id) ?? 0),
        })),
      );
      const planned = buildBracket(seeded, format);

      const occupancy = planned
        .filter((match) => match.bracket === 'upper' && match.round === 1)
        .sort((a, b) => a.slot - b.slot)
        .map((match) => (match.entrantAId === null ? 0 : 1) + (match.entrantBId === null ? 0 : 1));
      const arrivals = arrivalPlan(occupancy, format);

      // Матчи, которые можно играть сразу. Те, что станут играбельными по ходу пропусков,
      // объявят себя сами — из deliver.
      let readyAtStart: number[] = [];
      await db.transaction(async (tx) => {
        for (const entrant of seeded) {
          await tx
            .update(tournamentEntrants)
            .set({ seed: entrant.seed, seedScore: entrant.score })
            .where(eq(tournamentEntrants.id, entrant.entrantId));
        }

        const inserted = await tx.insert(tournamentMatches).values(
          planned.map((match) => {
            const expected = arrivals.get(positionKey(match)) ?? 0;
            const known = (match.entrantAId === null ? 0 : 1) + (match.entrantBId === null ? 0 : 1);
            return {
              tournamentId,
              bracket: match.bracket,
              round: match.round,
              slot: match.slot,
              entrantAId: match.entrantAId,
              entrantBId: match.entrantBId,
              // Никто не придёт — матча не будет: место под проигравшего, которого не
              // случилось. Оба известны — можно играть. Иначе ждём предыдущий круг.
              state:
                expected === 0 ? ('void' as const) : known === 2 ? ('ready' as const) : ('pending' as const),
            };
          }),
        ).returning({ id: tournamentMatches.id, state: tournamentMatches.state });
        readyAtStart = inserted.filter((row) => row.state === 'ready').map((row) => row.id);

        // CAS по состоянию: ручной старт и автостарт по времени могут прийти в одну минуту, и
        // второй должен откатиться целиком, а не построить вторую сетку поверх первой.
        const [begun] = await tx
          .update(tournaments)
          .set({ state: 'running', format, startedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(tournaments.id, tournamentId), eq(tournaments.state, 'registration')))
          .returning({ id: tournaments.id });
        if (!begun) throw new UserError('Этот турнир уже стартовал.');
      });

      // Пропуски проводим сразу и в порядке зависимостей: участник, оказавшийся один в
      // паре, проходит дальше без игры, иначе сетка встанет на матче, который никто не
      // сыграет. Порядок важен — проход по верхней сетке освобождает места в нижней.
      const shape = await loadShape(tournamentId);
      for (const position of inDependencyOrder([...shape.byPosition.values()])) {
        const match = shape.byPosition.get(positionKey(position));
        if (!match || match.winnerEntrantId !== null || match.state === 'void') continue;
        const lone = match.entrantAId ?? match.entrantBId;
        if (lone === null) continue;
        if ((shape.arrivals.get(positionKey(position)) ?? 0) !== 1) continue;
        await settleWalkover(shape, match, lone);
      }

      await publishStarted(tournament, seeded.map((entrant) => entrant.entrantId));
      for (const matchId of readyAtStart) await emitMatch('match.ready', tournamentId, { matchId });
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

    /**
     * Запоминает ветку матча, если её ещё нет. `false` — ветку уже успел завести другой путь,
     * и только что созданную надо удалить: две ветки на матч — это два места, где соперники
     * договариваются, и половина договорённостей потеряется.
     */
    async attachThread(matchId: number, threadId: string): Promise<boolean> {
      const [row] = await db
        .update(tournamentMatches)
        .set({ threadId })
        .where(and(eq(tournamentMatches.id, matchId), isNull(tournamentMatches.threadId)))
        .returning({ id: tournamentMatches.id });
      return row !== undefined;
    },

    /**
     * Ветки незакрытых матчей участника. Нужны замене: пришедший посреди турнира должен
     * попасть в ветку матча, который его команда сейчас играет, а ушедший — выйти из неё.
     */
    async openThreadsOf(entrantId: number): Promise<string[]> {
      const rows = await db
        .select({ threadId: tournamentMatches.threadId })
        .from(tournamentMatches)
        .where(
          and(
            sql`(${tournamentMatches.entrantAId} = ${entrantId} or ${tournamentMatches.entrantBId} = ${entrantId})`,
            inArray(tournamentMatches.state, ['ready', 'reported', 'disputed']),
            sql`${tournamentMatches.threadId} is not null`,
          ),
        );
      return rows.map((row) => row.threadId).filter((id): id is string => id !== null);
    },

    /**
     * Матчи, которым пора выложить карточку «матч готов»: играбельны, ветка есть, карточки ещё
     * не было. Выборка по отсутствию отметки — повторный прогон добирает то, что не вышло.
     */
    async matchesNeedingCard(tournamentId: number): Promise<MatchRow[]> {
      return db
        .select()
        .from(tournamentMatches)
        .where(
          and(
            eq(tournamentMatches.tournamentId, tournamentId),
            eq(tournamentMatches.state, 'ready'),
            isNull(tournamentMatches.announcedAt),
            sql`${tournamentMatches.threadId} is not null`,
          ),
        )
        .orderBy(asc(tournamentMatches.round), asc(tournamentMatches.slot));
    },

    /** Играбельные матчи, которые ещё не начались: у турнира без веток их начинают сразу. */
    async matchesWaitingToStart(tournamentId: number): Promise<MatchRow[]> {
      return db
        .select()
        .from(tournamentMatches)
        .where(
          and(
            eq(tournamentMatches.tournamentId, tournamentId),
            eq(tournamentMatches.state, 'ready'),
            isNull(tournamentMatches.liveAt),
          ),
        );
    },

    /** Запомнить сообщение карточки, чтобы перерисовать её, когда матч начнётся не из неё. */
    async attachCard(matchId: number, messageId: string): Promise<void> {
      await db.update(tournamentMatches).set({ cardMessageId: messageId }).where(eq(tournamentMatches.id, matchId));
    },

    /** Занять отметку о карточке. `false` — её уже выложил другой путь. */
    async markAnnounced(matchId: number): Promise<boolean> {
      const [row] = await db
        .update(tournamentMatches)
        .set({ announcedAt: new Date() })
        .where(and(eq(tournamentMatches.id, matchId), isNull(tournamentMatches.announcedAt)))
        .returning({ id: tournamentMatches.id });
      return row !== undefined;
    },

    /**
     * «На месте»: сторона готова играть. Нажимать может любой игрок стороны — команда в сборе,
     * значит можно начинать, и ждать именно капитана незачем.
     *
     * Когда на месте обе стороны, матч начинается: ставится `liveAt` и публикуется
     * `match.live` — на нём стартует таймер драфта и закрывается приём прогнозов. Отметки
     * ставятся CAS-ом, и двойное нажатие не начинает матч дважды.
     */
    async markPresent(
      matchId: number,
      userId: string,
      now: Date = new Date(),
    ): Promise<{ match: MatchRow; side: 'a' | 'b'; alreadyPresent: boolean; started: boolean }> {
      const match = await this.matchById(matchId);
      if (match.state !== 'ready') throw new UserError('Этот матч уже не ждёт начала.');

      const entrant = await entrantOfUser(match.tournamentId, userId);
      const side = entrant?.id === match.entrantAId ? 'a' : entrant?.id === match.entrantBId ? 'b' : null;
      if (!side) throw new UserError('Отметиться может только игрок этого матча.');
      return this.markSidePresent(matchId, side, now);
    },

    /**
     * То же «На месте», но по стороне, а не по человеку: страница драфта знает сторону по
     * токену ссылки капитана, а кто именно нажал — нет.
     */
    async markSidePresent(
      matchId: number,
      side: 'a' | 'b',
      now: Date = new Date(),
    ): Promise<{ match: MatchRow; side: 'a' | 'b'; alreadyPresent: boolean; started: boolean }> {
      const match = await this.matchById(matchId);
      if (match.state !== 'ready') throw new UserError('Этот матч уже не ждёт начала.');

      const column = side === 'a' ? tournamentMatches.presentAAt : tournamentMatches.presentBAt;
      const [marked] = await db
        .update(tournamentMatches)
        .set(side === 'a' ? { presentAAt: now } : { presentBAt: now })
        .where(and(eq(tournamentMatches.id, matchId), isNull(column)))
        .returning();

      const current = marked ?? (await this.matchById(matchId));
      const started =
        current.presentAAt !== null && current.presentBAt !== null ? await this.startMatch(matchId, now) : false;
      return { match: await this.matchById(matchId), side, alreadyPresent: !marked, started };
    },

    /**
     * Матч начался: обе стороны на месте — или организатор решил не ждать. `true` только у того
     * вызова, который действительно начал.
     */
    async startMatch(matchId: number, now: Date = new Date()): Promise<boolean> {
      const [row] = await db
        .update(tournamentMatches)
        .set({ liveAt: now, updatedAt: now })
        .where(
          and(eq(tournamentMatches.id, matchId), eq(tournamentMatches.state, 'ready'), isNull(tournamentMatches.liveAt)),
        )
        .returning();
      if (!row) return false;
      await emitMatch('match.live', row.tournamentId, { matchId });
      return true;
    },

    /**
     * Матчи, где карточка висит дольше `afterMs`, а на месте не обе стороны, и организатора
     * ещё не звали. Неявка — единственное, что останавливает вечер без чьей-либо вины в базе:
     * матч просто висит, и никто не знает, ждать ли.
     */
    async noShowsDue(now: Date, afterMs: number): Promise<MatchRow[]> {
      return db
        .select()
        .from(tournamentMatches)
        .where(
          and(
            eq(tournamentMatches.state, 'ready'),
            isNull(tournamentMatches.liveAt),
            isNull(tournamentMatches.escalatedAt),
            lt(tournamentMatches.announcedAt, new Date(now.getTime() - afterMs)),
            // Только идущие турниры: отмена оставляет матчи в «готов», и без этого условия
            // организатора звали бы к матчу турнира, которого уже нет.
            sql`exists (select 1 from ${tournaments} where ${tournaments.id} = ${tournamentMatches.tournamentId} and ${tournaments.state} = 'running')`,
          ),
        )
        .orderBy(asc(tournamentMatches.announcedAt));
    },

    async markEscalated(matchId: number, now: Date = new Date()): Promise<boolean> {
      const [row] = await db
        .update(tournamentMatches)
        .set({ escalatedAt: now })
        .where(and(eq(tournamentMatches.id, matchId), isNull(tournamentMatches.escalatedAt)))
        .returning({ id: tournamentMatches.id });
      return row !== undefined;
    },

    /**
     * «Подождать ещё»: организатор решил дать время. Отметка о сигнале снимается, а отсчёт
     * сдвигается так, чтобы до следующего сигнала прошло ровно `waitMs`.
     */
    async snoozeNoShow(matchId: number, waitMs: number, afterMs: number, now: Date = new Date()): Promise<void> {
      await db
        .update(tournamentMatches)
        .set({ escalatedAt: null, announcedAt: new Date(now.getTime() + waitMs - afterMs) })
        .where(and(eq(tournamentMatches.id, matchId), eq(tournamentMatches.state, 'ready')));
    },

    /** Заявленные давно и ещё без напоминания сопернику. */
    async confirmRemindersDue(now: Date, afterMs: number): Promise<MatchRow[]> {
      return db
        .select()
        .from(tournamentMatches)
        .where(
          and(
            eq(tournamentMatches.state, 'reported'),
            isNull(tournamentMatches.confirmRemindedAt),
            lt(tournamentMatches.reportedAt, new Date(now.getTime() - afterMs)),
            sql`exists (select 1 from ${tournaments} where ${tournaments.id} = ${tournamentMatches.tournamentId} and ${tournaments.state} = 'running')`,
          ),
        );
    },

    async markConfirmReminded(matchId: number): Promise<boolean> {
      const [row] = await db
        .update(tournamentMatches)
        .set({ confirmRemindedAt: new Date() })
        .where(and(eq(tournamentMatches.id, matchId), isNull(tournamentMatches.confirmRemindedAt)))
        .returning({ id: tournamentMatches.id });
      return row !== undefined;
    },

    /**
     * «Переиграть»: организатор решил, что спор не решить словами. Матч возвращается в
     * «готов» с чистого листа — без заявки и без отметок присутствия: переигровка начинается
     * так же, как игра.
     */
    async replay(matchId: number, actorId: string): Promise<MatchRow> {
      const now = new Date();
      const [row] = await db
        .update(tournamentMatches)
        .set({
          state: 'ready',
          reportedBy: null,
          reportedWinnerId: null,
          reportedScoreA: null,
          reportedScoreB: null,
          reportedAt: null,
          disputedAt: null,
          disputeReason: null,
          confirmRemindedAt: null,
          presentAAt: null,
          presentBAt: null,
          liveAt: null,
          escalatedAt: null,
          announcedAt: now,
          updatedAt: now,
        })
        .where(and(eq(tournamentMatches.id, matchId), eq(tournamentMatches.state, 'disputed')))
        .returning();
      if (!row) throw new UserError('Переиграть можно только оспоренный матч, а этот уже закрыт или не оспорен.');
      await logAction(matchId, actorId, 'replay', null, true);
      await emitMatch('match.ready', row.tournamentId, { matchId });
      return row;
    },

    /**
     * Исправить закрытый результат: откатить продвижение прежнего победителя (и прежнего
     * проигравшего в нижнюю сетку) и провести заново — уже с новым. Можно, пока следующие матчи
     * не начаты; правило и отказы — в `correction.ts`.
     *
     * Ветки следующих матчей создавались с прежними составами, поэтому их идентификаторы
     * отдаются наверх — удалить в Discord. Синхронизатор заведёт новые, уже с теми, кто играет.
     */
    async correct(
      matchId: number,
      actorId: string,
      newWinnerId: number,
    ): Promise<{ match: MatchRow; staleThreads: string[] }> {
      const match = await this.matchById(matchId);
      const tournament = await byId(match.tournamentId);
      const shape = await loadShape(match.tournamentId);
      const position: MatchPosition = { bracket: match.bracket, round: match.round, slot: match.slot };

      // Прошлая попытка могла записать нового победителя и упасть до того, как провела его
      // дальше: тогда его слот в следующем матче пуст. Повтор той же команды это чинит — ведёт
      // победителя дальше, — а не отвечает «он и так победитель», оставляя сетку дырявой.
      if (tournament.state === 'running' && match.winnerEntrantId === newWinnerId) {
        const next = winnerTarget(shape.size, shape.format, position);
        const nextRow = next ? shape.byPosition.get(positionKey(next)) : undefined;
        const holder = next && nextRow ? (next.side === 'a' ? nextRow.entrantAId : nextRow.entrantBId) : undefined;
        if (nextRow && holder === null) {
          await advanceIn(shape, match, newWinnerId);
          return { match: await this.matchById(matchId), staleThreads: [] };
        }
      }

      const oldWinner = match.winnerEntrantId;
      const oldLoser = oldWinner === match.entrantAId ? match.entrantBId : match.entrantAId;

      const targets: CorrectionTarget[] = [];
      const collect = async (target: AdvanceTarget | null, delivered: number | null): Promise<void> => {
        if (!target || delivered === null) return;
        const row = shape.byPosition.get(positionKey(target));
        if (!row) return;
        const [moves] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(draftChoices)
          .innerJoin(matchDrafts, eq(matchDrafts.id, draftChoices.draftId))
          .where(eq(matchDrafts.matchId, row.id));
        targets.push({ match: row, side: target.side, delivered, draftMoves: moves?.count ?? 0 });
      };
      await collect(winnerTarget(shape.size, shape.format, position), oldWinner);
      await collect(loserTarget(shape.size, shape.format, position), oldLoser);

      const [bye] = await db
        .select({ id: tournamentMatchReports.id })
        .from(tournamentMatchReports)
        .where(
          and(
            eq(tournamentMatchReports.matchId, matchId),
            eq(tournamentMatchReports.action, 'walkover'),
            eq(tournamentMatchReports.actorId, 'system'),
          ),
        )
        .limit(1);

      const blocker = correctionBlocker({
        tournamentState: tournament.state,
        match,
        bye: bye !== undefined,
        newWinnerId,
        targets,
      });
      if (blocker) throw new UserError(blocker);

      const staleThreads = targets.map((target) => target.match.threadId).filter((id): id is string => id !== null);
      const now = new Date();

      await db.transaction(async (tx) => {
        for (const target of targets) {
          const column = target.side === 'a' ? tournamentMatches.entrantAId : tournamentMatches.entrantBId;
          // Условия повторяют проверку выше: если между проверкой и записью следующий матч
          // успел начаться, откат не пройдёт, и транзакция вернёт всё как было.
          const [cleared] = await tx
            .update(tournamentMatches)
            .set({
              ...(target.side === 'a' ? { entrantAId: null } : { entrantBId: null }),
              state: 'pending',
              threadId: null,
              announcedAt: null,
              presentAAt: null,
              presentBAt: null,
              liveAt: null,
              escalatedAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(tournamentMatches.id, target.match.id),
                eq(column, target.delivered),
                isNull(tournamentMatches.winnerEntrantId),
                isNull(tournamentMatches.liveAt),
                inArray(tournamentMatches.state, ['pending', 'ready']),
              ),
            )
            .returning({ id: tournamentMatches.id });
          if (!cleared) throw new UserError('Следующий матч изменился, пока исправляли, — попробуйте ещё раз.');
          // Драфт следующего матча собран под прежнего соперника — его заведут заново.
          await tx.delete(matchDrafts).where(eq(matchDrafts.matchId, target.match.id));
        }

        // Счёт сбрасывается: он был заявлен под прежнего победителя и новому противоречил бы.
        const [updated] = await tx
          .update(tournamentMatches)
          .set({ winnerEntrantId: newWinnerId, scoreA: null, scoreB: null, updatedAt: now })
          .where(
            and(
              eq(tournamentMatches.id, matchId),
              oldWinner === null ? isNull(tournamentMatches.winnerEntrantId) : eq(tournamentMatches.winnerEntrantId, oldWinner),
            ),
          )
          .returning({ id: tournamentMatches.id });
        if (!updated) throw new UserError('Результат матча изменился, пока исправляли, — попробуйте ещё раз.');

        await tx
          .insert(tournamentMatchReports)
          .values({ matchId, actorId, action: 'correct', claimedWinnerId: newWinnerId, byOrganizer: true });
      });

      // Следующие матчи пересобираются с другим соперником: всё, что к ним было привязано по
      // прежней паре (прогнозы, карточки), должно быть сброшено раньше, чем они снова станут
      // играбельными, — поэтому событие до продвижения, а не после.
      for (const target of targets) {
        await emitMatch('match.reset', match.tournamentId, { matchId: target.match.id });
      }

      const fresh = await this.matchById(matchId);
      await advanceIn(await loadShape(match.tournamentId), fresh, newWinnerId);
      if (oldWinner !== null) {
        await emitMatch('match.corrected', match.tournamentId, {
          matchId,
          winnerEntrantId: newWinnerId,
          previousWinnerId: oldWinner,
        });
      }
      return { match: await this.matchById(matchId), staleThreads };
    },

    /**
     * Матчи турнира для подсказок в командах организатора: номер, кто с кем, состояние. Без
     * них номер матча приходилось искать на сайте и переписывать руками.
     */
    async matchesForPicker(tournamentId: number, states: readonly MatchState[]): Promise<MatchRow[]> {
      return db
        .select()
        .from(tournamentMatches)
        .where(
          and(
            eq(tournamentMatches.tournamentId, tournamentId),
            inArray(tournamentMatches.state, [...states]),
            sql`${tournamentMatches.entrantAId} is not null`,
            sql`${tournamentMatches.entrantBId} is not null`,
          ),
        )
        .orderBy(asc(tournamentMatches.id));
    },

    /**
     * Счёт личных встреч двух людей на этом сервере — по всем закрытым матчам всех турниров.
     *
     * Бот знает исход каждого матча, но до сих пор не умел сказать «вы играли семь раз, счёт
     * 4:3», а именно это помнят и о чём спорят перед игрой. Сторона матча — участник, а
     * человек за ним — капитан: у одиночек это сам игрок, у команд — тот, кто её собрал.
     * Проход без игры по пропуску в сетке встречей не считается: соперника там не было.
     */
    async headToHead(
      guildId: string,
      userA: string,
      userB: string,
      excludeMatchId?: number,
    ): Promise<{ games: number; winsA: number; winsB: number }> {
      const result = await db.execute<{ winner_captain: string }>(sql`
        select case when w.id = ea.id then ea.captain_user_id else eb.captain_user_id end as winner_captain
        from ${tournamentMatches} m
        join ${tournaments} t on t.id = m.tournament_id
        join ${tournamentEntrants} ea on ea.id = m.entrant_a_id
        join ${tournamentEntrants} eb on eb.id = m.entrant_b_id
        join ${tournamentEntrants} w on w.id = m.winner_entrant_id
        where t.guild_id = ${guildId}
          and m.state in ('confirmed', 'walkover')
          and m.id <> ${excludeMatchId ?? 0}
          and (
            (ea.captain_user_id = ${userA} and eb.captain_user_id = ${userB})
            or (ea.captain_user_id = ${userB} and eb.captain_user_id = ${userA})
          )
      `);
      const winsA = result.rows.filter((row) => row.winner_captain === userA).length;
      return { games: result.rows.length, winsA, winsB: result.rows.length - winsA };
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
          .orderBy(
            asc(tournamentMatches.bracket),
            asc(tournamentMatches.round),
            asc(tournamentMatches.slot),
          ),
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
    async report(
      matchId: number,
      actorId: string,
      winnerEntrantId: number,
      /**
       * Счёт со стороны A и B. Необязателен: проверить его бот не может, а требовать поле,
       * которое всё равно вводят руками, значит ставить участника перед выбором между
       * «наврал» и «не смог отчитаться».
       */
      score?: MatchScore,
    ): Promise<MatchRow> {
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

      // Счёт, противоречащий названному победителю, — либо опечатка, либо попытка подправить
      // историю. Остановить это надо здесь: в сетке и зале славы запись остаётся навсегда.
      if (score) {
        const names = await sideNames(match.tournamentId, match.entrantAId, match.entrantBId);
        const disagrees = scoreDisagrees(
          score,
          winnerEntrantId === match.entrantAId ? 'a' : 'b',
          names,
        );
        if (disagrees) throw new UserError(disagrees);
      }

      const now = new Date();
      const [row] = await db
        .update(tournamentMatches)
        .set({
          state: 'reported',
          reportedBy: actorId,
          reportedWinnerId: winnerEntrantId,
          ...(score ? { reportedScoreA: score.a, reportedScoreB: score.b } : {}),
          reportedAt: now,
          updatedAt: now,
        })
        .where(and(eq(tournamentMatches.id, matchId), eq(tournamentMatches.state, 'ready')))
        .returning();

      if (!row) throw new UserError('Результат этого матча уже заявлен или матч уже закрыт.');
      await logAction(matchId, actorId, 'report', winnerEntrantId, false);
      await emitMatch('match.reported', row.tournamentId, { matchId, winnerEntrantId });
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

    async dispute(
      matchId: number,
      actorId: string,
      /** Почему оспаривают — со слов оспорившего; организатор читает это до того, как решать. */
      reason?: string,
    ): Promise<MatchRow> {
      const match = await this.matchById(matchId);
      if (match.state !== 'reported') throw new UserError('Этот матч не ждёт подтверждения.');

      const entrant = await entrantOfUser(match.tournamentId, actorId);
      if (!entrant || (entrant.id !== match.entrantAId && entrant.id !== match.entrantBId)) {
        throw new UserError('Оспорить результат может только участник этого матча.');
      }

      const now = new Date();
      const [row] = await db
        .update(tournamentMatches)
        .set({
          state: 'disputed',
          disputedAt: now,
          updatedAt: now,
          ...(reason?.trim() ? { disputeReason: reason.trim().slice(0, 500) } : {}),
        })
        .where(and(eq(tournamentMatches.id, matchId), eq(tournamentMatches.state, 'reported')))
        .returning();
      if (!row) throw new UserError('Матч уже закрыт.');

      await logAction(matchId, actorId, 'dispute', match.reportedWinnerId, false);
      await emitMatch('match.disputed', row.tournamentId, { matchId });
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
      action: 'confirm' | 'resolve' | 'walkover' | 'auto-confirm' | 'verified',
      byOrganizer: boolean,
      /**
       * Счёт, когда матч закрывается сразу, без заявки: проверенный по данным игры результат
       * минует `report`, и переносить счёт из `reportedScore*` там нечего.
       */
      score?: MatchScore,
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
          // Заявленный счёт становится счётом матча. Победа без игры счёта не получает: её
          // не играли, и цифры там были бы выдумкой.
          ...(action === 'walkover'
            ? {}
            : score
              ? { scoreA: score.a, scoreB: score.b }
              : {
                  scoreA: sql`${tournamentMatches.reportedScoreA}`,
                  scoreB: sql`${tournamentMatches.reportedScoreB}`,
                }),
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
      await emitMatch('match.confirmed', row.tournamentId, { matchId, winnerEntrantId, via: action, finished });
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
    /**
     * Принимает результаты, которые соперник не подтвердил за отведённый час.
     *
     * Признак `finished` возвращается наверх, и это не украшение подписи: последний матч
     * турнира чаще всего закрывается именно здесь, молчанием, а не нажатием кнопки. Пока
     * этот признак терялся, турнир, доигранный без подтверждения, заканчивался вообще без
     * уборки — голосовые комнаты команд оставались на сервере навсегда.
     */
    async autoConfirmDue(
      now: Date,
      limit: number,
    ): Promise<{ match: MatchRow; finished: boolean }[]> {
      const threshold = new Date(now.getTime() - AUTO_CONFIRM_AFTER_MS);
      const due = await db
        .select()
        .from(tournamentMatches)
        .where(and(eq(tournamentMatches.state, 'reported'), lt(tournamentMatches.reportedAt, threshold)))
        .orderBy(asc(tournamentMatches.reportedAt))
        .limit(limit);

      const settled: { match: MatchRow; finished: boolean }[] = [];
      for (const match of due) {
        if (match.reportedWinnerId === null) continue;
        settled.push(await this.settle(match.id, match.reportedWinnerId, 'system', 'auto-confirm', false));
      }
      return settled;
    },
  };
}

export type TournamentsService = ReturnType<typeof createTournamentsService>;
