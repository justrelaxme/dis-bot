import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { Cache } from '../../../src/core/cache.js';
import type { Config } from '../../../src/core/config.js';
import { createLogger } from '../../../src/core/logger.js';
import type { GameProvider, RankInfo } from '../../../src/modules/identity/providers/provider.js';
import { CACHE_TTL, withCache } from '../../../src/modules/identity/providers/with-cache.js';
import { withRedis } from '../../helpers/redis.js';

const redis = withRedis();

function makeCache(): Cache {
  const config = {
    REDIS_URL: redis.url,
    LOG_LEVEL: 'fatal',
    NODE_ENV: 'test',
  } as Config;
  return new Cache(config, createLogger(config));
}

function rank(tier: string): RankInfo {
  return { mode: 'solo-duo', scale: 'riot-tier', tier, division: 'II', points: 5, source: 'api', raw: {} };
}

function providerSpy(overrides: Partial<GameProvider> = {}) {
  const fetchProfile = vi.fn(async () => ({ externalId: 'X', displayName: 'Игрок#EUW' }));
  const fetchRank = vi.fn(async () => [rank('GOLD')]);
  const provider: GameProvider = {
    id: 'riot-lol',
    capabilities: { verification: 'riot-third-party-code', rank: 'api' },
    fetchProfile,
    fetchRank,
    ...overrides,
  };
  return { provider, fetchProfile, fetchRank };
}

