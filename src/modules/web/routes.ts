import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Cache } from '../../core/cache.js';
import type { Database } from '../../core/db/client.js';
import type { Logger } from '../../core/logger.js';
import { verificationPossible } from '../identity/providers/provider.js';
import { playerPages } from '../identity/schema.js';
import { ACHIEVEMENTS } from '../progression/rules.js';
import { achievements } from '../progression/schema.js';
import { rankScore } from '../identity/ranks/compare.js';
import type { ProviderId, RankScale, RankSource } from '../identity/schema.js';
import { TOURNAMENT_GAMES } from '../tournaments/games.js';
import {
  matchDrafts,
  tournamentEntrants,
  tournamentMatches,
  tournaments,
  type TournamentGame,
} from '../tournaments/schema.js';
import { TITLE_BONUS } from '../tournaments/placements.js';
import { createCircuitService } from '../tournaments/services/circuit.js';
import { finishedTournaments, playerRecord, titlesByTeam } from '../tournaments/services/records.js';
import {
  page,
  renderBracket,
  renderHall,
  renderLeaderboard,
  renderNotFound,
  renderPlayer,
  renderSeason,
  renderTournamentList,
  type LeaderboardEntry,
  type PlayerView,
} from './render.js';
import { RULES_STYLE, renderRules } from './rules.js';

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
  genshin: 'enka',
};

/**
 * Медленные страницы: лидерборд и зал славы. Ранги обновляются раз в полчаса, зал славы
 * меняется после турнира — минута свежести и десять минут «отдай устаревшее, обнови в
 * фоне» здесь ровно то, что нужно.
 */
const PAGE_TTL_MS = 60 * 1_000;

/** Название игры для строки ранга на карточке игрока. */
const PROVIDER_GAMES: Record<ProviderId, string> = {
  steam: 'Dota 2',
  'riot-lol': 'League of Legends',
  'riot-tft': 'Teamfight Tactics',
  'riot-valorant': 'Valorant',
  enka: 'Genshin Impact',
};

/** Провайдеры, у которых привязку подтвердить нечем: их ранг показывается с пометкой. */
const UNVERIFIABLE = (Object.keys(PROVIDER_GAMES) as ProviderId[]).filter((provider) => !verificationPossible(provider));
const PAGE_STALE_MS = 10 * 60 * 1_000;

/**
 * Страницы события — список турниров и сетка. Им та же стратегия противопоказана, и это
 * выяснилось на живом турнире: капитан отметил состав, а страница показывала прежний
 * статус. Причём не только минуту: `swr` отдаёт устаревшее сразу и обновляет в фоне, так
 * что первая перезагрузка после минуты снова показывала старое, и лишь следующая — новое.
 * Для страницы, которая обещает «обновляется по ходу вечера», это выглядит поломкой.
 *
 * Поэтому здесь короткая свежесть и **нет** окна устаревания: как только пять секунд
 * прошли, страница собирается заново под локом. Толпу, пришедшую по ссылке из объявления,
 * лок держит по-прежнему — а он и был единственной причиной кэшировать эти страницы.
 * Цена решения: если Postgres на секунду отвалится, вместо устаревшей страницы будет
 * ошибка. Для страницы события это честнее: устаревшая сетка хуже отсутствующей, потому
 * что по ней принимают решения.
 */
