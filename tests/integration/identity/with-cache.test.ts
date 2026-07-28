import { describe, expect, it, vi } from 'vitest';
import { Cache } from '../../../src/core/cache.js';
import type { Config } from '../../../src/core/config.js';
import { createLogger } from '../../../src/core/logger.js';
import type { GameProvider, RankInfo } from '../../../src/modules/identity/providers/provider.js';
import { withCache } from '../../../src/modules/identity/providers/with-cache.js';
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
  it('сохраняет id и capabilities исходного провайдера', () => {
    const { provider } = providerSpy();
    const wrapped = withCache(provider, makeCache());

    expect(wrapped.id).toBe('riot-lol');
    expect(wrapped.capabilities).toEqual(provider.capabilities);
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

  it('не оборачивает провайдера без fetchRank', () => {
    const manual: GameProvider = {
      id: 'riot-valorant',
      capabilities: { verification: 'none', rank: 'manual' },
      fetchProfile: async () => ({ externalId: 'a#b', displayName: 'a#b' }),
    };

    expect(withCache(manual, makeCache()).fetchRank).toBeUndefined();
  });

  it('пробрасывает методы верификации без изменений', () => {
    const startVerification = vi.fn();
    const { provider } = providerSpy({ startVerification: startVerification as never });
    const wrapped = withCache(provider, makeCache());

    expect(wrapped.startVerification).toBe(startVerification);
  });
});
