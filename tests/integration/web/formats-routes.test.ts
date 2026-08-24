import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { createLogger } from '../../../src/core/logger.js';
import { createFormatsService } from '../../../src/modules/tournaments/services/formats.js';
import { registerFormatRoutes } from '../../../src/modules/web/formats.js';
import { createGrantsService } from '../../../src/modules/web/grants.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

/**
 * Конструктор форматов целиком: страница и три её действия. Проверяется запросами через
 * `inject`, а не вызовами функций — потому что здесь важно именно то, что происходит на
 * границе: как разбирается присланное, что отвечает сервер на чужой токен и на противоречивый
 * набор. Ни одна из этих ошибок не видна, если звать сервис напрямую.
 */

let server: FastifyInstance;
let counter = 0;

const ids = (): { guildId: string; userId: string } => {
  counter += 1;
  const pad = String(counter).padStart(4, '0');
  return { guildId: `74000000000000${pad}`, userId: `75000000000000${pad}` };
};

const bricks = {
  game: 'dota2',
  entryMode: 'team',
  teamSize: 5,
  maxEntrants: 16,
  format: 'single-elim',
  bestOf: 1,
  abilities: true,
  autoTeams: false,
  requireVerified: true,
  registrationHours: 2,
};

beforeAll(async () => {
  server = Fastify();
  registerFormatRoutes(server, { db: pg.db, logger });
  await server.ready();
});

afterAll(async () => {
  await server.close();
});

async function grantFor(): Promise<{ token: string; guildId: string; userId: string }> {
  const who = ids();
  const grants = createGrantsService({ db: pg.db });
  const issued = await grants.issue({ ...who, scope: 'formats' });
  return { token: issued.token, ...who };
}

