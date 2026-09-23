import { describe, expect, it } from 'vitest';
import { circuitPoints, placementsOf } from '../../../src/modules/tournaments/placements.js';
import type { StandingMatch } from '../../../src/modules/tournaments/standings.js';

/** Места всех участников — для очков сезонной серии. */

describe('места на выбывание', () => {
  // 8 участников: 1 чемпион, 2 финалист, 3–4 полуфиналы, 5–8 первый круг.
  const matches: StandingMatch[] = [
    { bracket: 'upper', round: 1, slot: 0, entrantAId: 1, entrantBId: 8, winnerEntrantId: 1, state: 'confirmed' },
    { bracket: 'upper', round: 1, slot: 1, entrantAId: 4, entrantBId: 5, winnerEntrantId: 4, state: 'confirmed' },
    { bracket: 'upper', round: 1, slot: 2, entrantAId: 2, entrantBId: 7, winnerEntrantId: 2, state: 'confirmed' },
    { bracket: 'upper', round: 1, slot: 3, entrantAId: 3, entrantBId: 6, winnerEntrantId: 3, state: 'confirmed' },
    { bracket: 'upper', round: 2, slot: 0, entrantAId: 1, entrantBId: 4, winnerEntrantId: 1, state: 'confirmed' },
    { bracket: 'upper', round: 2, slot: 1, entrantAId: 2, entrantBId: 3, winnerEntrantId: 2, state: 'confirmed' },
    { bracket: 'upper', round: 3, slot: 0, entrantAId: 1, entrantBId: 2, winnerEntrantId: 1, state: 'confirmed' },
  ];

  it('чемпион, финалист, полосы 3–4 и 5–8', () => {
    const places = new Map(placementsOf(matches).map((row) => [row.entrantId, `${row.place}-${row.placeTo}`]));

    expect(places.get(1)).toBe('1-1');
    expect(places.get(2)).toBe('2-2');
    expect(places.get(4)).toBe('3-4');
    expect(places.get(3)).toBe('3-4');
    expect(places.get(8)).toBe('5-8');
    expect(places.size).toBe(8);
  });

  it('недоигранный турнир мест не имеет', () => {
    const unfinished = matches.map((match) =>
      match.round === 3 ? { ...match, winnerEntrantId: null, state: 'ready' } : match,
    );
    expect(placementsOf(unfinished)).toEqual([]);
  });

  /** Пропуск в сетке — не поражение: получивший его выбывает там, где проиграл по-настоящему. */
  it('пропуск первого круга не делает никого проигравшим', () => {
    const withBye: StandingMatch[] = [
      { bracket: 'upper', round: 1, slot: 0, entrantAId: 1, entrantBId: null, winnerEntrantId: 1, state: 'walkover' },
      { bracket: 'upper', round: 1, slot: 1, entrantAId: 2, entrantBId: 3, winnerEntrantId: 2, state: 'confirmed' },
      { bracket: 'upper', round: 2, slot: 0, entrantAId: 1, entrantBId: 2, winnerEntrantId: 2, state: 'confirmed' },
    ];
    const places = new Map(placementsOf(withBye).map((row) => [row.entrantId, row.place]));

    expect(places.get(2)).toBe(1);
    expect(places.get(1)).toBe(2);
    expect(places.get(3)).toBe(3);
  });
});

describe('места при двойном устранении', () => {
  // 4 участника: верх 1–4, 2–3; финал верха 1–2; низ: 4–3, потом проигравший финала верха.
  const matches: StandingMatch[] = [
    { bracket: 'upper', round: 1, slot: 0, entrantAId: 1, entrantBId: 4, winnerEntrantId: 1, state: 'confirmed' },
    { bracket: 'upper', round: 1, slot: 1, entrantAId: 2, entrantBId: 3, winnerEntrantId: 2, state: 'confirmed' },
    { bracket: 'upper', round: 2, slot: 0, entrantAId: 1, entrantBId: 2, winnerEntrantId: 1, state: 'confirmed' },
    { bracket: 'lower', round: 1, slot: 0, entrantAId: 4, entrantBId: 3, winnerEntrantId: 3, state: 'confirmed' },
    { bracket: 'lower', round: 2, slot: 0, entrantAId: 2, entrantBId: 3, winnerEntrantId: 2, state: 'confirmed' },
    { bracket: 'grand', round: 1, slot: 0, entrantAId: 1, entrantBId: 2, winnerEntrantId: 1, state: 'confirmed' },
  ];

  it('проигрыш в верхней сетке не выбивает — место по тому, где выбыл', () => {
    const places = new Map(placementsOf(matches).map((row) => [row.entrantId, row.place]));

    expect(places.get(1)).toBe(1);
    expect(places.get(2)).toBe(2);
    expect(places.get(3)).toBe(3);
    expect(places.get(4)).toBe(4);
  });
});

describe('очки серии', () => {
  it('чемпион восьмерых: семь позади, одно за участие, пять за титул', () => {
    expect(circuitPoints({ place: 1, placeTo: 1 }, 8)).toBe(13);
  });

  it('полоса считается по худшему месту', () => {
    expect(circuitPoints({ place: 3, placeTo: 4 }, 8)).toBe(5);
    expect(circuitPoints({ place: 5, placeTo: 8 }, 8)).toBe(1);
  });

  it('победа в большом поле стоит больше, чем в маленьком', () => {
    expect(circuitPoints({ place: 1, placeTo: 1 }, 16)).toBeGreaterThan(circuitPoints({ place: 1, placeTo: 1 }, 4));
  });
});
