import { describe, expect, it } from 'vitest';
import {
  BASE_REWARD,
  MAX_MULTIPLIER,
  accuracy,
  predictionPayout,
} from '../../../src/modules/predictions/payout.js';

/**
 * Награда за прогноз. Правило простое, но ошибка в нём выдаёт монеты, а выданные монеты уже
 * потратят — отменить это будет нечем. Поэтому проверяются именно границы: неугаданное,
 * единственный угадавший, все угадавшие и предел множителя.
 */

describe('награда за прогноз', () => {
  it('не угадал — ноль, и это полноценный исход, а не ошибка', () => {
    expect(predictionPayout({ correct: false, votesForPick: 1, votesTotal: 10 })).toBe(0);
    expect(predictionPayout({ correct: false, votesForPick: 9, votesTotal: 10 })).toBe(0);
  });

  it('угадали все — награда базовая', () => {
    expect(predictionPayout({ correct: true, votesForPick: 10, votesTotal: 10 })).toBe(BASE_REWARD);
  });

  it('угадала половина — награда двойная', () => {
    expect(predictionPayout({ correct: true, votesForPick: 5, votesTotal: 10 })).toBe(BASE_REWARD * 2);
  });

  /**
   * Смысл прогноза в том, чтобы решиться назвать неочевидное. Если награда одинакова, все
   * называют фаворита и угадывать становится незачем.
   */
  it('угадал один из немногих — награда больше', () => {
    const lonely = predictionPayout({ correct: true, votesForPick: 1, votesTotal: 4 });
    const crowd = predictionPayout({ correct: true, votesForPick: 3, votesTotal: 4 });

    expect(lonely).toBeGreaterThan(crowd);
  });

  /**
   * Предел обязателен: без него единственный угадавший из сотни получил бы тысячу базовых
   * наград за один матч — больше, чем даёт победа в турнире, и тогда играть выгоднее не играя.
   */
  it('множитель ограничен сверху', () => {
    expect(predictionPayout({ correct: true, votesForPick: 1, votesTotal: 100 })).toBe(
      BASE_REWARD * MAX_MULTIPLIER,
    );
    expect(predictionPayout({ correct: true, votesForPick: 1, votesTotal: 1_000 })).toBe(
      BASE_REWARD * MAX_MULTIPLIER,
    );
  });

  it('награда никогда не бывает отрицательной или дробной', () => {
    for (let total = 1; total <= 40; total += 1) {
      for (let forPick = 1; forPick <= total; forPick += 1) {
        const reward = predictionPayout({ correct: true, votesForPick: forPick, votesTotal: total });

        expect(Number.isInteger(reward), `дробь при ${forPick}/${total}`).toBe(true);
        expect(reward, `отрицательная при ${forPick}/${total}`).toBeGreaterThan(0);
        expect(reward).toBeLessThanOrEqual(BASE_REWARD * MAX_MULTIPLIER);
      }
    }
  });

  it('бессмысленные входные данные не приносят монет', () => {
    expect(predictionPayout({ correct: true, votesForPick: 0, votesTotal: 0 })).toBe(0);
    expect(predictionPayout({ correct: true, votesForPick: 0, votesTotal: 5 })).toBe(0);
  });

  it('базовая награда настраивается, не меняя правило', () => {
    expect(predictionPayout({ correct: true, votesForPick: 2, votesTotal: 4, base: 50 })).toBe(100);
  });
});

describe('точность прогнозиста', () => {
  it('считается в процентах', () => {
    expect(accuracy(7, 10)).toBe(70);
    expect(accuracy(1, 3)).toBe(33);
    expect(accuracy(3, 3)).toBe(100);
  });

  it('без попыток точности нет, а не сто процентов', () => {
    expect(accuracy(0, 0)).toBe(0);
  });
});
