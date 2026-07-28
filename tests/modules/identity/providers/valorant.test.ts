import { describe, expect, it } from 'vitest';
import { UserError } from '../../../../src/core/errors.js';
import type { FetchClient } from '../../../../src/core/http/fetch-client.js';
import type { RateLimiter } from '../../../../src/core/rate-limit.js';
import { rankScore } from '../../../../src/modules/identity/ranks/compare.js';
import { canFetchRank, canVerify } from '../../../../src/modules/identity/providers/provider.js';
import {
  createProviderRegistry,
  getProvider,
  type ProviderRegistryDeps,
} from '../../../../src/modules/identity/providers/index.js';
import { createValorantProvider, manualValorantRank } from '../../../../src/modules/identity/providers/valorant.js';
import type { ProviderId } from '../../../../src/modules/identity/schema.js';

describe('createValorantProvider', () => {
  it('честно объявляет, что не умеет ни верификацию, ни автоматический ранг', () => {
    const provider = createValorantProvider();

    expect(provider.id).toBe('riot-valorant');
    expect(provider.capabilities).toEqual({ verification: 'none', rank: 'manual' });
    expect(canVerify(provider)).toBe(false);
    expect(canFetchRank(provider)).toBe(false);
  });

  it('строит профиль из Riot ID без обращения к сети', async () => {
    const provider = createValorantProvider();
    await expect(provider.fetchProfile('Игрок#EUW')).resolves.toEqual({
      externalId: 'Игрок#EUW',
      displayName: 'Игрок#EUW',
    });
  });

  it('отвергает Riot ID неверного формата', async () => {
    const provider = createValorantProvider();
    await expect(provider.fetchProfile('Игрок')).rejects.toThrow(UserError);
  });
});

describe('manualValorantRank', () => {
  it('размечает ранг как введённый вручную', () => {
    expect(manualValorantRank('Immortal 2')).toMatchObject({
      mode: 'val-competitive',
      scale: 'valorant-tier',
      tier: 'IMMORTAL',
      division: 'II',
      source: 'manual',
    });
  });

  it('принимает тир без дивизиона', () => {
    expect(manualValorantRank('RADIANT')).toMatchObject({ tier: 'RADIANT', division: null });
  });

  it('бросает UserError с перечислением допустимых значений', () => {
    expect(() => manualValorantRank('очень высокий')).toThrow(/IRON/);
  });

  it('отвергает тир, которого нет в Valorant, хотя он существует у Riot (Emerald — только LoL)', () => {
    expect(() => manualValorantRank('EMERALD')).toThrow(UserError);
  });
});

// Регрессия закрытого дефекта Task 3: rankScore раньше искал тир Valorant в списке
// тиров Riot (RIOT_TIERS), где индексы DIAMOND и ASCENDANT не совпадают по смыслу
// с Valorant. Лечение — отдельная шкала 'valorant-tier', которую tierIndex в compare.ts
// выбирает явно. Здесь закрепляется, что manualValorantRank её действительно проставляет
// и что порядок тиров после этого верный.
describe('шкала ранга Valorant (регрессия Task 3: DIAMOND не должен быть выше ASCENDANT)', () => {
  it('manualValorantRank проставляет scale: valorant-tier, а не riot-tier', () => {
    expect(manualValorantRank('DIAMOND').scale).toBe('valorant-tier');
  });

  it('rankScore(DIAMOND) ниже rankScore(ASCENDANT) в шкале Valorant', () => {
    const diamond = manualValorantRank('Diamond 1');
    const ascendant = manualValorantRank('Ascendant 1');
    expect(rankScore(diamond)).toBeLessThan(rankScore(ascendant));
  });
});

/** Сеть не должна вызываться при сборке реестра — только при обращении к конкретному провайдеру. */
const fetchClientStub: FetchClient = {
  async json<T>(): Promise<T> {
    throw new Error('в этом тесте сеть вызываться не должна');
  },
};

const rateLimiterStub: RateLimiter = {
  async acquire(): Promise<void> {
    // намеренно ничего не делает: сборка реестра не должна обращаться к лимитеру
  },
  async close(): Promise<void> {},
};

const registryDeps: ProviderRegistryDeps = {
  publicBaseUrl: 'https://bot.example.test',
  steamClient: fetchClientStub,
  openDotaClient: fetchClientStub,
  riotClient: fetchClientStub,
  rateLimiter: rateLimiterStub,
};

describe('createProviderRegistry', () => {
  it('собирает все четыре провайдера даже без ключей Steam/Riot — это законное состояние окружения', () => {
    const registry = createProviderRegistry(registryDeps);
    expect([...registry.keys()].sort()).toEqual(['riot-lol', 'riot-tft', 'riot-valorant', 'steam'].sort());
  });

  it('каждый провайдер зарегистрирован под собственным id', () => {
    const registry = createProviderRegistry(registryDeps);
    expect(registry.get('riot-valorant')?.id).toBe('riot-valorant');
    expect(registry.get('steam')?.id).toBe('steam');
  });
});

describe('getProvider', () => {
  it('возвращает провайдер по известному id', () => {
    const registry = createProviderRegistry(registryDeps);
    expect(getProvider(registry, 'riot-valorant').id).toBe('riot-valorant');
  });

  it('бросает UserError на неизвестном ProviderId — реестр не подделывает провайдера, которого нет', () => {
    const registry = createProviderRegistry(registryDeps);
    expect(() => getProvider(registry, 'unknown-provider' as unknown as ProviderId)).toThrow(UserError);
  });
});
