import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { createLogger } from '../../../src/core/logger.js';
import { createLinkingService } from '../../../src/modules/identity/services/linking.js';
import { createRostersService } from '../../../src/modules/tournaments/services/rosters.js';
import { createTournamentsService } from '../../../src/modules/tournaments/services/tournaments.js';
import { createGrantsService } from '../../../src/modules/web/grants.js';
import { registerRosterRoutes, type OwnedForRoster } from '../../../src/modules/web/roster.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

/**
 * Заявка состава целиком: страница и сохранение. Проверяется запросами, а не вызовами сервиса,
 * потому что здесь важна именно граница — что отвечает сервер, когда турнира нет, привязки нет
 * или Летопись закрыта. Ни одну из этих ошибок не видно, если звать сервис напрямую.
 */

let server: FastifyInstance;
let counter = 0;

/** Состав аккаунта-заглушки: одна дорогая, одна бесплатная, одна стандартная. */
const OWNED: OwnedForRoster[] = [
  {
    id: '10000046',
    name: 'Ху Тао',
    rarity: 5,
    constellation: 1,
    weapon: { name: 'Нефритовый секач', rarity: 5, refinement: 1 },
    sets: [{ name: 'Багровая ведьма пламени', pieces: 4 }],
  },
  { id: '10000031', name: 'Фишль', rarity: 4, constellation: 6, sets: [] },
  { id: '10000003', name: 'Джинн', rarity: 5, constellation: 0, sets: [] },
];

/** Чем ответит Летопись. Меняется тестами, чтобы проверить и закрытую, и ненастроенную. */
let chronicleAnswer: { ok: true; characters: readonly OwnedForRoster[] } | { ok: false; reason: 'private' } = {
  ok: true,
  characters: OWNED,
};
let chronicleConfigured = true;

beforeAll(async () => {
  server = Fastify();
  registerRosterRoutes(server, {
    db: pg.db,
    logger,
    chronicle: {
      get configured(): boolean {
        return chronicleConfigured;
      },
      roster: async () => chronicleAnswer,
    },
  });
  await server.ready();
});

afterAll(async () => {
  await server.close();
  chronicleConfigured = true;
});

interface Ready {
  token: string;
  guildId: string;
  userId: string;
  tournamentId: number;
}

/** Турнир по Genshin, подтверждённая привязка и пропуск — всё, что нужно до заявки. */
async function ready(options: { game?: 'genshin' | 'dota2'; cap?: number | null; linked?: boolean } = {}): Promise<Ready> {
  counter += 1;
  const pad = String(counter).padStart(4, '0');
  const guildId = `76000000000000${pad}`;
  const userId = `77000000000000${pad}`;

  const tournaments = createTournamentsService({ db: pg.db });
  const tournament = await tournaments.create({
    guildId,
    name: 'Бездна',
    game: options.game ?? 'genshin',
    format: 'single-elim',
    entryMode: 'solo',
    teamSize: 1,
    maxEntrants: 8,
    seeding: 'rank',
    bestOf: 1,
    requireVerified: false,
    createdBy: userId,
    ...(options.cap === undefined || options.cap === null ? {} : { costCap: options.cap }),
  });
  await tournaments.openRegistration(tournament.id, new Date(Date.now() + 3_600_000));

  if (options.linked !== false) {
    const linking = createLinkingService({ db: pg.db });
    await linking.ensureUser(userId);
    await linking.linkAccount(
      userId,
      'enka',
      { externalId: `7${pad}00000`, displayName: 'Игрок', verificationMethod: 'genshin-signature' },
      true,
    );
  }

  const grants = createGrantsService({ db: pg.db });
  const issued = await grants.issue({ guildId, userId, scope: 'roster' });
  return { token: issued.token, guildId, userId, tournamentId: tournament.id };
}

