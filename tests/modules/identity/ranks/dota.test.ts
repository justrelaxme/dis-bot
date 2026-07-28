import { describe, expect, it } from 'vitest';
import { DOTA_MEDALS, normalizeDotaRank } from '../../../../src/modules/identity/ranks/dota.js';

describe('DOTA_MEDALS', () => {
  it('перечисляет восемь медалей от Herald до Immortal', () => {
    expect(DOTA_MEDALS).toHaveLength(8);
    expect(DOTA_MEDALS[0]).toBe('HERALD');
    expect(DOTA_MEDALS.at(-1)).toBe('IMMORTAL');
  });
});

describe('normalizeDotaRank', () => {
  it('разбирает медаль и звезду из двузначного кода', () => {
    expect(normalizeDotaRank({ rank_tier: 53 })).toMatchObject({
      mode: 'dota-mmr',
      scale: 'dota-mmr',
      tier: 'LEGEND',
      division: '3',
      source: 'api',
    });
  });

  it('разбирает младшую медаль', () => {
    expect(normalizeDotaRank({ rank_tier: 11 })).toMatchObject({ tier: 'HERALD', division: '1' });
  });

  it('обнуляет звезду у Immortal', () => {
    const result = normalizeDotaRank({ rank_tier: 80 });
    expect(result).toMatchObject({ tier: 'IMMORTAL', division: null });
  });

  it('кладёт место в лидерборде в points для Immortal', () => {
    const result = normalizeDotaRank({ rank_tier: 80, leaderboard_rank: 412 });
    expect(result?.points).toBe(412);
  });

  it('возвращает null для игрока без калибровки', () => {
    expect(normalizeDotaRank({ rank_tier: null })).toBeNull();
  });

  it('возвращает null для кода вне допустимого диапазона', () => {
    expect(normalizeDotaRank({ rank_tier: 99 })).toBeNull();
    expect(normalizeDotaRank({ rank_tier: 0 })).toBeNull();
  });

  it('сохраняет исходный ответ в raw', () => {
    const player = { rank_tier: 61, leaderboard_rank: null };
    expect(normalizeDotaRank(player)?.raw).toEqual(player);
  });
});
