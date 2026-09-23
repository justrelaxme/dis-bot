import { describe, expect, it } from 'vitest';
import { autoScene, pickFeatured, resolveScene, roundLabel, type CastMatch } from '../../../src/modules/web/cast-logic.js';

/**
 * Что показывать на трансляции. Кастера за пультом может не быть вовсе — значит, сцена обязана
 * выбираться сама, и выбор должен совпадать с тем, что сделал бы человек.
 */

const match = (over: Partial<CastMatch>): CastMatch => ({
  id: 1,
  bracket: 'upper',
  round: 1,
  state: 'ready',
  entrantAId: 1,
  entrantBId: 2,
  liveAt: null,
  ...over,
});

describe('главный матч', () => {
  it('из идущих — самый поздний по сетке', () => {
    const picked = pickFeatured([
      match({ id: 1, round: 1, liveAt: new Date() }),
      match({ id: 2, round: 2, liveAt: new Date() }),
    ]);
    expect(picked?.id).toBe(2);
  });

  it('гранд-финал важнее любого круга', () => {
    const picked = pickFeatured([
      match({ id: 1, round: 3, liveAt: new Date() }),
      match({ id: 9, bracket: 'grand', round: 1, liveAt: new Date() }),
    ]);
    expect(picked?.id).toBe(9);
  });

  it('идущий важнее готового, готовый — важнее ждущего подтверждения', () => {
    expect(pickFeatured([match({ id: 1, round: 3 }), match({ id: 2, round: 1, liveAt: new Date() })])?.id).toBe(2);
    expect(pickFeatured([match({ id: 1, state: 'reported', round: 3 }), match({ id: 2, round: 1 })])?.id).toBe(2);
  });

  it('матч без обоих соперников главным не бывает', () => {
    expect(pickFeatured([match({ entrantBId: null })])).toBeNull();
  });
});

describe('сцена сама', () => {
  it('до старта — «скоро начало», после финала — пьедестал', () => {
    expect(autoScene({ tournamentState: 'registration', featured: null })).toBe('soon');
    expect(autoScene({ tournamentState: 'finished', featured: null })).toBe('podium');
  });

  it('драфт главного матча — драфт, матч начался — табло, иначе — сетка', () => {
    expect(autoScene({ tournamentState: 'running', featured: { live: true, draftActive: true } })).toBe('draft');
    expect(autoScene({ tournamentState: 'running', featured: { live: true, draftActive: false } })).toBe('match');
    expect(autoScene({ tournamentState: 'running', featured: { live: false, draftActive: false } })).toBe('bracket');
    expect(autoScene({ tournamentState: 'running', featured: null })).toBe('bracket');
  });
});

/** Пустой экран в эфире хуже сцены, которую не просили. */
describe('запрошенная сцена', () => {
  const running = { tournamentState: 'running' as const, featured: { live: true, draftActive: false } };

  it('осмысленная — показывается', () => {
    expect(resolveScene('bracket', running)).toBe('bracket');
  });

  it('пьедестал до конца турнира — вместо него автоматическая', () => {
    expect(resolveScene('podium', running)).toBe('match');
  });

  it('табло без матча — вместо него автоматическая', () => {
    expect(resolveScene('match', { tournamentState: 'running', featured: null })).toBe('bracket');
  });
});

describe('подпись круга', () => {
  it('финалы и полуфиналы называются словами', () => {
    expect(roundLabel({ bracket: 'upper', round: 3 }, 3, 0)).toBe('Финал');
    expect(roundLabel({ bracket: 'upper', round: 3 }, 3, 4)).toBe('Финал верхней сетки');
    expect(roundLabel({ bracket: 'upper', round: 2 }, 3, 0)).toBe('Полуфинал');
    expect(roundLabel({ bracket: 'lower', round: 4 }, 3, 4)).toBe('Финал нижней сетки');
    expect(roundLabel({ bracket: 'grand', round: 1 }, 3, 4)).toBe('Гранд-финал');
  });
});
