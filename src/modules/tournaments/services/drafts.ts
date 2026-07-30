import { randomBytes } from 'node:crypto';
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Cache } from '../../../core/cache.js';
import type { Database } from '../../../core/db/client.js';
import { UserError } from '../../../core/errors.js';
import type { FetchClient } from '../../../core/http/fetch-client.js';
import type { Logger } from '../../../core/logger.js';
import {
  autoChoice,
  canChoose,
  draftView,
  type DraftChoice,
  type DraftView,
} from '../draft/engine.js';
import {
  DOTA_DRAFT_SEQUENCE,
  VALORANT_MAPS,
  draftSubject,
  mapVetoSequence,
  type DraftOption,
  type DraftSide,
  type DraftStep,
} from '../draft/pools.js';
import {
  draftChoices,
  matchDrafts,
  tournamentMatches,
  type DraftChoiceRow,
  type MatchDraftRow,
  type MatchRow,
  type TournamentRow,
} from '../schema.js';

/** Сколько ждём один ход. Минута: хватает подумать и мало, чтобы никого не мучить. */
export const STEP_TIMEOUT_MS = 60_000;

const OPENDOTA_HEROES = 'https://api.opendota.com/api/heroes';
const HERO_CACHE_KEY = 'dota:heroes';
const HERO_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const HERO_IMAGE_BASE =
  'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes';

interface OpenDotaHero {
  id: number;
  name: string;
  localized_name: string;
}

export interface DraftState {
  draft: MatchDraftRow;
  choices: DraftChoiceRow[];
  view: DraftView;
}