describe('страница заявки', () => {
  it('показывает только персонажей аккаунта, с ценой каждого', async () => {
    const me = await ready();

    const response = await server.inject({ method: 'GET', url: `/roster/${me.token}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Ху Тао');
    expect(response.body).toContain('Нефритовый секач R1');
    expect(response.body).toContain('4× Багровая ведьма пламени');
    // C1 лимитированной — 2 очка, её сигнатурка R1 — ещё 1.
    expect(response.body).toContain('data-cost="3"');
    // Четырёхзвёздочная бесплатна.
    expect(response.body).toContain('data-cost="0"');
  });

  it('говорит потолок турнира, а не умалчивает о нём', async () => {
    const me = await ready({ cap: 6 });

    const response = await server.inject({ method: 'GET', url: `/roster/${me.token}` });

    expect(response.body).toContain('6');
    expect(response.body).toContain('Заявить состав');
  });

  /** Страница персональная и содержит действующий пропуск. */
  it('не кэшируется', async () => {
    const me = await ready();

    const response = await server.inject({ method: 'GET', url: `/roster/${me.token}` });

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('по чужой ссылке не открывается', async () => {
    const response = await server.inject({ method: 'GET', url: '/roster/выдуманный' });

    expect(response.statusCode).toBe(403);
  });

  /** Каждое препятствие — своё объяснение: человеку важно знать, что именно чинить. */
  it('без турнира объясняет, что заявлять некуда', async () => {
    const me = await ready();
    const tournaments = createTournamentsService({ db: pg.db });
    await tournaments.cancel(me.tournamentId);

    const response = await server.inject({ method: 'GET', url: `/roster/${me.token}` });

    expect(response.body).toContain('нет идущего турнира');
  });

  it('у турнира не по Genshin объясняет почему', async () => {
    const me = await ready({ game: 'dota2' });

    const response = await server.inject({ method: 'GET', url: `/roster/${me.token}` });

    expect(response.body).toContain('не по Genshin');
  });

  it('без подтверждённой привязки зовёт её сделать', async () => {
    const me = await ready({ linked: false });

    const response = await server.inject({ method: 'GET', url: `/roster/${me.token}` });

    expect(response.body).toContain('/link genshin');
  });

  it('при закрытой Летописи говорит, что открыть', async () => {
    const me = await ready();
    chronicleAnswer = { ok: false, reason: 'private' };

    const response = await server.inject({ method: 'GET', url: `/roster/${me.token}` });
    chronicleAnswer = { ok: true, characters: OWNED };

    expect(response.body).toContain('HoYoLAB');
  });

  it('без ключа бота говорит, что читать состав нечем', async () => {
    const me = await ready();
    chronicleConfigured = false;

    const response = await server.inject({ method: 'GET', url: `/roster/${me.token}` });
    chronicleConfigured = true;

    expect(response.body).toContain('не настроено');
  });
});

describe('сохранение заявки', () => {
  it('сохраняет и отвечает суммой', async () => {
    const me = await ready({ cap: 6 });

    const response = await server.inject({
      method: 'POST',
      url: `/api/roster/${me.token}`,
      payload: { characterIds: ['10000046', '10000031'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ count: 2, spent: 3 });

    const rosters = createRostersService({ db: pg.db });
    const saved = await rosters.byPlayer(me.tournamentId, me.userId);
    expect(saved?.spent).toBe(3);
    expect(saved?.characters.map((character) => character.name)).toEqual(['Ху Тао', 'Фишль']);
  });

  /**
   * Потолок — правило, а не подсказка страницы: заявка, пришедшая мимо неё, обязана упереться
   * в тот же предел.
   */
  it('заявку дороже потолка не принимает и называет разницу', async () => {
    const me = await ready({ cap: 1 });

    const response = await server.inject({
      method: 'POST',
      url: `/api/roster/${me.token}`,
      payload: { characterIds: ['10000046'] },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/дороже потолка/);
  });

  it('чужого персонажа не принимает', async () => {
    const me = await ready();

    const response = await server.inject({
      method: 'POST',
      url: `/api/roster/${me.token}`,
      payload: { characterIds: ['10000999'] },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/нет на аккаунте/);
  });

  /** Игрок передумал, а не пришёл вторым составом. */
  it('повторное сохранение правит заявку, а не заводит вторую', async () => {
    const me = await ready();

    await server.inject({
      method: 'POST',
      url: `/api/roster/${me.token}`,
      payload: { characterIds: ['10000046'] },
    });
    await server.inject({
      method: 'POST',
      url: `/api/roster/${me.token}`,
      payload: { characterIds: ['10000031'] },
    });

    const rosters = createRostersService({ db: pg.db });
    expect(await rosters.byTournament(me.tournamentId)).toHaveLength(1);
    expect((await rosters.byPlayer(me.tournamentId, me.userId))?.spent).toBe(0);
  });

  it('открытая заявка возвращается на страницу выбранной', async () => {
    const me = await ready();
    await server.inject({
      method: 'POST',
      url: `/api/roster/${me.token}`,
      payload: { characterIds: ['10000031'] },
    });

    const response = await server.inject({ method: 'GET', url: `/roster/${me.token}` });

    expect(response.body).toContain('Состав уже заявлен');
    expect(response.body).toContain('data-id="10000031" data-cost="0" data-free="1" aria-pressed="true"');
  });

  it('мусор вместо списка не принимает', async () => {
    const me = await ready();

    const response = await server.inject({
      method: 'POST',
      url: `/api/roster/${me.token}`,
      payload: { characterIds: 'Ху Тао' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('без пропуска не сохраняет', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/roster/выдуманный',
      payload: { characterIds: ['10000031'] },
    });

    expect(response.statusCode).toBe(403);
  });
});
