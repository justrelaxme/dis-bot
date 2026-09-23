import { asc, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Cache } from '../../core/cache.js';
import type { Database } from '../../core/db/client.js';
import type { EventBus } from '../../core/events/bus.js';
import type { Logger } from '../../core/logger.js';
import { createPredictionsService } from '../predictions/service.js';
import { TOURNAMENT_GAME_LABELS } from '../tournaments/games.js';
import {
  tournamentEntrants,
  tournamentMatches,
  tournaments,
  type MatchRow,
} from '../tournaments/schema.js';
import { createDraftsService } from '../tournaments/services/drafts.js';
import { createTournamentsService, type TournamentsService } from '../tournaments/services/tournaments.js';
import { standingsOf } from '../tournaments/standings.js';
import { GAME_IDENTITY } from './art.js';
import {
  isCastSceneRequest,
  pickFeatured,
  resolveScene,
  roundLabel,
  type CastScene,
  type CastSceneRequest,
} from './cast-logic.js';
import { castControlPage, castPage } from './cast-page.js';
import { createGrantsService } from './grants.js';
import { castStates, type CastStateRow } from './schema.js';

/**
 * Трансляция через Discord: страница-сцена для Go Live и пульт к ней.
 *
 * Сцена публичная и только для чтения — это та же сетка, что и на витрине, только крупно и в
 * кадре 16:9. Управлять ею можно по ссылке от бота (`/cast`), как и всем остальным на сайте:
 * входа нет, право приходит ссылкой.
 */

export interface CastBox {
  id: number;
  a: string | null;
  b: string | null;
  winner: 'a' | 'b' | null;
  scoreA: number | null;
  scoreB: number | null;
  state: string;
  live: boolean;
}

export interface CastPick {
  label: string;
  /** Крупный арт — для пиков, мелкая иконка — для банов: пик на сцене важнее бана. */
  imageUrl: string | null;
}

export interface CastPayload {
  now: string;
  tournament: { id: number; name: string; game: string; gameLabel: string; state: string; accent: string };
  scene: CastScene;
  requested: CastSceneRequest;
  countdownAt: string | null;
  entrants: { name: string; checkedIn: boolean }[];
  bracket: { upper: CastBox[][]; lower: CastBox[][]; grand: CastBox | null };
  featured: {
    id: number;
    label: string;
    a: { name: string; seed: number | null; score: number | null };
    b: { name: string; seed: number | null; score: number | null };
    state: string;
    live: boolean;
    votes: { a: number; b: number };
    /** Личные встречи — строка на табло перед матчем. */
    history: { games: number; winsA: number; winsB: number } | null;
  } | null;
  draft: {
    bans: { a: CastPick[]; b: CastPick[] };
    picks: { a: CastPick[]; b: CastPick[] };
    current: { side: 'a' | 'b'; kind: 'ban' | 'pick' } | null;
    deadlineAt: string | null;
    armed: boolean;
    done: boolean;
  } | null;
  podium: { first: string | null; second: string | null; third: string | null } | null;
}

export interface CastRoutesDeps {
  db: Database;
  cache: Cache;
  logger: Logger;
  bus?: EventBus;
}

export function createCastStateService(db: Database) {
  return {
    async get(guildId: string): Promise<CastStateRow | null> {
      const [row] = await db.select().from(castStates).where(eq(castStates.guildId, guildId));
      return row ?? null;
    },
    async set(
      guildId: string,
      patch: { tournamentId: number; scene?: CastSceneRequest; featuredMatchId?: number | null; countdownAt?: Date | null },
      by: string,
    ): Promise<CastStateRow> {
      const values = {
        tournamentId: patch.tournamentId,
        ...(patch.scene !== undefined ? { scene: patch.scene } : {}),
        ...(patch.featuredMatchId !== undefined ? { featuredMatchId: patch.featuredMatchId } : {}),
        ...(patch.countdownAt !== undefined ? { countdownAt: patch.countdownAt } : {}),
        updatedBy: by,
        updatedAt: new Date(),
      };
      const [row] = await db
        .insert(castStates)
        .values({ guildId, ...values })
        .onConflictDoUpdate({ target: castStates.guildId, set: values })
        .returning();
      if (!row) throw new Error('состояние трансляции не сохранилось');
      return row;
    },
  };
}