export function createDraftsService(deps: {
  db: Database;
  cache: Cache;
  logger: Logger;
  /** Клиент OpenDota: нужен только для списка героев Dota. */
  heroClient?: FetchClient;
}) {
  const { db, cache, logger } = deps;

  /**
   * Список героев. Тянется из OpenDota и лежит в кэше сутки: он меняется с патчем, и
   * захардкоженные сто двадцать шесть имён устарели бы к первому же обновлению игры.
   *
   * Отказ здесь не ошибка, а отсутствие драфта: матч сыграется без него, как играл до сих
   * пор. Ронять матч из-за недоступного справочника было бы несоразмерно.
   */
  async function dotaHeroes(): Promise<DraftOption[] | null> {
    if (!deps.heroClient) return null;
    const client = deps.heroClient;

    try {
      const cached = await cache.swr<DraftOption[]>(HERO_CACHE_KEY, {
        ttlMs: HERO_CACHE_TTL_MS,
        staleMs: 7 * HERO_CACHE_TTL_MS,
        load: async () => {
          const heroes = await client.json<OpenDotaHero[]>(OPENDOTA_HEROES);
          return heroes
            .map((hero) => ({
              id: hero.name.replace('npc_dota_hero_', ''),
              label: hero.localized_name,
              imageUrl: `${HERO_IMAGE_BASE}/${hero.name.replace('npc_dota_hero_', '')}.png`,
            }))
            .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
        },
      });
      return cached.value.length > 0 ? cached.value : null;
    } catch (error) {
      logger.warn({ err: error }, 'список героев Dota недоступен — матч пройдёт без драфта');
      return null;
    }
  }

  async function choicesOf(draftId: number): Promise<DraftChoiceRow[]> {
    return db
      .select()
      .from(draftChoices)
      .where(eq(draftChoices.draftId, draftId))
      .orderBy(asc(draftChoices.step));
  }

  function viewOf(draft: MatchDraftRow, rows: DraftChoiceRow[]): DraftView {
    const choices: DraftChoice[] = rows.map((row) => ({
      step: row.step,
      side: row.side,
      kind: row.kind,
      optionId: row.optionId,
    }));
    return draftView(draft.pool, draft.sequence as DraftStep[], choices);
  }

  async function stateOf(draft: MatchDraftRow): Promise<DraftState> {
    const rows = await choicesOf(draft.id);
    return { draft, choices: rows, view: viewOf(draft, rows) };
  }

  /** Завершает драфт, когда шаги кончились. Идемпотентно: условие в WHERE. */
  async function completeIfDone(draft: MatchDraftRow, view: DraftView): Promise<void> {
    if (!view.done) return;
    await db
      .update(matchDrafts)
      .set({ completedAt: new Date(), deadlineAt: null })
      .where(and(eq(matchDrafts.id, draft.id), isNull(matchDrafts.completedAt)));
  }

  return {
    /**
     * Создаёт драфт для матча. Идемпотентно: один матч — один драфт, второй вернёт
     * существующий, потому что комнаты матчей пересоздаются повторными вызовами.
     *
     * `null` означает «драфт этой дисциплине не нужен или справочник недоступен» — это
     * штатный исход, а не сбой.
     */
    async ensureForMatch(
      tournament: TournamentRow,
      match: MatchRow,
    ): Promise<{ draft: MatchDraftRow; created: boolean } | null> {
      const [existing] = await db.select().from(matchDrafts).where(eq(matchDrafts.matchId, match.id));
      if (existing) return { draft: existing, created: false };

      const subject = draftSubject(tournament.game);
      if (subject === null) return null;
      if (match.entrantAId === null || match.entrantBId === null) return null;

      const pool = subject === 'maps' ? [...VALORANT_MAPS] : await dotaHeroes();
      if (!pool || pool.length < 2) return null;

      const sequence =
        subject === 'maps' ? mapVetoSequence(pool.length, tournament.bestOf) : [...DOTA_DRAFT_SEQUENCE];
      if (sequence.length === 0) return null;

      const [created] = await db
        .insert(matchDrafts)
        .values({
          matchId: match.id,
          tournamentId: tournament.id,
          subject,
          pool,
          sequence,
          tokenA: randomBytes(16).toString('hex'),
          tokenB: randomBytes(16).toString('hex'),
          deadlineAt: new Date(Date.now() + STEP_TIMEOUT_MS),
        })
        .onConflictDoNothing()
        .returning();
      if (created) return { draft: created, created: true };

      // Вставку занял конкурентный вызов — перечитываем. Признак «создан» при этом ложный:
      // ссылки капитанам разошлёт тот вызов, который действительно вставил строку.
      const [again] = await db.select().from(matchDrafts).where(eq(matchDrafts.matchId, match.id));
      return again ? { draft: again, created: false } : null;
    },

    /** Матчи, которые уже можно играть, но драфта у них ещё нет. */
    async matchesNeedingDraft(tournamentId: number): Promise<MatchRow[]> {
      const rows = await db
        .select({ match: tournamentMatches, draftId: matchDrafts.id })
        .from(tournamentMatches)
        .leftJoin(matchDrafts, eq(matchDrafts.matchId, tournamentMatches.id))
        .where(
          and(
            eq(tournamentMatches.tournamentId, tournamentId),
            eq(tournamentMatches.state, 'ready'),
            isNull(matchDrafts.id),
            sql`${tournamentMatches.entrantAId} is not null`,
            sql`${tournamentMatches.entrantBId} is not null`,
          ),
        );
      return rows.map((row) => row.match);
    },

    async byMatch(matchId: number): Promise<MatchDraftRow | null> {
      const [row] = await db.select().from(matchDrafts).where(eq(matchDrafts.matchId, matchId));
      return row ?? null;
    },

    async byId(draftId: number): Promise<MatchDraftRow | null> {
      const [row] = await db.select().from(matchDrafts).where(eq(matchDrafts.id, draftId));
      return row ?? null;
    },

    /** Сторона, за которую даёт действовать этот токен. Пустой токен — только смотреть. */
    sideOfToken(draft: MatchDraftRow, token: string | undefined): DraftSide | null {
      if (!token) return null;
      if (token === draft.tokenA) return 'a';
      if (token === draft.tokenB) return 'b';
      return null;
    },

    state: stateOf,

    /**
     * Делает выбор. От гонки защищает уникальность `(draftId, step)`: два одновременных
     * нажатия вычислят один номер шага, но вставка удастся одному — второй получит внятный
     * отказ вместо перезаписи чужого хода.
     */
    async choose(
      draftId: number,
      side: DraftSide,
      optionId: string | null,
      actorId: string | null,
    ): Promise<DraftState> {
      const draft = await this.byId(draftId);
      if (!draft) throw new UserError('Драфт не найден.');

      const before = await stateOf(draft);
      const verdict = canChoose(before.view, side, optionId);
      if (!verdict.ok) throw new UserError(verdict.reason);

      const step = before.view.current;
      if (!step) throw new UserError('Драфт уже закончен.');

      const [inserted] = await db
        .insert(draftChoices)
        .values({
          draftId,
          step: before.view.step,
          side,
          kind: step.kind,
          optionId,
          actorId,
        })
        .onConflictDoNothing()
        .returning();

      if (!inserted) {
        throw new UserError('Этот ход уже сделан — обнови страницу.');
      }

      const after = await stateOf(draft);
      await completeIfDone(draft, after.view);

      if (!after.view.done) {
        await db
          .update(matchDrafts)
          .set({ deadlineAt: new Date(Date.now() + STEP_TIMEOUT_MS) })
          .where(eq(matchDrafts.id, draftId));
      }

      return stateOf((await this.byId(draftId)) ?? draft);
    },

    /** Драфты, где время хода вышло. */
    async overdue(now: Date, limit: number): Promise<MatchDraftRow[]> {
      return db
        .select()
        .from(matchDrafts)
        .where(
          and(
            isNull(matchDrafts.completedAt),
            or(isNull(matchDrafts.deadlineAt), lt(matchDrafts.deadlineAt, now)),
          ),
        )
        .orderBy(asc(matchDrafts.deadlineAt))
        .limit(limit);
    },

    /**
     * Двигает просроченный драфт: бан пропускается, пик берётся первым свободным. Без этого
     * закрытый браузер одного капитана останавливал бы матч навсегда — та же болезнь, что у
     * матча без заявленного результата, и лечится так же.
     */
    async advanceOverdue(draft: MatchDraftRow): Promise<DraftState> {
      const before = await stateOf(draft);
      if (before.view.done) {
        await completeIfDone(draft, before.view);
        return before;
      }

      const side = before.view.current?.side;
      if (!side) return before;

      return this.choose(draft.id, side, autoChoice(before.view), null);
    },
  };
}

export type DraftsService = ReturnType<typeof createDraftsService>;
