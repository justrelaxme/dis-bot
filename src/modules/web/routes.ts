import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Cache } from '../../core/cache.js';
import type { Database } from '../../core/db/client.js';
import type { Logger } from '../../core/logger.js';
import { rankScore } from '../identity/ranks/compare.js';
import type { ProviderId, RankScale, RankSource } from '../identity/schema.js';
import { TOURNAMENT_GAMES } from '../tournaments/games.js';
import {
  tournamentEntrants,
  tournamentMatches,
  tournaments,
  type TournamentGame,
} from '../tournaments/schema.js';
import { finishedTournaments, titlesByTeam } from '../tournaments/services/records.js';
import {
  page,
  renderBracket,
  renderHall,
  renderLeaderboard,
  renderNotFound,
  renderTournamentList,
  type LeaderboardEntry,
} from './render.js';

/**
 * Игра турнира и провайдер данных — разные оси. Здесь единственное место, где они
 * сопоставляются: лидерборд по дисциплине читает ранги того провайдера, который эту
 * дисциплину обслуживает.
 */
const GAME_TO_PROVIDER: Record<TournamentGame, ProviderId> = {
  dota2: 'steam',
  lol: 'riot-lol',
  tft: 'riot-tft',
  valorant: 'riot-valorant',
};

/** Сетка меняется редко, а по ссылке из объявления придут все сразу. */
const PAGE_TTL_MS = 60 * 1_000;
const PAGE_STALE_MS = 10 * 60 * 1_000;

const LEADERBOARD_LIMIT = 100;
const HALL_LIMIT = 50;
const TITLES_LIMIT = 10;

/** `db.execute` требует, чтобы форма строки была совместима с Record<string, unknown>. */
interface LeaderboardRow extends Record<string, unknown> {
  display_name: string;
  mode: string;
  scale: RankScale;
  tier: string | null;
  division: string | null;
  points: number | null;
  source: RankSource;
}

export interface WebRoutesDeps {
  db: Database;
  cache: Cache;
  logger: Logger;
  /**
   * Сервер, чью летопись показываем. Бот живёт на одном сервере (DISCORD_GUILD_ID), но
   * база на это не рассчитана: страницы без фильтра однажды смешали бы два сервера в
   * одну таблицу, и объяснять это пришлось бы уже пользователям.
   */
  guildId: string;
}

function isGame(value: string): value is TournamentGame {
  return (TOURNAMENT_GAMES as readonly string[]).includes(value);
}

export function registerWebRoutes(server: FastifyInstance, deps: WebRoutesDeps): void {
  const { db, cache } = deps;

  /** Отдаёт готовый HTML из кэша, а если его нет — строит и кладёт. */
  async function cached(key: string, build: () => Promise<string>): Promise<string> {
    const result = await cache.swr(key, { ttlMs: PAGE_TTL_MS, staleMs: PAGE_STALE_MS, load: build });
    return result.value;
  }

  server.get('/', async (_request, reply) => {
    const html = await cached('web:index', async () => {
      const rows = await db
        .select({
          tournament: tournaments,
          entrantCount: sql<number>`count(${tournamentEntrants.id})::int`,
        })
        .from(tournaments)
        .leftJoin(
          tournamentEntrants,
          and(eq(tournamentEntrants.tournamentId, tournaments.id), sql`${tournamentEntrants.withdrawnAt} is null`),
        )
        .where(eq(tournaments.guildId, deps.guildId))
        .groupBy(tournaments.id)
        .orderBy(desc(tournaments.id))
        .limit(25);

      return page(
        'Турниры',
        renderTournamentList(rows.map((row) => ({ ...row.tournament, entrantCount: row.entrantCount }))),
      );
    });

    return reply.type('text/html; charset=utf-8').send(html);
  });

  server.get('/hall', async (_request, reply) => {
    const html = await cached('web:hall', async () => {
      const [finished, titles] = await Promise.all([
        finishedTournaments(db, deps.guildId, HALL_LIMIT),
        titlesByTeam(db, deps.guildId, TITLES_LIMIT),
      ]);
      return page('Зал славы', renderHall(finished, titles));
    });

    return reply.type('text/html; charset=utf-8').send(html);
  });

  server.get<{ Params: { id: string } }>('/t/:id', async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(404).type('text/html; charset=utf-8').send(page('Не найдено', renderNotFound('Такого турнира нет.')));
    }

    const html = await cached(`web:tournament:${id}`, async () => {
      const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, id));
      if (!tournament) return '';

      const [entrants, matches] = await Promise.all([
        db
          .select()
          .from(tournamentEntrants)
          .where(eq(tournamentEntrants.tournamentId, id))
          .orderBy(tournamentEntrants.seed, tournamentEntrants.id),
        db
          .select()
          .from(tournamentMatches)
          .where(eq(tournamentMatches.tournamentId, id))
          .orderBy(tournamentMatches.round, tournamentMatches.slot),
      ]);

      return page(tournament.name, renderBracket({ tournament, entrants, matches }));
    });

    if (html === '') {
      return reply.code(404).type('text/html; charset=utf-8').send(page('Не найдено', renderNotFound('Такого турнира нет.')));
    }
    return reply.type('text/html; charset=utf-8').send(html);
  });

  server.get<{ Params: { game: string } }>('/leaderboard/:game', async (request, reply) => {
    const game = request.params.game;
    if (!isGame(game)) {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(page('Не найдено', renderNotFound('Такой дисциплины нет.')));
    }

    const html = await cached(`web:leaderboard:${game}`, async () => {
      const provider = GAME_TO_PROVIDER[game];

      // Последний снимок на каждую пару (аккаунт, режим). DISTINCT ON — ровно тот
      // инструмент, который для этого есть в Postgres; в конструкторе запросов это
      // вышло бы окном с нумерацией и подзапросом, то есть тем же самым, но длиннее.
      // Берём только подтверждённые привязки: неподтверждённая может быть чужой.
      const result = await db.execute<LeaderboardRow>(sql`
        select distinct on (a.id, s.mode)
          a.display_name, s.mode, s.scale, s.tier, s.division, s.points, s.source
        from game_accounts a
        join rank_snapshots s on s.account_id = a.id
        where a.provider = ${provider} and a.verified_at is not null
        order by a.id, s.mode, s.captured_at desc
      `);

      const entries: LeaderboardEntry[] = result.rows
        .filter((row) => row.tier !== null)
        .map((row) => ({
          displayName: row.display_name,
          mode: row.mode,
          tier: row.tier,
          division: row.division,
          points: row.points,
          score: rankScore({
            mode: row.mode,
            scale: row.scale,
            tier: row.tier,
            division: row.division,
            points: row.points,
            source: row.source,
            raw: {},
          }),
        }))
        .sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName, 'ru'))
        .slice(0, LEADERBOARD_LIMIT);

      return page(`Лидерборд ${game}`, renderLeaderboard(game, entries));
    });

    return reply.type('text/html; charset=utf-8').send(html);
  });

  // Заглушка вместо страницы профиля: связка «этот Discord — этот игровой аккаунт»
  // приватна, и публиковать её без согласия игрока нельзя, даже если ранг и так виден
  // в игре. Страница появится, когда будет согласие — отдельным флагом и командой.
  server.get('/p/:userId', async (_request, reply) => {
    return reply
      .code(404)
      .type('text/html; charset=utf-8')
      .send(
        page(
          'Профиль скрыт',
          renderNotFound(
            'Страницы игроков закрыты: связка Discord-аккаунта с игровым — личные данные, и публиковать их без согласия нельзя. Свой профиль можно посмотреть в Discord командой /profile.',
          ),
        ),
      );
  });
}
