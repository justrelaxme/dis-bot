import { describe, expect, it } from 'vitest';
import { closureNote } from '../../../../src/modules/tournaments/discord/closing.js';

/**
 * Оговорка под итогом турнира. Раньше под каждым итогом стояло «принято по молчанию
 * соперника», хотя так закрывалась лишь часть финалов: подтверждённый кнопкой результат
 * выглядел спорным, а решение организатора — чужим.
 */
describe('оговорка под итогом', () => {
  it('про молчание говорит только тогда, когда финал принят молчанием', () => {
    expect(closureNote('auto-confirm')).toMatch(/молчанию/);
  });

  it('подтверждённый соперником финал оговорок не требует', () => {
    expect(closureNote('confirm')).toBeNull();
  });

  it('решение организатора так и названо', () => {
    expect(closureNote('resolve')).toMatch(/организатор/);
    expect(closureNote('walkover')).toMatch(/без игры/);
  });

  it('проверенный по данным матча финал так и назван', () => {
    expect(closureNote('verified')).toMatch(/данными матча/);
  });

  it('неизвестно как закрыт — молчим, а не выдумываем', () => {
    expect(closureNote(null)).toBeNull();
  });
});
