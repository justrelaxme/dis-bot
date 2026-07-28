import { describe, expect, it } from 'vitest';
import { hasRankChanged, rankScore } from '../../../../src/modules/identity/ranks/compare.js';
import type { RankInfo } from '../../../../src/modules/identity/providers/provider.js';

function riot(tier: string, division: string | null, points = 0): RankInfo {
  return { mode: 'solo-duo', scale: 'riot-tier', tier, division, points, source: 'api', raw: {} };
}

describe('rankScore', () => {
  it('ставит более высокий тир выше', () => {
    expect(rankScore(riot('DIAMOND', 'IV'))).toBeGreaterThan(rankScore(riot('EMERALD', 'I')));
  });

  it('ставит первый дивизион выше четвёртого внутри тира', () => {
    expect(rankScore(riot('GOLD', 'I'))).toBeGreaterThan(rankScore(riot('GOLD', 'IV')));
  });

  it('учитывает LP внутри дивизиона', () => {
    expect(rankScore(riot('GOLD', 'II', 80))).toBeGreaterThan(rankScore(riot('GOLD', 'II', 10)));
  });

  it('ставит Challenger выше Master', () => {
    expect(rankScore(riot('CHALLENGER', null, 1200))).toBeGreaterThan(rankScore(riot('MASTER', null, 1200)));
  });

  it('даёт ноль для ранга без тира', () => {
    expect(rankScore(riot(null as unknown as string, null))).toBe(0);
  });
});

describe('hasRankChanged', () => {
  it('считает изменением первое появление ранга', () => {
    expect(hasRankChanged(null, riot('GOLD', 'II'))).toBe(true);
  });

  it('считает изменением смену тира', () => {
    expect(hasRankChanged(riot('GOLD', 'I'), riot('PLATINUM', 'IV'))).toBe(true);
  });

  it('считает изменением смену дивизиона', () => {
    expect(hasRankChanged(riot('GOLD', 'III'), riot('GOLD', 'II'))).toBe(true);
  });

  it('НЕ считает изменением сдвиг LP внутри дивизиона', () => {
    expect(hasRankChanged(riot('GOLD', 'II', 10), riot('GOLD', 'II', 88))).toBe(false);
  });

  it('считает изменением сдвиг очков у тира без дивизионов', () => {
    expect(hasRankChanged(riot('MASTER', null, 100), riot('MASTER', null, 250))).toBe(true);
  });
});
