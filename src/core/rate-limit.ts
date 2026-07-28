import { Redis } from 'ioredis';
import type { Logger } from './logger.js';

export interface Limit {
  tokens: number;
  windowMs: number;
}

export interface RateLimiter {
  /** Ждёт, пока во всех окнах появится место, и только потом возвращается. */
  acquire(key: string, limits: Limit[]): Promise<void>;
  close(): Promise<void>;
}

const POLL_INTERVAL_MS = 50;
const MAX_WAIT_MS = 30_000;

export function createRateLimiter(deps: { redisUrl: string; logger: Logger }): RateLimiter {
  const redis = new Redis(deps.redisUrl, { maxRetriesPerRequest: 3 });

  // Без слушателя необработанное 'error' от ioredis (обрыв связи, рестарт контейнера,
  // сработавший maxmemory) убивает процесс целиком — см. Cache в src/core/cache.ts,
  // где ровно этот дефект был Critical на этапе 0.
  redis.on('error', (error) => {
    deps.logger.error({ err: error }, 'ошибка соединения с Redis у лимитера запросов');
  });

  async function tryTake(key: string, limit: Limit): Promise<boolean> {
    const bucketKey = `ratelimit:${key}:${limit.windowMs}`;
    const count = await redis.incr(bucketKey);
    if (count === 1) {
      await redis.pexpire(bucketKey, limit.windowMs);
    }
    if (count <= limit.tokens) return true;
    // Место кончилось — откатываем свой инкремент, чтобы ожидание не сдвигало окно.
    await redis.decr(bucketKey);
    return false;
  }

  // `redis` не входит в публичный интерфейс RateLimiter, но физически присутствует на
  // возвращаемом объекте — как приватное поле у Cache в src/core/cache.ts — и тест
  // достаёт его тем же приёмом (`as unknown as { redis: Redis }`), чтобы проверить
  // наличие слушателя 'error', не ломая инкапсуляцию сверх принятого в проекте образца.
  const limiter: RateLimiter & { redis: Redis } = {
    redis,

    async acquire(key: string, limits: Limit[]): Promise<void> {
      const deadline = Date.now() + MAX_WAIT_MS;

      while (Date.now() < deadline) {
        const taken: Limit[] = [];
        let blocked = false;

        for (const limit of limits) {
          if (await tryTake(key, limit)) {
            taken.push(limit);
          } else {
            blocked = true;
            break;
          }
        }

        if (!blocked) return;

        // Частично взятые токены надо вернуть, иначе узкое окно голодает.
        for (const limit of taken) {
          await redis.decr(`ratelimit:${key}:${limit.windowMs}`);
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      deps.logger.error({ key }, 'превышено время ожидания квоты rate limit');
      throw new Error(`Не удалось получить квоту для «${key}» за ${MAX_WAIT_MS} мс.`);
    },

    async close(): Promise<void> {
      await redis.quit();
    },
  };

  return limiter;
}
