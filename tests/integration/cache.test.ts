import type { Redis } from 'ioredis';
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

  it('падение фонового обновления не всплывает необработанным отклонением промиса', async () => {
    // Пиннит наличие .catch в цепочке refreshInBackground (cache.ts): убери его —
    // и отклонение doRefresh станет необработанным, потому что .finally успевает
    // вычистить задачу из pendingRefreshes раньше, чем close() поймал бы её через
    // Promise.allSettled. Проверено: удаление .catch валит именно этот тест.
    // Порядок .catch и .finally при этом не важен — .catch гасит отклонение с любой
    // позиции в цепочке, так что менять их местами регрессию НЕ воспроизводит.
    const cache = makeCache();
    await cache.swr('k:reject-finally', { ttlMs: 30, staleMs: 600_000, load: async () => 'исходное' });
    await wait(60);

    // options.load(), брошенный на просроченной записи, уходит в собственный catch
    // doRefresh (там просто warn) и не долетает до refreshInBackground — поэтому вместо
    // падения загрузчика ломаем redis.del у лока в finally: это и правда пробрасывается
    // наружу из doRefresh. Приватное поле — доступ через приведение типа: публичного
    // способа подсунуть Cache сломанный редис-клиент нет.
    const internal = cache as unknown as { redis: Redis };
    const delSpy = vi.spyOn(internal.redis, 'del').mockRejectedValueOnce(new Error('redis.del недоступен'));

    const seen: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const stale = await cache.swr('k:reject-finally', {
        ttlMs: 30,
        staleMs: 600_000,
        load: async () => 'обновлённое',
      });
      expect(stale.stale).toBe(true);

      // Даём фоновому обновлению (загрузка, запись и упавший redis.del в finally
      // doRefresh) время дойти до конца и, если бы .catch не стоял перед .finally,
      // успеть всплыть необработанным отклонением.
      await wait(300);

      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      delSpy.mockRestore();
      await cache.close();
    }
  });
});
