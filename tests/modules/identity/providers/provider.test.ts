import { describe, expect, it } from 'vitest';
import { canFetchRank, canVerify, type GameProvider } from '../../../../src/modules/identity/providers/provider.js';

const full: GameProvider = {
  id: 'steam',
  capabilities: { verification: 'steam-openid', rank: 'api' },
  startVerification: async () => ({ challenge: 'x', expiresAt: new Date(), payload: {} }),
  completeVerification: async () => ({ externalId: '1', displayName: 'a', verificationMethod: 'steam-openid' }),
  fetchProfile: async () => ({ externalId: '1', displayName: 'a' }),
  fetchRank: async () => [],
};

const manual: GameProvider = {
  id: 'riot-valorant',
  capabilities: { verification: 'none', rank: 'manual' },
  fetchProfile: async () => ({ externalId: 'a#b', displayName: 'a#b' }),
};

describe('canVerify', () => {
  it('истина, когда провайдер умеет подтверждать владение', () => {
    expect(canVerify(full)).toBe(true);
  });

  it('ложь для провайдера с verification: none', () => {
    expect(canVerify(manual)).toBe(false);
  });

  it('ложь, если методы верификации не реализованы, несмотря на объявление', () => {
    expect(canVerify({ ...manual, capabilities: { verification: 'steam-openid', rank: 'manual' } })).toBe(false);
  });
});

describe('canFetchRank', () => {
  it('истина только при rank: api и реализованном fetchRank', () => {
    expect(canFetchRank(full)).toBe(true);
    expect(canFetchRank(manual)).toBe(false);
    expect(canFetchRank({ ...manual, capabilities: { verification: 'none', rank: 'api' } })).toBe(false);
  });
});