export async function buildCastPayload(
  deps: {
    db: Database;
    drafts: ReturnType<typeof createDraftsService>;
    predictions: ReturnType<typeof createPredictionsService>;
    headToHead: TournamentsService['headToHead'];
  },
  tournamentId: number,
  state: CastStateRow | null,
  /**
   * Сцена, закреплённая в адресе (`?scene=bracket`), — поверх выбора пульта. Нужна для OBS:
   * отдельный источник, где всегда сетка, не должен переключаться вместе с главным окном.
   */
  pinned?: CastSceneRequest,
): Promise<CastPayload | null> {
  const [tournament] = await deps.db.select().from(tournaments).where(eq(tournaments.id, tournamentId));
  if (!tournament) return null;
  const [entrants, matches] = await Promise.all([
    deps.db.select().from(tournamentEntrants).where(eq(tournamentEntrants.tournamentId, tournamentId)).orderBy(asc(tournamentEntrants.id)),
    deps.db.select().from(tournamentMatches).where(eq(tournamentMatches.tournamentId, tournamentId)).orderBy(asc(tournamentMatches.round), asc(tournamentMatches.slot)),
  ]);

  const entrant = (id: number | null) => entrants.find((row) => row.id === id);
  const nameOf = (id: number | null): string | null => (id === null ? null : (entrant(id)?.displayName ?? '?'));
  // Выбор пульта действует только для своего турнира: табло прошлого турнира на новом было бы
  // чужим матчем.
  const own = state && state.tournamentId === tournamentId ? state : null;

  const upperRounds = Math.max(0, ...matches.filter((m) => m.bracket === 'upper').map((m) => m.round));
  const lowerRounds = Math.max(0, ...matches.filter((m) => m.bracket === 'lower').map((m) => m.round));

  const chosen = own?.featuredMatchId ? matches.find((match) => match.id === own.featuredMatchId) ?? null : null;
  const featuredMatch: MatchRow | null =
    chosen && chosen.entrantAId !== null && chosen.entrantBId !== null
      ? chosen
      : (() => {
          const picked = pickFeatured(matches);
          return picked ? (matches.find((match) => match.id === picked.id) ?? null) : null;
        })();

  const draftRow = featuredMatch ? await deps.drafts.byMatch(featuredMatch.id) : null;
  const draftState = draftRow ? await deps.drafts.state(draftRow) : null;
  const draftActive = draftState !== null && !draftState.view.done && (draftRow?.armedAt !== null || draftState.choices.length > 0);

  const requested: CastSceneRequest = pinned ?? (own && isCastSceneRequest(own.scene) ? own.scene : 'auto');
  const scene = resolveScene(requested, {
    tournamentState: tournament.state,
    featured: featuredMatch ? { live: featuredMatch.liveAt !== null, draftActive } : null,
  });

  const box = (match: MatchRow): CastBox => ({
    id: match.id,
    a: nameOf(match.entrantAId),
    b: nameOf(match.entrantBId),
    winner: match.winnerEntrantId === null ? null : match.winnerEntrantId === match.entrantAId ? 'a' : 'b',
    scoreA: match.scoreA,
    scoreB: match.scoreB,
    state: match.state,
    live: match.liveAt !== null && match.winnerEntrantId === null,
  });
  const columns = (bracket: 'upper' | 'lower'): CastBox[][] => {
    const rounds = bracket === 'upper' ? upperRounds : lowerRounds;
    return Array.from({ length: rounds }, (_, index) =>
      matches.filter((match) => match.bracket === bracket && match.round === index + 1 && match.state !== 'void').map(box),
    );
  };
  const grand = matches.find((match) => match.bracket === 'grand');

  let featured: CastPayload['featured'] = null;
  if (featuredMatch && featuredMatch.entrantAId !== null && featuredMatch.entrantBId !== null) {
    const votes = await deps.predictions.tally(featuredMatch.id);
    const votesOf = (id: number): number => votes.find((row) => row.entrantId === id)?.votes ?? 0;
    const captainA = entrant(featuredMatch.entrantAId)?.captainUserId;
    const captainB = entrant(featuredMatch.entrantBId)?.captainUserId;
    const past = captainA && captainB ? await deps.headToHead(tournament.guildId, captainA, captainB, featuredMatch.id) : null;
    featured = {
      id: featuredMatch.id,
      label: roundLabel(featuredMatch, upperRounds, lowerRounds),
      a: { name: nameOf(featuredMatch.entrantAId) ?? '?', seed: entrant(featuredMatch.entrantAId)?.seed ?? null, score: featuredMatch.scoreA },
      b: { name: nameOf(featuredMatch.entrantBId) ?? '?', seed: entrant(featuredMatch.entrantBId)?.seed ?? null, score: featuredMatch.scoreB },
      state: featuredMatch.state,
      live: featuredMatch.liveAt !== null,
      votes: { a: votesOf(featuredMatch.entrantAId), b: votesOf(featuredMatch.entrantBId) },
      history: past && past.games > 0 ? past : null,
    };
  }

  let draft: CastPayload['draft'] = null;
  if (draftRow && draftState) {
    const option = (id: string | null, kind: 'ban' | 'pick'): CastPick | null => {
      if (id === null) return null;
      const found = draftRow.pool.find((candidate) => candidate.id === id);
      if (!found) return null;
      const image = kind === 'pick' ? (found.imageUrl ?? found.iconUrl) : (found.iconUrl ?? found.imageUrl);
      return { label: found.label, imageUrl: image ?? null };
    };
    const of = (side: 'a' | 'b', kind: 'ban' | 'pick'): CastPick[] =>
      draftState.choices
        .filter((choice) => choice.side === side && choice.kind === kind)
        .map((choice) => option(choice.optionId, kind))
        .filter((pick): pick is CastPick => pick !== null);
    draft = {
      bans: { a: of('a', 'ban'), b: of('b', 'ban') },
      picks: { a: of('a', 'pick'), b: of('b', 'pick') },
      current: draftState.view.current ? { side: draftState.view.current.side, kind: draftState.view.current.kind } : null,
      deadlineAt: draftState.view.done ? null : (draftRow.deadlineAt?.toISOString() ?? null),
      armed: draftRow.armedAt !== null,
      done: draftState.view.done,
    };
  }

  let podium: CastPayload['podium'] = null;
  if (tournament.state === 'finished') {
    const places = standingsOf(matches);
    podium = { first: nameOf(places.championId), second: nameOf(places.runnerUpId), third: nameOf(places.thirdId) };
  }

  const countdown = own?.countdownAt ?? tournament.registrationClosesAt;
  return {
    now: new Date().toISOString(),
    tournament: {
      id: tournament.id,
      name: tournament.name,
      game: tournament.game,
      gameLabel: TOURNAMENT_GAME_LABELS[tournament.game] ?? tournament.game,
      state: tournament.state,
      accent: GAME_IDENTITY[tournament.game]?.accent ?? '#3fd4e8',
    },
    scene,
    requested,
    countdownAt: countdown ? countdown.toISOString() : null,
    entrants: entrants
      .filter((row) => row.withdrawnAt === null)
      .map((row) => ({ name: row.displayName, checkedIn: row.checkedInAt !== null })),
    bracket: { upper: columns('upper'), lower: columns('lower'), grand: grand ? box(grand) : null },
    featured,
    draft,
    podium,
  };
}

