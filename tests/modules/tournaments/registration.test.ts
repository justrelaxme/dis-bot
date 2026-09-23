import { describe, expect, it } from 'vitest';
import {
  EMPTY_GRACE_MS,
  REMINDER_LEAD_MS,
  registrationStep,
} from '../../../src/modules/tournaments/discord/registration.js';

/**
 * Время регистрации ручного турнира. Раньше время старта на панели было обещанием, которое
 * никто не исполнял: турнир ждал команды организатора, а висящая регистрация блокировала
 * суточный автомат.
 */

const closesAt = new Date('2026-09-26T18:00:00Z');
const at = (offsetMinutes: number): Date => new Date(closesAt.getTime() + offsetMinutes * 60_000);
const grace = EMPTY_GRACE_MS / 60_000;
const lead = REMINDER_LEAD_MS / 60_000;

describe('шаг регистрации', () => {
  it('задолго до старта — ждём', () => {
    expect(registrationStep(closesAt, at(-60), 0)).toBe('wait');
    expect(registrationStep(closesAt, at(-lead - 1), 0)).toBe('wait');
  });

  /**
   * Напоминание отвечает на всё окно, а не на одну минуту: бот мог быть выключен ровно в ту
   * минуту. Что оно уже ушло, помнит вызывающий.
   */
  it('в последние 15 минут — напомнить, на всём окне', () => {
    expect(registrationStep(closesAt, at(-lead), 3)).toBe('remind');
    expect(registrationStep(closesAt, at(-7), 3)).toBe('remind');
    expect(registrationStep(closesAt, at(-0.5), 3)).toBe('remind');
  });

  it('время пришло и отметились двое — старт', () => {
    expect(registrationStep(closesAt, at(0), 2)).toBe('start');
    expect(registrationStep(closesAt, at(30), 5)).toBe('start');
  });

  it('играть некому — предупредить, и так всё время ожидания', () => {
    expect(registrationStep(closesAt, at(0), 1)).toBe('warn');
    expect(registrationStep(closesAt, at(90), 0)).toBe('warn');
  });

  it('за время ожидания отметились — стартует, не дожидаясь срока', () => {
    expect(registrationStep(closesAt, at(45), 2)).toBe('start');
  });

  it('два часа после старта и всё ещё некому — отмена', () => {
    expect(registrationStep(closesAt, at(grace - 1), 1)).toBe('warn');
    expect(registrationStep(closesAt, at(grace), 1)).toBe('cancel');
  });

  /**
   * Такую регистрацию находит только бот, поднявшийся после долгого простоя. Стартовать турнир,
   * назначенный на вчера, — значит звать людей, которые давно разошлись.
   */
  it('давно просроченная регистрация отменяется, даже если отметившихся хватает', () => {
    expect(registrationStep(closesAt, at(grace + 60 * 24), 8)).toBe('cancel');
  });
});