const LIVE_TTL_MS = 5_000;

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
  const circuit = createCircuitService({ db });

  /** Отдаёт готовый HTML из кэша, а если его нет — строит и кладёт. */
  async function cached(
    key: string,
    build: () => Promise<string>,
    ttlMs = PAGE_TTL_MS,
    staleMs = PAGE_STALE_MS,
  ): Promise<string> {
    const result = await cache.swr(key, { ttlMs, staleMs, load: build });
    return result.value;
  }

  /** Страница события: короткая свежесть, без окна устаревания. */
  const cachedLive = (key: string, build: () => Promise<string>): Promise<string> =>
    cached(key, build, LIVE_TTL_MS, LIVE_TTL_MS);

  server.get('/', async (_request, reply) => {
    const html = await cachedLive('web:index', async () => {
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

  /**
   * Правила: единственная страница, которая не зависит от данных, — поэтому кэшируется
   * надолго и собирается один раз. Меняется она вместе с кодом, а не с турниром.
   */
  server.get('/rules', async (_request, reply) => {
    const html = await cached('web:rules', async () =>
      page('Правила', renderRules(), { head: `<style>${RULES_STYLE}</style>`, current: '/rules' }),
    );
    return reply.type('text/html; charset=utf-8').send(html);
  });

  server.get('/hall', async (_request, reply) => {
    const html = await cached('web:hall', async () => {
      const [finished, titles, seasons] = await Promise.all([
        finishedTournaments(db, deps.guildId, HALL_LIMIT),
        titlesByTeam(db, deps.guildId, TITLES_LIMIT),
        circuit.champions(deps.guildId),
      ]);
      return page(
        'Зал славы',
        renderHall(
          finished,
          titles,
          seasons.map((row) => ({ name: row.name, champion: row.championName, closedAt: row.closedAt })),
        ),
        { current: '/hall' },
      );
    });

    return reply.type('text/html; charset=utf-8').send(html);
  });

  /**
   * Таблица сезонной серии. Та же короткая свежесть, что у страницы события: очки меняются в
   * момент финала турнира, и таблица, отстающая на минуту, выглядит сломанной.
   */
  server.get('/season', async (_request, reply) => {
    const html = await cachedLive('web:season', async () => {
      const season = await circuit.open(deps.guildId);
      const table = season ? await circuit.standings(season.id, 50) : [];
      return page(
        season ? `Сезон «${season.name}»` : 'Сезон',
        renderSeason({ season, table, bonus: TITLE_BONUS }),
        { current: '/season', description: 'Сезонная серия турниров сервера: таблица очков.' },
      );
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  server.get<{ Params: { id: string } }>('/t/:id', async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(404).type('text/html; charset=utf-8').send(page('Не найдено', renderNotFound('Такого турнира нет.')));
    }

    const html = await cachedLive(`web:tournament:${id}`, async () => {
      const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, id));
      if (!tournament) return '';

      const [entrants, matches, drafts] = await Promise.all([
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
        db.select({ matchId: matchDrafts.matchId }).from(matchDrafts).where(eq(matchDrafts.tournamentId, id)),
      ]);

      // Дисциплина турнира задаёт акцент и полосу арта: страница выглядит той игрой, о
      // которой она.
      return page(
        tournament.name,
        renderBracket({ tournament, entrants, matches, drafts: new Set(drafts.map((row) => row.matchId)) }),
        {
          game: tournament.game,
          // Слушать имеет смысл, пока турнир не закрыт: у закрытого меняться нечему.
          ...(tournament.state === 'registration' || tournament.state === 'running' ? { live: tournament.id } : {}),
        },
      );
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
      // Подтверждение требуем там, где оно возможно: неподтверждённая привязка может быть
      // чужой. Но у Valorant подтвердить нечем в принципе, и требовать его значило бы
      // держать таблицу этой игры навсегда пустой. Такие ранги показываются с пометкой
      // «заявлено»: честнее показать заявленное и назвать это заявленным, чем не показать
      // ничего и выглядеть сломанным.
      const result = await db.execute<LeaderboardRow>(sql`
        select distinct on (a.id, s.mode)
          a.display_name, s.mode, s.scale, s.tier, s.division, s.points, s.source
        from game_accounts a
        join rank_snapshots s on s.account_id = a.id
        where a.provider = ${provider}
          ${verificationPossible(provider) ? sql`and a.verified_at is not null` : sql``}
        order by a.id, s.mode, s.captured_at desc
      `);

      const entries: LeaderboardEntry[] = result.rows
        .filter((row) => row.tier !== null)
        .map((row) => ({
          displayName: row.display_name,
          mode: row.mode,
          scale: row.scale,
          tier: row.tier,
          division: row.division,
          points: row.points,
          // Ранг, введённый руками, помечается как заявленный: смешивать его с
          // подтверждённым молча значит выдавать чужое утверждение за проверенный факт.
          claimed: row.source === 'manual',
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

      return page(`Лидерборд ${game}`, renderLeaderboard(game, entries), {
        game,
        current: `/leaderboard/${game}`,
      });
    });

    return reply.type('text/html; charset=utf-8').send(html);
  });

  /**
   * Карточка игрока. Связка «этот Discord — этот человек в турнирах и в игре» — личные данные,
   * поэтому страница есть только у того, кто открыл её сам (`/card on`).
   *
   * Согласие проверяется на каждый запрос, мимо кэша: `/card off` должен закрывать страницу
   * сразу, а не когда истечёт кэш. В ключ кэша входит время последней правки настроек — так
   * смена «показывать аккаунты» не отдаёт старую версию страницы даже из фона `swr`.
   */
  server.get<{ Params: { userId: string } }>('/p/:userId', async (request, reply) => {
    const userId = request.params.userId;
    const hidden = () =>
      reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(
          page(
            'Профиль скрыт',
            renderNotFound(
              'Этот игрок свою страницу не открывал. Связка Discord-аккаунта с игровым — личные данные, поэтому страница появляется, только когда игрок сам включит её командой /card on.',
            ),
          ),
        );
    if (!/^\d{17,20}$/.test(userId)) return hidden();

    const [consent] = await db
      .select()
      .from(playerPages)
      .where(and(eq(playerPages.guildId, deps.guildId), eq(playerPages.userId, userId)));
    if (!consent) return hidden();

    const html = await cached(`web:player:${userId}:${consent.updatedAt.getTime()}`, async () => {
      const [record, season, earned, ranks] = await Promise.all([
        playerRecord(db, deps.guildId, userId),
        circuit.open(deps.guildId),
        db
          .select({ code: achievements.code, earnedAt: achievements.earnedAt })
          .from(achievements)
          .where(and(eq(achievements.guildId, deps.guildId), eq(achievements.userId, userId)))
          .orderBy(desc(achievements.earnedAt)),
        consent.showRanks ? playerRanks(userId) : Promise.resolve(null),
      ]);
      const table = season ? await circuit.standings(season.id, 1_000) : [];
      const place = table.findIndex((row) => row.userId === userId);

      return page(
        consent.displayName,
        renderPlayer({
          name: consent.displayName,
          record,
          season: season && place >= 0 ? { name: season.name, place: place + 1, points: table[place]?.points ?? 0 } : null,
          achievements: earned.flatMap((row) => {
            const def = ACHIEVEMENTS.find((item) => item.code === row.code);
            return def ? [{ title: def.title, description: def.description, earnedAt: row.earnedAt }] : [];
          }),
          ranks,
          showAccounts: consent.showAccounts,
        }),
        {
          description: `Карточка игрока ${consent.displayName}: турниры, титулы, сезон.`,
          // Страницу открыл игрок, но искать его по имени через поисковик — не то, на что он соглашался.
          head: '<meta name="robots" content="noindex">',
        },
      );
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  /** Последний ранг по каждому аккаунту и режиму — по тем же правилам, что в лидерборде. */
  async function playerRanks(userId: string): Promise<PlayerView['ranks']> {
    const result = await db.execute<LeaderboardRow & { provider: ProviderId }>(sql`
      select distinct on (a.id, s.mode)
        a.provider, a.display_name, s.mode, s.scale, s.tier, s.division, s.points, s.source
      from game_accounts a
      join rank_snapshots s on s.account_id = a.id
      where a.user_id = ${userId}
        and (a.verified_at is not null or a.provider in (${sql.join(
          UNVERIFIABLE.map((provider) => sql`${provider}`),
          sql`, `,
        )}))
      order by a.id, s.mode, s.captured_at desc
    `);
    return result.rows
      .filter((row) => row.tier !== null)
      .map((row) => ({
        game: PROVIDER_GAMES[row.provider] ?? row.provider,
        displayName: row.display_name,
        mode: row.mode,
        scale: row.scale,
        tier: row.tier,
        division: row.division,
        points: row.points,
        claimed: row.source === 'manual',
        score: 0,
      }));
  }
}
