import { Redis } from 'ioredis';
import { beforeAll } from 'vitest';

const DEFAULT_TEST_REDIS_URL = 'redis://localhost:56379';

interface RedisFixture {
  get url(): string;
}

/**
 * Отдаёт адрес настоящего Redis из тестовых сервисов, предварительно убедившись,
 * что он отвечает. Жизненным циклом контейнера управляет compose, а не тест:
 * Testcontainers на rootless Podman зависает после health check.
 */
export function withRedis(): RedisFixture {
  const url = process.env['REDIS_URL_TEST'] ?? DEFAULT_TEST_REDIS_URL;

  beforeAll(async () => {
    const probe = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
    try {
      await probe.connect();
      await probe.ping();
      // Чистим за предыдущими прогонами: ключи кэша и локи не должны перетекать.
      await probe.flushdb();
    } catch (error) {
      throw new Error(
        `Тестовый Redis недоступен по ${url}. ` +
          `Подними сервисы: npm run test:services:up. Исходная ошибка: ${(error as Error).message}`,
      );
    } finally {
      probe.disconnect();
    }
  });

  return {
    get url() {
      return url;
    },
  };
}
