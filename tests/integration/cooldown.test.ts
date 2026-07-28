import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/core/config.js';
import { createCooldown } from '../../src/core/cooldown.js';
import { createLogger } from '../../src/core/logger.js';
import { withRedis } from '../helpers/redis.js';

const redis = withRedis();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

describe('createCooldown', () => {
  // Тест добавлен сверх дословного текста брифа: обязательная поправка задачи
  // требует слушатель 'error' у клиента ioredis (см. src/core/rate-limit.ts) —
  // без него необработанное 'error' убивает процесс мимо аккуратного завершения.
  it('вешает обработчик error на клиент Redis, чтобы обрыв соединения не ронял процесс', async () => {
    const cooldown = createCooldown({ redisUrl: redis.url, logger });
    const internal = cooldown as unknown as { redis: Redis };

    expect(internal.redis.listenerCount('error')).toBeGreaterThan(0);

    await cooldown.close();
  });

  it('пропускает первый вызов', async () => {
    const cooldown = createCooldown({ redisUrl: redis.url, logger });
    await expect(cooldown.hit('u:1', 10_000)).resolves.toMatchObject({ allowed: true });
    await cooldown.close();
  });

  it('отказывает во втором вызове внутри окна и сообщает остаток', async () => {
    const cooldown = createCooldown({ redisUrl: redis.url, logger });
    await cooldown.hit('u:2', 10_000);

    const second = await cooldown.hit('u:2', 10_000);

    expect(second.allowed).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);
    expect(second.retryAfterMs).toBeLessThanOrEqual(10_000);
    await cooldown.close();
  });

  it('снова пропускает после истечения окна', async () => {
    const cooldown = createCooldown({ redisUrl: redis.url, logger });
    await cooldown.hit('u:3', 150);
    await new Promise((resolve) => setTimeout(resolve, 250));

    await expect(cooldown.hit('u:3', 150)).resolves.toMatchObject({ allowed: true });
    await cooldown.close();
  });

  it('ведёт независимый учёт по ключам', async () => {
    const cooldown = createCooldown({ redisUrl: redis.url, logger });
    await cooldown.hit('u:4', 10_000);

    await expect(cooldown.hit('u:5', 10_000)).resolves.toMatchObject({ allowed: true });
    await cooldown.close();
  });
});
