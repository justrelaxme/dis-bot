import { describe, expect, it } from 'vitest';
import { sharedPlaces, tiedLeaders, type CircuitStanding } from '../../../src/modules/tournaments/services/circuit.js';

const row = (userId: string, points: number, titles: number, best: number): CircuitStanding => ({
  userId,
  name: null,
  points,
  tournaments: 2,
  titles,
  best,
});

/** Равные по всем правилам делят место: таблица не ставит одного выше молча. */
describe('места в таблице серии', () => {
  it('равные по очкам, титулам и лучшему месту делят место', () => {
    expect(sharedPlaces([row('a', 20, 1, 1), row('b', 20, 1, 1), row('c', 12, 0, 2)])).toEqual([1, 1, 3]);
  });

  it('равенство очков при разных титулах — не ничья', () => {
    expect(sharedPlaces([row('a', 20, 2, 1), row('b', 20, 1, 1)])).toEqual([1, 2]);
  });

  it('пустая таблица — пустые места', () => {
    expect(sharedPlaces([])).toEqual([]);
  });
});

describe('лидеры при закрытии сезона', () => {
  it('один лидер — один', () => {
    expect(tiedLeaders([row('a', 20, 1, 1), row('b', 18, 1, 1)]).map((r) => r.userId)).toEqual(['a']);
  });

  it('ничья на вершине — все равные', () => {
    expect(tiedLeaders([row('a', 20, 1, 1), row('b', 20, 1, 1), row('c', 20, 0, 2)]).map((r) => r.userId)).toEqual(['a', 'b']);
  });

  it('пустой сезон — лидеров нет', () => {
    expect(tiedLeaders([])).toEqual([]);
  });
});
