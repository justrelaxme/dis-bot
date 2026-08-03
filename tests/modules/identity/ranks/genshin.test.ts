import { describe, expect, it } from 'vitest';
import { rankScore } from '../../../../src/modules/identity/ranks/compare.js';
import { ABYSS_FLOORS, formatAbyss, normalizeAbyssRank } from '../../../../src/modules/identity/ranks/genshin.js';

describe('прогресс Витой Бездны вместо ранга', () => {
  it('этаж становится тиром, зал — дивизионом', () => {
    const rank = normalizeAbyssRank({ towerFloorIndex: 12, towerLevelIndex: 3 });

    expect(rank?.tier).toBe('12');
    expect(rank?.division).toBe('3');
    expect(rank?.scale).toBe('genshin-abyss');
    expect(rank?.mode).toBe('genshin-abyss');
    expect(rank?.source).toBe('api');
  });

  it('без прогресса Бездны ранга нет — это законное состояние нового аккаунта', () => {
    expect(normalizeAbyssRank({})).toBeNull();
    expect(normalizeAbyssRank({ towerFloorIndex: null })).toBeNull();
  });

  /** Enka присылает и нулевой этаж, и тринадцатый: ни того, ни другого в игре нет. */
  it('этаж вне двенадцати не превращается в ранг', () => {
    expect(normalizeAbyssRank({ towerFloorIndex: 0 })).toBeNull();
    expect(normalizeAbyssRank({ towerFloorIndex: 13 })).toBeNull();
  });

  it('зал вне трёх зажимается: четвёртого зала на этаже не бывает', () => {
    expect(normalizeAbyssRank({ towerFloorIndex: 9, towerLevelIndex: 7 })?.division).toBe('3');
    expect(normalizeAbyssRank({ towerFloorIndex: 9, towerLevelIndex: 0 })?.division).toBe('1');
  });

  it('без зала считается первый: этаж начат, а не пройден', () => {
    expect(normalizeAbyssRank({ towerFloorIndex: 11 })?.division).toBe('1');
  });

  /**
   * Главное свойство шкалы: сравнимость. Пока Бездна не была отдельной шкалой, этаж «12»
   * искался в тирах Riot, не находился, и rankScore выдавал нуль — то есть игрок, прошедший
   * всю Бездну, стоял в лидерборде рядом с тем, кто её не открывал.
   */
  it('этажи выстраиваются по возрастанию, залы — внутри этажа', () => {
    const score = (floor: number, chamber: number): number => {
      const rank = normalizeAbyssRank({ towerFloorIndex: floor, towerLevelIndex: chamber });
      if (!rank) throw new Error(`этаж ${floor}-${chamber} не разобрался`);
      return rankScore(rank);
    };

    expect(score(12, 3)).toBeGreaterThan(score(12, 1));
    expect(score(12, 1)).toBeGreaterThan(score(11, 3));
    // Нуль в rankScore означает «ранга нет». Пока этаж считался позицией в списке, первый
    // давал ровно нуль — и прошедший 1-1 был неотличим от того, кто Бездну не открывал.
    expect(score(1, 1)).toBeGreaterThan(0);
    // Выдуманный этаж рангом не становится, даже если зал в нём указан.
    expect(rankScore({ mode: 'genshin-abyss', scale: 'genshin-abyss', tier: '13', division: '2', points: null, source: 'api', raw: {} })).toBe(0);
  });

  it('этажей ровно двенадцать и они по порядку', () => {
    expect(ABYSS_FLOORS).toHaveLength(12);
    expect(ABYSS_FLOORS.map(Number)).toEqual([...ABYSS_FLOORS].map((_, index) => index + 1));
  });

  it('пишется так, как её называют игроки', () => {
    const rank = normalizeAbyssRank({ towerFloorIndex: 12, towerLevelIndex: 3 });
    if (!rank) throw new Error('ранг не разобрался');
    expect(formatAbyss(rank)).toBe('12-3');
  });
});
