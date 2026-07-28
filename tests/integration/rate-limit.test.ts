import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import { createRateLimiter } from '../../src/core/rate-limit.js';
import { withRedis } from '../helpers/redis.js';

const redis = withRedis();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

describe('createRateLimiter', () => {
  it('пропускает вызовы в пределах лимита без задержки', async () => {
    const limiter = createRateLimiter({ redisUrl: redis.url, logger });
    const startedAt = Date.now();

    for (let i = 0; i < 5; i += 1) {
      await limiter.acquire('k:under', [{ tokens: 5, windowMs: 10_000 }]);
    }

    expect(Date.now() - startedAt).toBeLessThan(500);
    await limiter.close();
  });

  it('задерживает вызов сверх лимита до освобождения окна', async () => {
    const limiter = createRateLimiter({ redisUrl: redis.url, logger });
    const limits = [{ tokens: 2, windowMs: 400 }];

    await limiter.acquire('k:over', limits);
    await limiter.acquire('k:over', limits);
    const startedAt = Date.now();
    await limiter.acquire('k:over', limits);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
    await limiter.close();
  });

  it('соблюдает самое узкое из нескольких окон', async () => {
    const limiter = createRateLimiter({ redisUrl: redis.url, logger });
    const limits = [
      { tokens: 10, windowMs: 60_000 },
      { tokens: 1, windowMs: 400 },
    ];

    await limiter.acquire('k:multi', limits);
    const startedAt = Date.now();
    await limiter.acquire('k:multi', limits);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
    await limiter.close();
  });

  it('ведёт независимый учёт по разным ключам', async () => {
    const limiter = createRateLimiter({ redisUrl: redis.url, logger });
    const limits = [{ tokens: 1, windowMs: 5_000 }];

    await limiter.acquire('k:a', limits);
    const startedAt = Date.now();
    await limiter.acquire('k:b', limits);

    expect(Date.now() - startedAt).toBeLessThan(200);
    await limiter.close();
  });

  it('вешает обработчик error на клиент Redis, чтобы обрыв соединения не ронял процесс', async () => {
    // Без слушателя необработанное 'error' у ioredis (EventEmitter) убивает процесс —
    // проверяем сам факт наличия слушателя, а не что-то в логе: писать в реальный
    // Redis ошибку неудобно и хрупко. Доступ к приватному полю `redis` — тем же
    // приёмом, что и в tests/integration/cache.test.ts (internal as unknown as {...}).
    const limiter = createRateLimiter({ redisUrl: redis.url, logger });
    const internal = limiter as unknown as { redis: Redis };

    expect(internal.redis.listenerCount('error')).toBeGreaterThan(0);

    await limiter.close();
  });
});
