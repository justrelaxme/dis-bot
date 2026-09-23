import { and, eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Cache } from '../../../src/core/cache.js';
import { loadConfig } from '../../../src/core/config.js';
import { users } from '../../../src/core/db/schema/core.js';
import { createLogger } from '../../../src/core/logger.js';
import { gameAccounts, playerPages, rankSnapshots } from '../../../src/modules/identity/schema.js';
import { achievements } from '../../../src/modules/progression/schema.js';
import { createCircuitService } from '../../../src/modules/tournaments/services/circuit.js';
import { createTournamentsService } from '../../../src/modules/tournaments/services/tournaments.js';
import { registerWebRoutes } from '../../../src/modules/web/routes.js';
import { withPostgres } from '../../helpers/postgres.js';
import { withRedis } from '../../helpers/redis.js';

const pg = withPostgres();
const redis = withRedis();

/**
 * Карточка игрока по согласию: пока игрок её не открыл — 404, открыл — видна; игровой ник
 * только по отдельному согласию; закрыл — 404 сразу, даже если страница лежит в кэше.
 */

const GUILD = '850000000000000001';
const PLAYER = '851000000000000000';
let server: FastifyInstance;
let cache: Cache;

const get = (userId = PLAYER) => server.inject({ method: 'GET', url: `/p/${userId}` });

async function consent(values: { showAccounts: boolean; showRanks: boolean }): Promise<void> {
  const row = { displayName: 'Первый', ...values, updatedAt: new Date() };
  await pg.db
    .insert(playerPages)
    .values({ guildId: GUILD, userId: PLAYER, ...row })
    .onConflictDoUpdate({ target: [playerPages.guildId, playerPages.userId], set: row });
}

beforeAll(async () => {
  const config = loadConfig({
    DISCORD_TOKEN: 'test',
    DISCORD_APP_ID: '123456789012345678',
    DISCORD_GUILD_ID: GUILD,
    DATABASE_URL: 'postgres://localhost:5432/x',
    REDIS_URL: redis.url,
    PUBLIC_BASE_URL: 'https://test.example.com',
    NODE_ENV: 'test',
  });
  const logger = createLogger({ ...config, LOG_LEVEL: 'fatal' });
  cache = new Cache(config, logger);
  server = Fastify();
  registerWebRoutes(server, { db: pg.db, cache, logger, guildId: GUILD });
  await server.ready();

  // Доигранный турнир на четверых в открытом сезоне; побеждает первый сеяный — наш игрок.
  const circuit = createCircuitService({ db: pg.db });
  await circuit.start(GUILD, 'Осень');
  const service = createTournamentsService({ db: pg.db });
  const tournament = await service.create({
    guildId: GUILD,
    name: 'Кубок недели',
    game: 'dota2',
    format: 'single-elim',
    entryMode: 'solo',
    teamSize: 1,
    maxEntrants: 8,
    seeding: 'rank',
    bestOf: 1,
    requireVerified: false,
    createdBy: 'organizer',
  });
  await service.openRegistration(tournament.id, new Date(Date.now() + 3_600_000));
  const ids: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const user = `85100000000000000${index}`;
    ids.push((await service.createEntrant(tournament.id, user, index === 0 ? 'Первый' : `Игрок ${index + 1}`)).id);
    await service.checkIn(tournament.id, user);
  }
  await service.start(tournament.id, new Map(ids.map((id, index) => [id, 1_000 - index])));
  for (let guard = 0; guard < 10; guard += 1) {
    const view = await service.bracket(tournament.id);
    const next = view.matches.find((match) => match.state === 'ready');
    if (!next) break;
    const seedOf = (id: number): number => view.entrants.find((entrant) => entrant.id === id)?.seed ?? 99;
    const winner = seedOf(next.entrantAId!) <= seedOf(next.entrantBId!) ? next.entrantAId! : next.entrantBId!;
    await service.settle(next.id, winner, 'organizer', 'resolve', true);
  }
  await circuit.award(tournament.id);

  await pg.db.insert(achievements).values({ guildId: GUILD, userId: PLAYER, code: 'champion', seasonId: 1 });
  await pg.db.insert(users).values({ id: PLAYER });
  const [account] = await pg.db
    .insert(gameAccounts)
    .values({
      userId: PLAYER,
      provider: 'steam',
      externalId: '76561198000000001',
      displayName: 'СекретныйНик',
      verifiedAt: new Date(),
      verificationMethod: 'steam-openid',
    })
    .returning();
  await pg.db.insert(rankSnapshots).values({
    accountId: account!.id,
    mode: 'ranked',
    scale: 'dota-mmr',
    tier: 'Legend',
    division: '3',
    points: null,
    source: 'api',
    raw: {},
  });
});

afterAll(async () => {
  await server.close();
  await cache.close();
});

describe('карточка игрока', () => {
  it('пока игрок её не открыл — 404 и ни слова о нём', async () => {
    const response = await get();

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('Первый');
    expect(response.body).toContain('/card on');
  });

  it('открыл — видны титул, сезон, достижения и ранг, но не игровой ник', async () => {
    await consent({ showAccounts: false, showRanks: true });

    const response = await get();

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<h1>Первый</h1>');
    expect(response.body).toContain('Кубок недели');
    expect(response.body).toContain('сезон «Осень» · 9 очков');
    expect(response.body).toContain('#1');
    expect(response.body).toContain('Чемпион');
    expect(response.body).toContain('Legend 3');
    expect(response.body).not.toContain('СекретныйНик');
    // Согласие на страницу — не согласие на поисковики.
    expect(response.body).toContain('noindex');
  });

  it('разрешил показывать аккаунты — ник появляется сразу, без ожидания кэша', async () => {
    await consent({ showAccounts: true, showRanks: true });

    expect((await get()).body).toContain('СекретныйНик');
  });

  it('скрыл ранги — нет ни ранга, ни ника', async () => {
    await consent({ showAccounts: true, showRanks: false });

    const body = (await get()).body;
    expect(body).not.toContain('Legend 3');
    expect(body).not.toContain('СекретныйНик');
  });

  it('закрыл — 404 сразу, хотя страница только что была в кэше', async () => {
    await pg.db.delete(playerPages).where(and(eq(playerPages.guildId, GUILD), eq(playerPages.userId, PLAYER)));

    expect((await get()).statusCode).toBe(404);
  });

  it('не похоже на id Discord — 404', async () => {
    expect((await get('../../etc')).statusCode).toBe(404);
    expect((await get('abc')).statusCode).toBe(404);
  });
});
