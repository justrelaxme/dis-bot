import { Redis } from 'ioredis';
import type { Logger } from './logger.js';
import { logRedisErrors } from './redis.js';

export interface CooldownVerdict {
  allowed: boolean;
  retryAfterMs: number;
}

export interface Cooldown {
  hit(key: string, windowMs: number): Promise<CooldownVerdict>;
  close(): Promise<void>;
}

export function createCooldown(deps: { redisUrl: string; logger: Logger }): Cooldown {
  const redis = new Redis(deps.redisUrl, { maxRetriesPerRequest: 3 });

  // ОБЯЗАТЕЛЬНО, тот же случай, что у createRateLimiter (src/core/rate-limit.ts):
  // `ioredis` — EventEmitter, и событие `error` без слушателя становится
  // неперехваченным исключением, которое убивает процесс мимо аккуратного
  // завершения. Это был единственный Critical этапа 0 и он же вернулся в Task 5.
  // Общий обработчик (src/core/redis.ts) называет адрес и глушит повторы.
  logRedisErrors(redis, { logger: deps.logger, redisUrl: deps.redisUrl, label: 'кулдаун команд' });

  // `redis` не входит в публичный интерфейс Cooldown, но физически присутствует на
  // возвращаемом объекте — как у RateLimiter в src/core/rate-limit.ts — и тест
  // достаёт его тем же приёмом (`as unknown as { redis: Redis }`), чтобы проверить
  // наличие слушателя 'error'. Промежуточная переменная нужна: вернуть литерал с
  // лишним полем `redis` прямо под объявленным типом `Cooldown` не даст проверка
  // избыточных свойств (redis не объявлен в Cooldown).
  const cooldown: Cooldown & { redis: Redis } = {
    redis,

    async hit(key, windowMs): Promise<CooldownVerdict> {
      const redisKey = `cooldown:${key}`;
      const acquired = await redis.set(redisKey, '1', 'PX', windowMs, 'NX');
      if (acquired === 'OK') {
        return { allowed: true, retryAfterMs: 0 };
      }
      const remaining = await redis.pttl(redisKey);
      return { allowed: false, retryAfterMs: remaining > 0 ? remaining : windowMs };
    },

    async close(): Promise<void> {
      await redis.quit();
    },
  };

  return cooldown;
}