export function registerCastRoutes(server: FastifyInstance, deps: CastRoutesDeps): void {
  const drafts = createDraftsService({ db: deps.db, cache: deps.cache, logger: deps.logger });
  // Только расклад голосов: начислений отсюда не бывает.
  const predictions = createPredictionsService({ db: deps.db, grantCoins: async () => {} });
  const states = createCastStateService(deps.db);
  // Только чтение: личные встречи для табло.
  const matches = createTournamentsService({ db: deps.db });
  const grants = createGrantsService({ db: deps.db });

  const tournamentOf = async (id: number) => {
    const [row] = await deps.db.select().from(tournaments).where(eq(tournaments.id, id));
    return row ?? null;
  };

  server.get<{ Params: { id: string } }>('/cast/t/:id', async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    const tournament = Number.isInteger(id) ? await tournamentOf(id) : null;
    if (!tournament) return reply.code(404).type('text/plain; charset=utf-8').send('Такого турнира нет.');
    return reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(castPage({ tournamentId: tournament.id, title: tournament.name }));
  });

  server.get<{ Params: { id: string }; Querystring: { scene?: string } }>('/api/cast/:id', async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    const tournament = Number.isInteger(id) ? await tournamentOf(id) : null;
    if (!tournament) return reply.code(404).send({ error: 'Такого турнира нет.' });
    const pinned = isCastSceneRequest(request.query.scene) ? request.query.scene : undefined;
    const payload = await buildCastPayload(
      { db: deps.db, drafts, predictions, headToHead: matches.headToHead },
      id,
      await states.get(tournament.guildId),
      pinned,
    );
    return reply.header('cache-control', 'no-store').send(payload);
  });

  /**
   * Турнир пульта: идущий или в регистрации, а если таких нет — последний. Пульт показывают и
   * после финала: пьедестал — тоже сцена.
   */
  async function current(guildId: string) {
    const rows = await deps.db
      .select()
      .from(tournaments)
      .where(eq(tournaments.guildId, guildId))
      .orderBy(desc(tournaments.id))
      .limit(10);
    return rows.find((row) => row.state === 'running' || row.state === 'registration') ?? rows[0] ?? null;
  }

  server.get<{ Params: { token: string } }>('/cast/control/:token', async (request, reply) => {
    const grant = await grants.owner(request.params.token, 'cast');
    if (!grant) {
      return reply
        .code(403)
        .header('cache-control', 'no-store')
        .type('text/plain; charset=utf-8')
        .send('Ссылка на пульт не действует. Попроси новую командой /cast в Discord.');
    }
    const tournament = await current(grant.guildId);
    return reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(castControlPage({ token: grant.token, tournamentId: tournament?.id ?? null, title: tournament?.name ?? 'Турнира нет' }));
  });

  server.post<{
    Params: { token: string };
    Body: { scene?: unknown; featuredMatchId?: unknown; countdownMinutes?: unknown };
  }>('/api/cast/:token', async (request, reply) => {
    const grant = await grants.owner(request.params.token, 'cast');
    if (!grant) return reply.code(403).send({ error: 'Ссылка на пульт не действует — попроси новую командой /cast.' });
    const tournament = await current(grant.guildId);
    if (!tournament) return reply.code(409).send({ error: 'На сервере нет турнира — показывать нечего.' });

    const body = request.body ?? {};
    if (body.scene !== undefined && !isCastSceneRequest(body.scene)) {
      return reply.code(400).send({ error: 'Такой сцены нет.' });
    }
    const featured = body.featuredMatchId === null ? null : Number(body.featuredMatchId);
    const minutes = Number(body.countdownMinutes);

    await states.set(
      grant.guildId,
      {
        tournamentId: tournament.id,
        ...(body.scene !== undefined ? { scene: body.scene as CastSceneRequest } : {}),
        ...(body.featuredMatchId !== undefined ? { featuredMatchId: Number.isInteger(featured) ? featured : null } : {}),
        ...(body.countdownMinutes !== undefined
          ? { countdownAt: Number.isFinite(minutes) && minutes > 0 ? new Date(Date.now() + Math.min(minutes, 180) * 60_000) : null }
          : {}),
      },
      grant.userId,
    );
    // Сцена открыта в чужом браузере — сообщаем ей тем же живым потоком, что и о матчах.
    await deps.bus?.emit('cast.changed', { guildId: grant.guildId, tournamentId: tournament.id }).catch(() => undefined);

    const payload = await buildCastPayload({ db: deps.db, drafts, predictions, headToHead: matches.headToHead }, tournament.id, await states.get(grant.guildId));
    return reply.header('cache-control', 'no-store').send(payload);
  });
}
