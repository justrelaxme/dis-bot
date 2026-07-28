import { describe, expect, it } from 'vitest';
import { RIOT_TIERS, normalizeRiotEntry, parseRiotTier } from '../../../../src/modules/identity/ranks/riot.js';

describe('RIOT_TIERS', () => {
  it('включает EMERALD между PLATINUM и DIAMOND', () => {
    expect(RIOT_TIERS.indexOf('EMERALD')).toBe(RIOT_TIERS.indexOf('PLATINUM') + 1);
    expect(RIOT_TIERS.indexOf('DIAMOND')).toBe(RIOT_TIERS.indexOf('EMERALD') + 1);
  });

  it('перечисляет все десять тиров от IRON до CHALLENGER', () => {
    expect(RIOT_TIERS).toHaveLength(10);
    expect(RIOT_TIERS[0]).toBe('IRON');
    expect(RIOT_TIERS.at(-1)).toBe('CHALLENGER');
  });
});

describe('normalizeRiotEntry', () => {
  it('нормализует запись соло-очереди', () => {
    const result = normalizeRiotEntry({
      queueType: 'RANKED_SOLO_5x5',
      tier: 'PLATINUM',
      rank: 'II',
      leaguePoints: 47,
    });

    expect(result).toMatchObject({
      mode: 'solo-duo',
      scale: 'riot-tier',
      tier: 'PLATINUM',
      division: 'II',
      points: 47,
      source: 'api',
    });
  });

  it('нормализует гибкую очередь', () => {
    const result = normalizeRiotEntry({ queueType: 'RANKED_FLEX_SR', tier: 'GOLD', rank: 'IV', leaguePoints: 0 });
    expect(result?.mode).toBe('flex');
  });

  it('обнуляет дивизион у Master и выше, хотя API присылает I', () => {
    for (const tier of ['MASTER', 'GRANDMASTER', 'CHALLENGER']) {
      const result = normalizeRiotEntry({ queueType: 'RANKED_SOLO_5x5', tier, rank: 'I', leaguePoints: 640 });
      expect(result?.division).toBeNull();
      expect(result?.tier).toBe(tier);
    }
  });

  it('нормализует ранговый TFT', () => {
    const result = normalizeRiotEntry({ queueType: 'RANKED_TFT', tier: 'DIAMOND', rank: 'III', leaguePoints: 12 });
    expect(result?.mode).toBe('tft-ranked');
  });

  it('возвращает null для неизвестной очереди', () => {
    const result = normalizeRiotEntry({ queueType: 'CHERRY', tier: 'GOLD', rank: 'I', leaguePoints: 0 });
    expect(result).toBeNull();
  });

  it('возвращает null для неизвестного тира вместо выдумывания значения', () => {
    const result = normalizeRiotEntry({ queueType: 'RANKED_SOLO_5x5', tier: 'МИФИЧЕСКИЙ', rank: 'I', leaguePoints: 0 });
    expect(result).toBeNull();
  });

  it('сохраняет исходный ответ в raw', () => {
    const entry = { queueType: 'RANKED_SOLO_5x5', tier: 'IRON', rank: 'IV', leaguePoints: 3 };
    expect(normalizeRiotEntry(entry)?.raw).toEqual(entry);
  });
});

describe('parseRiotTier', () => {
  it('разбирает ввод пользователя с дивизионом в любом регистре', () => {
    expect(parseRiotTier('platinum ii')).toEqual({ tier: 'PLATINUM', division: 'II' });
    expect(parseRiotTier('Immortal 2')).toEqual({ tier: 'IMMORTAL', division: 'II' });
  });

  it('разбирает арабские цифры как дивизионы', () => {
    expect(parseRiotTier('GOLD 4')).toEqual({ tier: 'GOLD', division: 'IV' });
  });

  it('разбирает тир без дивизиона', () => {
    expect(parseRiotTier('RADIANT')).toEqual({ tier: 'RADIANT', division: null });
  });

  it('возвращает null на мусоре', () => {
    expect(parseRiotTier('очень высокий')).toBeNull();
    expect(parseRiotTier('')).toBeNull();
  });
});
