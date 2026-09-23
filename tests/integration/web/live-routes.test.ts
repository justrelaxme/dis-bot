import { get, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { EventBus } from '../../../src/core/events/bus.js';
import { createLogger } from '../../../src/core/logger.js';
import { createLiveHub, registerLiveRoutes, wireLive, type LiveHub } from '../../../src/modules/web/live.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

/**
 * Живой поток целиком: настоящий HTTP, настоящая шина. Проверяется то, чего не видно из хаба:
 * что ответ действительно поток, что событие матча доходит до открытой страницы и что кэш
 * страницы сброшен раньше, чем она перечитается.
 */

let server: FastifyInstance | null = null;
let hub: LiveHub | null = null;

afterEach(async () => {
  hub?.closeAll();
  await server?.close();
  server = null;
  hub = null;
});

async function start(max = 10) {
  server = Fastify();
  hub = createLiveHub({ max, debounceMs: 10 });
  const bus = new EventBus(logger);
  const cache = { drop: vi.fn(async () => {}) };
  registerLiveRoutes(server, { hub });
  wireLive({ bus, hub, cache, logger });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const { port } = server.server.address() as AddressInfo;
  return { bus, cache, port };
}

function open(port: number, id: string): Promise<{ response: IncomingMessage; chunks: string[] }> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const request = get({ host: '127.0.0.1', port, path: `/api/live/t/${id}` }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => chunks.push(chunk));
      resolve({ response, chunks });
    });
    request.on('error', reject);
  });
}

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
};

describe('живой поток витрины', () => {
  it('отвечает потоком событий и сразу говорит, через сколько переподключаться', async () => {
    const { port } = await start();

    const { response, chunks } = await open(port, '7');
    await until(() => chunks.join('').includes('retry'));

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(chunks.join('')).toContain('retry: 3000');
    response.destroy();
  });

  /** Кэш — раньше сигнала: иначе страница, перечитанная по нему, получила бы прежнюю копию. */
  it('закрытие матча доходит до открытой страницы, кэш сброшен', async () => {
    const { bus, cache, port } = await start();
    const { response, chunks } = await open(port, '7');
    await until(() => chunks.join('').includes('retry'));

    await bus.emit('match.confirmed', {
      guildId: 'g',
      tournamentId: 7,
      matchId: 12,
      winnerEntrantId: 1,
      via: 'confirm',
      finished: false,
    });
    await until(() => chunks.join('').includes('event: change'));

    expect(chunks.join('')).toContain('"matchIds":[12]');
    expect(cache.drop).toHaveBeenCalledWith('web:tournament:7');
    response.destroy();
  });

  it('несуществующий номер — 404, а не вечный поток', async () => {
    const { port } = await start();

    const { response } = await open(port, 'abc');

    expect(response.statusCode).toBe(404);
    response.destroy();
  });

  /** Мест нет — страница остаётся рабочей, просто без живых обновлений. */
  it('сверх предела — 503 с советом, когда прийти', async () => {
    const { port } = await start(1);
    const first = await open(port, '7');
    await until(() => first.chunks.join('').includes('retry'));

    const second = await open(port, '7');

    expect(second.response.statusCode).toBe(503);
    expect(second.response.headers['retry-after']).toBe('30');
    first.response.destroy();
    second.response.destroy();
  });

  it('закрытый браузер освобождает место', async () => {
    const { port } = await start(1);
    const first = await open(port, '7');
    await until(() => first.chunks.join('').includes('retry'));

    first.response.destroy();
    await until(() => hub?.size === 0);

    expect(hub?.size).toBe(0);
  });
});