describe('страница конструктора', () => {
  it('открывается по действующей ссылке', async () => {
    const grant = await grantFor();

    const response = await server.inject({ method: 'GET', url: `/formats/${grant.token}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Форматы турнира');
    expect(response.body).toContain('data-k="game"');
  });

  /** Страница содержит действующий пропуск: кэшировать её нельзя ни здесь, ни у посредника. */
  it('не кэшируется', async () => {
    const grant = await grantFor();

    const response = await server.inject({ method: 'GET', url: `/formats/${grant.token}` });

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('по чужому токену не открывается, но объясняет, что делать', async () => {
    const response = await server.inject({ method: 'GET', url: '/formats/выдуманный' });

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('/tournament formats');
  });

  it('показывает уже сохранённые форматы этого сервера', async () => {
    const grant = await grantFor();
    const formats = createFormatsService({ db: pg.db });
    await formats.save({
      guildId: grant.guildId,
      name: 'Пятничный',
      createdBy: grant.userId,
      bricks: { entryMode: 'team', teamSize: 5, maxEntrants: 8, format: 'double-elim', bestOf: 1 },
    });

    const response = await server.inject({ method: 'GET', url: `/formats/${grant.token}` });

    expect(response.body).toContain('Пятничный');
  });
});

describe('предпросмотр', () => {
  it('отвечает тем, что получится', async () => {
    const grant = await grantFor();

    const response = await server.inject({
      method: 'POST',
      url: `/api/formats/${grant.token}/preview`,
      payload: { bricks },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.headline).toContain('Dota 2');
    expect(Array.isArray(body.lines)).toBe(true);
  });

  /**
   * Противоречие — обычный ответ, а не сбой: человек как раз и двигает кирпичики, чтобы
   * увидеть, где предел. Пятисотый здесь означал бы «бот сломался», а сломался не бот.
   */
  it('противоречивый набор объясняется, а не падает', async () => {
    const grant = await grantFor();

    const response = await server.inject({
      method: 'POST',
      url: `/api/formats/${grant.token}/preview`,
      payload: { bricks: { ...bricks, entryMode: 'solo', autoTeams: true } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().error).toMatch(/Автосбор/);
  });

  /**
   * Неизвестные значения заменяются значением по умолчанию, а не отвергаются: при обновлении
   * бота у кого-то остаётся открытой старая вкладка, и падать из-за этого незачем.
   */
  it('мусор в полях не роняет запрос', async () => {
    const grant = await grantFor();

    const response = await server.inject({
      method: 'POST',
      url: `/api/formats/${grant.token}/preview`,
      payload: { bricks: { game: 'фигня', entryMode: 'ъ', teamSize: 'много', bestOf: null } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().headline).toBeTruthy();
  });

  it('без пропуска не отвечает', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/formats/выдуманный/preview',
      payload: { bricks },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('сохранение', () => {
  it('сохраняет и возвращает обновлённый список', async () => {
    const grant = await grantFor();

    const response = await server.inject({
      method: 'POST',
      url: `/api/formats/${grant.token}/save`,
      payload: { name: 'Вечерний', note: 'по будням', bricks },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.created).toBe(true);
    expect(body.cards.data).toHaveLength(1);
    expect(body.cards.html).toContain('Вечерний');
  });

  it('без имени не сохраняет', async () => {
    const grant = await grantFor();

    const response = await server.inject({
      method: 'POST',
      url: `/api/formats/${grant.token}/save`,
      payload: { name: '  ', bricks },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBeTruthy();
  });

  /** Открытый в конструкторе формат правится, а не двоится: человек правил именно его. */
  it('переименование открытого формата не заводит второй', async () => {
    const grant = await grantFor();
    const first = await server.inject({
      method: 'POST',
      url: `/api/formats/${grant.token}/save`,
      payload: { name: 'Старое имя', bricks },
    });
    const id = first.json().id;

    const second = await server.inject({
      method: 'POST',
      url: `/api/formats/${grant.token}/save`,
      payload: { name: 'Новое имя', bricks, id },
    });

    expect(second.statusCode).toBe(200);
    const cards = second.json().cards.data;
    expect(cards).toHaveLength(1);
    expect(cards[0].name).toBe('Новое имя');
    expect(cards[0].id).toBe(id);
  });

  /**
   * Идентификатор приходит из браузера. Без фильтра по серверу пропуск на своём сервере
   * позволял бы править форматы чужого — достаточно подставить чужой номер.
   */
  it('чужой формат по номеру не правится', async () => {
    const mine = await grantFor();
    const other = await grantFor();
    const formats = createFormatsService({ db: pg.db });
    const theirs = await formats.save({
      guildId: other.guildId,
      name: 'Чужой',
      createdBy: other.userId,
      bricks: { entryMode: 'solo', teamSize: 1, maxEntrants: 8, format: 'single-elim', bestOf: 1 },
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/formats/${mine.token}/save`,
      payload: { name: 'Перехват', bricks, id: theirs.row.id },
    });

    // Формат создастся на своём сервере, но чужой останется как был — это и проверяем.
    expect(response.statusCode).toBe(200);
    expect((await formats.byName(other.guildId, 'Чужой'))?.id).toBe(theirs.row.id);
    expect(await formats.byName(other.guildId, 'Перехват')).toBeNull();
  });
});

describe('удаление', () => {
  it('удаляет и возвращает список без него', async () => {
    const grant = await grantFor();
    const saved = await server.inject({
      method: 'POST',
      url: `/api/formats/${grant.token}/save`,
      payload: { name: 'Лишний', bricks },
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/formats/${grant.token}/remove`,
      payload: { id: saved.json().id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().removed).toBe('Лишний');
    expect(response.json().cards.data).toHaveLength(0);
  });

  it('без номера отвечает внятно, а не молча', async () => {
    const grant = await grantFor();

    const response = await server.inject({
      method: 'POST',
      url: `/api/formats/${grant.token}/remove`,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBeTruthy();
  });

  it('чужой формат не удаляется', async () => {
    const mine = await grantFor();
    const other = await grantFor();
    const formats = createFormatsService({ db: pg.db });
    const theirs = await formats.save({
      guildId: other.guildId,
      name: 'Чужой',
      createdBy: other.userId,
      bricks: { entryMode: 'solo', teamSize: 1, maxEntrants: 8, format: 'single-elim', bestOf: 1 },
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/formats/${mine.token}/remove`,
      payload: { id: theirs.row.id },
    });

    expect(response.statusCode).toBe(404);
    expect((await formats.byName(other.guildId, 'Чужой'))?.id).toBe(theirs.row.id);
  });
});
