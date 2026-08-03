import { describe, expect, it } from 'vitest';
import { formatScore, parseScore, scoreDisagrees } from '../../../src/modules/tournaments/score.js';

/**
 * Счёт вводят руками, и проверить его боту нечем. Значит вся защита здесь — разбор строки и
 * согласие с названным победителем. Ошибка в эту сторону остаётся в сетке и зале славы
 * навсегда, поэтому проверяем именно отказы, а не только удачный случай.
 */

describe('разбор счёта', () => {
  it('принимает разделители, которые человек действительно набирает', () => {
    for (const raw of ['13:8', '13-8', ' 13 : 8 ', '13–8', '13—8']) {
      expect(parseScore(raw), raw).toEqual({ ok: true, score: { a: 13, b: 8 } });
    }
  });

  it('понимает счёт по картам', () => {
    expect(parseScore('2:1')).toEqual({ ok: true, score: { a: 2, b: 1 } });
    expect(parseScore('0:2')).toEqual({ ok: true, score: { a: 0, b: 2 } });
  });

  it('мусор отклоняет с внятным объяснением', () => {
    for (const raw of ['', 'победа', '13', '13:', ':8', '1:2:3', '13 8']) {
      const result = parseScore(raw);
      expect(result.ok, raw).toBe(false);
      expect(result.ok === false && result.reason).toContain('13:8');
    }
  });

  /** Ничья невозможна: матч не закрывается без победителя, и «13:13» это опечатка. */
  it('ничью не принимает', () => {
    const result = parseScore('13:13');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('Ничьей');
  });

  it('слишком большие числа отклоняет как опечатку', () => {
    const result = parseScore('130:8');

    expect(result.ok).toBe(false);
  });
});

describe('согласие счёта с победителем', () => {
  const names = { a: 'Пантеры', b: 'Кобры' };

  it('у победителя больше — возражений нет', () => {
    expect(scoreDisagrees({ a: 13, b: 8 }, 'a', names)).toBeNull();
    expect(scoreDisagrees({ a: 8, b: 13 }, 'b', names)).toBeNull();
  });

  /**
   * Счёт, противоречащий победителю, — либо опечатка, либо попытка подправить историю. И то и
   * другое надо остановить до записи: в сетке это останется навсегда.
   */
  it('счёт против победителя отклоняется и называет, что перепутано', () => {
    const reason = scoreDisagrees({ a: 13, b: 8 }, 'b', names);

    expect(reason).toContain('выиграл Пантеры');
    expect(reason).toContain('указан Кобры');
  });

  it('обратный случай тоже ловится', () => {
    expect(scoreDisagrees({ a: 8, b: 13 }, 'a', names)).toContain('выиграл Кобры');
  });
});

describe('показ счёта', () => {
  it('невведённый счёт не показывается', () => {
    // Придумывать счёт нельзя: пустая строка честнее выдуманных цифр.
    expect(formatScore(null, null)).toBe('');
    expect(formatScore(13, null)).toBe('');
    expect(formatScore(null, 8)).toBe('');
  });

  it('введённый показывается как есть', () => {
    expect(formatScore(13, 8)).toBe('13:8');
    expect(formatScore(0, 2)).toBe('0:2');
  });
});
