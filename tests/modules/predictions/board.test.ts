import { describe, expect, it } from 'vitest';
import { predictionCardButtons, predictionCardText, type CardView } from '../../../src/modules/predictions/board.js';

/** Карточка прогноза: расклад голосов, кнопки, пока приём открыт, и итог после матча. */

const view = (over: Partial<CardView> = {}): CardView => ({
  matchId: 12,
  a: { id: 1, name: 'Альфа', votes: 3 },
  b: { id: 2, name: 'Браво', votes: 1 },
  locked: false,
  winnerId: null,
  ...over,
});

describe('карточка прогноза', () => {
  it('показывает расклад голосов по сторонам', () => {
    const text = predictionCardText(view());

    expect(text).toContain('Матч №12');
    expect(text).toContain('Альфа ▰▰▰▰▱ 3');
    expect(text).toContain('Браво ▰▱▱▱▱ 1');
  });

  it('пока приём открыт — две кнопки со сторонами', () => {
    const [row] = predictionCardButtons(view());
    const buttons = row?.toJSON().components ?? [];

    expect(buttons.map((button) => ('custom_id' in button ? button.custom_id : ''))).toEqual(['pv:12:1', 'pv:12:2']);
  });

  it('матч начался — кнопок нет, приём закрыт', () => {
    const locked = view({ locked: true });

    expect(predictionCardButtons(locked)).toEqual([]);
    expect(predictionCardText(locked)).toContain('Приём закрыт');
  });

  it('после матча — победитель и сколько угадали', () => {
    const text = predictionCardText(view({ winnerId: 2, locked: true }));

    expect(text).toContain('Победа **Браво**. Угадали 1 из 4.');
  });

  it('без голосов полосы пустые, а не NaN', () => {
    expect(predictionCardText(view({ a: { id: 1, name: 'Альфа', votes: 0 }, b: { id: 2, name: 'Браво', votes: 0 } }))).toContain(
      'Альфа ▱▱▱▱▱ 0',
    );
  });
});
