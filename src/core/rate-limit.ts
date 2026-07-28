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

  return {
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
}