describe('withCache', () => {
  it('сохраняет id и capabilities исходного провайдера', async () => {
    const { provider } = providerSpy();
    const cache = makeCache();
    const wrapped = withCache(provider, cache);

    expect(wrapped.id).toBe('riot-lol');
    expect(wrapped.capabilities).toEqual(provider.capabilities);
    await cache.close();
  });

  it('обращается к провайдеру один раз на два запроса профиля', async () => {
    const cache = makeCache();
    const { provider, fetchProfile } = providerSpy();
    const wrapped = withCache(provider, cache);

    await wrapped.fetchProfile('X1', 'euw1');
    await wrapped.fetchProfile('X1', 'euw1');

    expect(fetchProfile).toHaveBeenCalledTimes(1);
    await cache.close();
  });

  it('различает разных игроков по ключу кэша', async () => {
    const cache = makeCache();
    const { provider, fetchProfile } = providerSpy();
    const wrapped = withCache(provider, cache);

    await wrapped.fetchProfile('X2', 'euw1');
    await wrapped.fetchProfile('X3', 'euw1');

    expect(fetchProfile).toHaveBeenCalledTimes(2);
    await cache.close();
  });

  // Мутационная проверка №1 (см. отчёт задачи): тест из брифа выше различает
  // разных игроков через разный externalId при ОДНОМ регионе — он не поймает
  // потерю региона из ключа, потому что externalId и так делает ключи разными.
  // Этот тест держит противоположный случай: один и тот же externalId в разных
  // регионах — ровно сценарий «профиль игрока с euw1 отдастся игроку с na1» из
  // брифа. Без него регион можно выкинуть из ключа, и ни один тест не заметит.
  it('различает один и тот же externalId в разных регионах по ключу кэша', async () => {
    const cache = makeCache();
    const { provider, fetchProfile } = providerSpy();
    const wrapped = withCache(provider, cache);

    await wrapped.fetchProfile('X6', 'euw1');
    await wrapped.fetchProfile('X6', 'na1');

    expect(fetchProfile).toHaveBeenCalledTimes(2);
    await cache.close();
  });

  it('кэширует ранги отдельно от профиля', async () => {
    const cache = makeCache();
    const { provider, fetchRank } = providerSpy();
    const wrapped = withCache(provider, cache);

    await wrapped.fetchRank!('X4', 'euw1');
    await wrapped.fetchRank!('X4', 'euw1');

    expect(fetchRank).toHaveBeenCalledTimes(1);
    await cache.close();
  });

  it('пробрасывает ошибку провайдера, когда в кэше нет даже просроченной копии', async () => {
    // Отдачу просроченного при сбое загрузчика покрывают тесты самого Cache (этап 0, Task 5):
    // здесь проверяется противоположный случай — когда отдавать нечего.
    const cache = makeCache();
    let failing = false;
    const provider: GameProvider = {
      id: 'riot-lol',
      capabilities: { verification: 'riot-third-party-code', rank: 'api' },
      fetchProfile: async () => ({ externalId: 'X5', displayName: 'a#b' }),
      fetchRank: async () => {
        if (failing) throw new Error('Riot лёг');
        return [rank('GOLD')];
      },
    };
    const wrapped = withCache(provider, cache);

    await wrapped.fetchRank!('X5', 'euw1');
    await cache.drop('provider:riot-lol:rank:X5:euw1');
    failing = true;

    // Ключ удалён — просроченного нет, ошибка обязана пройти наружу.
    await expect(wrapped.fetchRank!('X5', 'euw1')).rejects.toThrow('Riot лёг');
    await cache.close();
  });

  it('не оборачивает провайдера без fetchRank', async () => {
    const manual: GameProvider = {
      id: 'riot-valorant',
      capabilities: { verification: 'none', rank: 'manual' },
      fetchProfile: async () => ({ externalId: 'a#b', displayName: 'a#b' }),
    };
    const cache = makeCache();
    const wrapped = withCache(manual, cache);

    expect(wrapped.fetchRank).toBeUndefined();
    // Находка 1: rankFreshness — та же условная пристройка, что и fetchRank (см.
    // withCache), поэтому у провайдера с ручным рангом её тоже не должно быть —
    // иначе карточка получила бы отметку устаревания там, где взяться ей неоткуда
    // (нет никакого «сервиса игры», который мог бы «не ответить»).
    expect(wrapped.rankFreshness).toBeUndefined();
    await cache.close();
  });

  it('пробрасывает методы верификации без изменений', async () => {
    const startVerification = vi.fn();
    const { provider } = providerSpy({ startVerification: startVerification as never });
    const cache = makeCache();
    const wrapped = withCache(provider, cache);

    expect(wrapped.startVerification).toBe(startVerification);
    await cache.close();
  });

  // Находка 1 (главная): staleSince в карточке обязана приходить от настоящей
  // свежести кэша, а не от gameAccounts.updatedAt (её синхронизация двигает даже
  // на провальной попытке — поэтому она лжёт в обе стороны, см. profile.ts).
  describe('rankFreshness', () => {
    it('сообщает о просроченном значении, когда провайдер сейчас недоступен', async () => {
      const cache = makeCache();
      const provider: GameProvider = {
        id: 'riot-lol',
        capabilities: { verification: 'riot-third-party-code', rank: 'api' },
        fetchProfile: async () => ({ externalId: 'X9', displayName: 'a#b' }),
        fetchRank: async () => {
          throw new Error('Riot лёг');
        },
      };
      const wrapped = withCache(provider, cache);

      // withCache использует фиксированный CACHE_TTL.rank (20 минут / 24 часа —
      // спека этапа), поэтому единственный способ проверить возраст «просрочено, но
      // ещё отдаём» без реального ожидания 20+ минут — записать в Redis уже
      // «состаренную» запись напрямую, в обход Cache.write (тот же приём приведения
      // приватного поля к типу, что и в tests/integration/cache.test.ts).
      const storedAt = Date.now() - 21 * 60 * 1_000;
      const internal = cache as unknown as { redis: Redis };
      await internal.redis.set(
        'cache:provider:riot-lol:rank:X9:euw1',
        JSON.stringify({ value: [rank('GOLD')], storedAt }),
        'PX',
        CACHE_TTL.rank.staleMs,
      );

      const freshness = await wrapped.rankFreshness!('X9', 'euw1');

      expect(freshness?.stale).toBe(true);
      expect(freshness?.storedAt).toEqual(new Date(storedAt));
      await cache.close();
    });

    it('не считает значение просроченным, пока провайдер отвечает', async () => {
      const cache = makeCache();
      const { provider } = providerSpy();
      const wrapped = withCache(provider, cache);

      await wrapped.fetchRank!('X10', 'euw1');
      const freshness = await wrapped.rankFreshness!('X10', 'euw1');

      expect(freshness?.stale).toBe(false);
      await cache.close();
    });

    it('не падает и возвращает undefined, когда в кэше нет вообще ничего и провайдер лёг', async () => {
      const cache = makeCache();
      const provider: GameProvider = {
        id: 'riot-lol',
        capabilities: { verification: 'riot-third-party-code', rank: 'api' },
        fetchProfile: async () => ({ externalId: 'X11', displayName: 'a#b' }),
        fetchRank: async () => {
          throw new Error('Riot лёг');
        },
      };
      const wrapped = withCache(provider, cache);

      await expect(wrapped.rankFreshness!('X11', 'euw1')).resolves.toBeUndefined();
      await cache.close();
    });
  });
});
