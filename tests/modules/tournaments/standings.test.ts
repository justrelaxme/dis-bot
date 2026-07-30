import { describe, expect, it } from 'vitest';
import { standingsOf, type StandingMatch } from '../../../src/modules/tournaments/standings.js';

/**
 * Места выводятся из сетки. Проверяем именно вывод, потому что ошибка здесь попадёт в зал
 * славы навсегда: чемпион, названный неверно, остаётся в записи, а переиграть турнир нельзя.
 */

function match(
  bracket: StandingMatch['bracket'],
  round: number,
  slot: number,
  a: number | null,
  b: number | null,
  winner: number | null,
): StandingMatch {
  return { bracket, round, slot, entrantAId: a, entrantBId: b, winnerEntrantId: winner, state: 'confirmed' };
}

describe('места при выбывании', () => {
  // Четвёрка: полуфиналы (1-4) и (2-3), финал (1-2). Побеждает старший.
  const bracket: StandingMatch[] = [
    match('upper', 1, 0, 1, 4, 1),
    match('upper', 1, 1, 2, 3, 2),
    match('upper', 2, 0, 1, 2, 1),
  ];

  it('чемпион и второе место берутся из финала', () => {
    const places = standingsOf(bracket);

    expect(places.championId).toBe(1);
    expect(places.runnerUpId).toBe(2);
  });

  /**
   * Ключевое решение: третьего места на выбывание нет. Два проигравших полуфинала между
   * собой не играли, и назначать одного из них третьим значило бы выдумать результат.
   */
  it('третьего места нет, а полуфиналисты возвращаются оба', () => {
    const places = standingsOf(bracket);

    expect(places.thirdId).toBeNull();
    expect(places.semifinalistIds.sort()).toEqual([3, 4]);
  });
});

describe('места при двойном устранении', () => {
  // Четвёрка: верхняя сетка, нижняя из двух кругов, гранд-финал.
  const bracket: StandingMatch[] = [
    match('upper', 1, 0, 1, 4, 1),
    match('upper', 1, 1, 2, 3, 2),
    match('upper', 2, 0, 1, 2, 1),
    match('lower', 1, 0, 4, 3, 3),
    match('lower', 2, 0, 3, 2, 2),
    match('grand', 1, 0, 1, 2, 1),
  ];

  it('чемпион и второе место берутся из гранд-финала, а не из финала верхней сетки', () => {
    const places = standingsOf(bracket);

    expect(places.championId).toBe(1);
    expect(places.runnerUpId).toBe(2);
  });

  it('третье место — проигравший финала нижней сетки', () => {
    const places = standingsOf(bracket);

    // Третий выиграл больше всех, кроме двоих: он прошёл всю нижнюю сетку и упал в её финале.
    expect(places.thirdId).toBe(3);
    expect(places.semifinalistIds).toEqual([]);
  });
});

describe('незаконченное и пустое', () => {
  it('без матчей мест нет', () => {
    expect(standingsOf([])).toEqual({
      championId: null,
      runnerUpId: null,
      thirdId: null,
      semifinalistIds: [],
    });
  });

  it('несыгранный финал не даёт чемпиона', () => {
    const places = standingsOf([
      match('upper', 1, 0, 1, 4, 1),
      match('upper', 1, 1, 2, 3, 2),
      match('upper', 2, 0, 1, 2, null),
    ]);

    expect(places.championId).toBeNull();
    expect(places.runnerUpId).toBeNull();
    // Полуфиналы сыграны — значит и полуфиналисты известны, даже пока финал идёт.
    expect(places.semifinalistIds.sort()).toEqual([3, 4]);
  });

  it('победитель после прохода без игры тоже считается', () => {
    const places = standingsOf([match('upper', 1, 0, 7, null, 7)]);

    expect(places.championId).toBe(7);
    // Проигравшего не было — значит второго места нет.
    expect(places.runnerUpId).toBeNull();
  });
});
