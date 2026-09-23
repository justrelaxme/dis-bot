import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Cache } from '../../../src/core/cache.js';
import { loadConfig } from '../../../src/core/config.js';
import { createLogger } from '../../../src/core/logger.js';
import { createTournamentsService } from '../../../src/modules/tournaments/services/tournaments.js';
import { createCastStateService, registerCastRoutes, type CastPayload } from '../../../src/modules/web/cast.js';
import { createGrantsService } from '../../../src/modules/web/grants.js';
import { withPostgres } from '../../helpers/postgres.js';
import { withRedis } from '../../helpers/redis.js';

const pg = withPostgres();
const redis = withRedis();

/**
 * Сцены трансляции через HTTP: данные для сцены открыты всем (это та же сетка, что на сайте),
 * а переключать сцены можно только по пропуску `cast`.
 */

const GUILD = '800000000000000001';
let server: FastifyInstance;
let cache: Cache;
let tournamentId = 0;
let matchIds: number[] = [];

beforeAll(async () => {
  const config = loadConfig({
    DISCORD_TOKEN: 'test',
    DISCORD_APP_ID: '123456789012345678',
    DISCORD_GUILD_ID: '876543210987654321',
    DATABASE_URL: 'postgres://localhost:5432/x',
    REDIS_URL: redis.url,
    PUBLIC_BASE_URL: 'https://test.example.com',
    NODE_ENV: 'test',
  });
  const logger = createLogger({ ...config, LOG_LEVEL: 'fatal' });
  cache = new Cache(config, logger);
  server = Fastify();
  registerCastRoutes(server, { db: pg.db, cache, logger });
  await server.ready();

  const service = createTournamentsService({ db: pg.db });
  const tournament = await service.create({
    guildId: GUILD,
    name: 'Эфирный кубок',
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
    const user = `81000000000000000${index}`;
    ids.push((await service.createEntrant(tournament.id, user, `Игрок ${index + 1}`)).id);
    await service.checkIn(tournament.id, user);
  }
  const view = await service.start(tournament.id, new Map(ids.map((id, index) => [id, 100 - index])));
  tournamentId = tournament.id;
  matchIds = view.matches.filter((row) => row.round === 1).map((row) => row.id);
  await service.startMatch(matchIds[1]!);
});

afterAll(async () => {
  await server.close();
  await cache.close();
});

describe('сцена трансляции', () => {
  it('страница сцены открыта всем и не кэшируется', async () => {
    const response = await server.inject({ method: 'GET', url: `/cast/t/${tournamentId}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toContain(`data-tournament="${tournamentId}"`);
  });

  it('данные сцены: идущий матч — главный, сцена — табло', async () => {
    const response = await server.inject({ method: 'GET', url: `/api/cast/${tournamentId}` });
    const payload = response.json<CastPayload>();

    expect(payload.featured?.id).toBe(matchIds[1]);
    expect(payload.scene).toBe('match');
    expect(payload.bracket.upper).toHaveLength(2);
  });

  it('сцена, закреплённая в адресе, — поверх автоматической', async () => {
    const response = await server.inject({ method: 'GET', url: `/api/cast/${tournamentId}?scene=bracket` });

    expect(response.json<CastPayload>().scene).toBe('bracket');
  });

  it('несуществующий турнир — 404', async () => {
    expect((await server.inject({ method: 'GET', url: '/api/cast/999999' })).statusCode).toBe(404);
  });
});

describe('пульт', () => {
  it('без пропуска переключать нельзя', async () => {
    const response = await server.inject({ method: 'POST', url: '/api/cast/чужой', payload: { scene: 'bracket' } });

    expect(response.statusCode).toBe(403);
  });

  it('пропуск формата не открывает пульт', async () => {
    const grants = createGrantsService({ db: pg.db });
    const grant = await grants.issue({ guildId: GUILD, userId: '810000000000000009', scope: 'formats' });

    const response = await server.inject({ method: 'POST', url: `/api/cast/${grant.token}`, payload: { scene: 'bracket' } });

    expect(response.statusCode).toBe(403);
  });

  it('по пропуску: сцена и главный матч переключаются и запоминаются', async () => {
    const grants = createGrantsService({ db: pg.db });
    const grant = await grants.issue({ guildId: GUILD, userId: '810000000000000010', scope: 'cast' });

    const switched = await server.inject({
      method: 'POST',
      url: `/api/cast/${grant.token}`,
      payload: { scene: 'bracket', featuredMatchId: matchIds[0] },
    });
    expect(switched.statusCode).toBe(200);

    const payload = (await server.inject({ method: 'GET', url: `/api/cast/${tournamentId}` })).json<CastPayload>();
    expect(payload.requested).toBe('bracket');
    expect(payload.featured?.id).toBe(matchIds[0]);
  });

  it('доигранный матч кастера отпускает табло: сцена возвращается к автоматике', async () => {
    const grants = createGrantsService({ db: pg.db });
    const grant = await grants.issue({ guildId: GUILD, userId: '810000000000000012', scope: 'cast' });
    await server.inject({ method: 'POST', url: `/api/cast/${grant.token}`, payload: { scene: 'auto', featuredMatchId: matchIds[1] } });
    expect((await server.inject({ method: 'GET', url: `/api/cast/${tournamentId}` })).json<CastPayload>().featured?.id).toBe(matchIds[1]);

    const service = createTournamentsService({ db: pg.db });
    const match = (await service.bracket(tournamentId)).matches.find((row) => row.id === matchIds[1])!;
    await service.resolve(match.id, 'organizer', match.entrantAId!);

    const payload = (await server.inject({ method: 'GET', url: `/api/cast/${tournamentId}` })).json<CastPayload>();
    expect(payload.featured?.id).not.toBe(matchIds[1]);
    expect(payload.featured?.live ?? false).toBe(false);
  });

  it('выбор пульта не переезжает на новый турнир: отсчёт, сцена и матч сбрасываются', async () => {
    const states = createCastStateService(pg.db);
    await states.set('800000000000000077', { tournamentId: 1, scene: 'soon', featuredMatchId: 5, countdownAt: new Date('2026-09-20T18:00:00Z') }, 'кастер');

    const next = await states.set('800000000000000077', { tournamentId: 2, featuredMatchId: 9 }, 'кастер');
    expect(next).toMatchObject({ tournamentId: 2, scene: 'auto', featuredMatchId: 9, countdownAt: null });

    // Тот же турнир — выбор сохраняется.
    await states.set('800000000000000077', { tournamentId: 2, scene: 'bracket' }, 'кастер');
    const same = await states.set('800000000000000077', { tournamentId: 2, countdownAt: new Date('2026-09-27T18:00:00Z') }, 'кастер');
    expect(same).toMatchObject({ scene: 'bracket', featuredMatchId: 9 });
  });

  it('неизвестная сцена — отказ, а не молчаливое «сама»', async () => {
    const grants = createGrantsService({ db: pg.db });
    const grant = await grants.issue({ guildId: GUILD, userId: '810000000000000011', scope: 'cast' });

    const response = await server.inject({ method: 'POST', url: `/api/cast/${grant.token}`, payload: { scene: 'пляж' } });

    expect(response.statusCode).toBe(400);
  });
});
