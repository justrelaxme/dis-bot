import { describe, expect, it, vi } from 'vitest';
import { Cache } from '../../src/core/cache.js';
import { loadConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import { withRedis } from '../helpers/redis.js';

const redis = withRedis();

function makeCache(): Cache {
  const config = loadConfig({
    DISCORD_TOKEN: 'test',
    DISCORD_APP_ID: '123456789012345678',
    DISCORD_GUILD_ID: '876543210987654321',
    DATABASE_URL: 'postgres://localhost:5432/x',
    REDIS_URL: redis.url,
    PUBLIC_BASE_URL: 'https://test.example.com',
    NODE_ENV: 'test',
  });
  return new Cache(config, createLogger(config));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Cache.swr', () => {
  it('вызывает загрузчик при холодном промахе', async () => {
    const cache = makeCache();
    const load = vi.fn(async () => 'значение');

    const result = await cache.swr('k:cold', { ttlMs: 60_000, staleMs: 600_000, load });

    expect(result.value).toBe('значение');
    expect(result.stale).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    await cache.close();
  });

  it('не трогает загрузчик, пока запись свежая', async () => {
    const cache = makeCache();
    const load = vi.fn(async () => 'значение');

    await cache.swr('k:hit', { ttlMs: 60_000, staleMs: 600_000, load });
    const second = await cache.swr('k:hit', { ttlMs: 60_000, staleMs: 600_000, load });

    expect(second.stale).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    await cache.close();
  });

  it('отдаёт просроченное немедленно и обновляет в фоне', async () => {
    const cache = makeCache();
    let counter = 0;
    const load = vi.fn(async () => `значение-${++counter}`);

    await cache.swr('k:stale', { ttlMs: 30, staleMs: 600_000, load });
    await wait(60);

    const stale = await cache.swr('k:stale', { ttlMs: 30, staleMs: 600_000, load });
    expect(stale.value).toBe('значение-1');
    expect(stale.stale).toBe(true);

    await wait(200);
    const refreshed = await cache.swr('k:stale', { ttlMs: 30, staleMs: 600_000, load });
    expect(refreshed.value).toBe('значение-2');
    await cache.close();
  });

  it('отдаёт просроченное, когда загрузчик падает', async () => {
    const cache = makeCache();
    await cache.swr('k:fail', { ttlMs: 30, staleMs: 600_000, load: async () => 'старое' });
    await wait(60);

    const result = await cache.swr('k:fail', {
      ttlMs: 30,
      staleMs: 600_000,
      load: async () => {
        throw new Error('провайдер лёг');
      },
    });

    expect(result.value).toBe('старое');
    expect(result.stale).toBe(true);
    await cache.close();
  });

  it('пробрасывает ошибку, когда просроченного нет', async () => {
    const cache = makeCache();
    await expect(
      cache.swr('k:empty', {
        ttlMs: 30,
        staleMs: 600_000,
        load: async () => {
          throw new Error('провайдер лёг');
        },
      }),
    ).rejects.toThrow('провайдер лёг');
    await cache.close();
  });

  it('на холодном промахе десять параллельных вызовов зовут загрузчик один раз и получают одно значение', async () => {
    // Без лока на холодном пути каждый из десяти вызовов сходил бы за своим значением
    // сам — именно то, от чего лок в doRefresh уже защищает тёплый (background-refresh)
    // путь, но не холодный.
    const cache = makeCache();
    let calls = 0;
    const load = vi.fn(async () => {
      calls++;
      await wait(100);
      return `значение-${calls}`;
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => cache.swr('k:stampede', { ttlMs: 60_000, staleMs: 600_000, load })),
    );

    expect(load).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.value).toBe('значение-1');
    }
    await cache.close();
  });

  it('на холодном промахе падение загрузчика доходит до всех параллельных вызывающих', async () => {
    const cache = makeCache();
    const load = vi.fn(async () => {
      await wait(50);
      throw new Error('провайдер лёг');
    });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        cache.swr('k:stampede-fail', { ttlMs: 60_000, staleMs: 600_000, load }),
      ),
    );

    for (const result of results) {
      expect(result.status).toBe('rejected');
    }
    await cache.close();
  });
});
