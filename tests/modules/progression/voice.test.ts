import { describe, expect, it } from 'vitest';
import { voiceTransition } from '../../../src/modules/progression/voice.js';

describe('переходы голосовой сессии', () => {
  it('при переключении канала сначала закрывает старую сессию, потом открывает новую', () => {
    // Обратный порядок терял все минуты: закрытие меряло только что открытую сессию.
    expect(voiceTransition('канал-а', 'канал-б')).toEqual([
      { kind: 'close', channelId: 'канал-а' },
      { kind: 'open', channelId: 'канал-б' },
    ]);
  });

  it('вход только открывает, выход только закрывает', () => {
    expect(voiceTransition(null, 'канал-а')).toEqual([{ kind: 'open', channelId: 'канал-а' }]);
    expect(voiceTransition('канал-а', null)).toEqual([{ kind: 'close', channelId: 'канал-а' }]);
  });

  it('мут и наушники в том же канале сессию не трогают', () => {
    expect(voiceTransition('канал-а', 'канал-а')).toEqual([]);
    expect(voiceTransition(null, null)).toEqual([]);
  });
});
