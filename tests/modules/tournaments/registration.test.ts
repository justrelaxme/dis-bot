import { describe, expect, it } from 'vitest';
import {
  EMPTY_GRACE_MS,
  registrationStep,
} from '../../../src/modules/tournaments/discord/registration.js';

/**
 * Время регистрации ручного турнира. Раньше время старта на панели было обещанием, которое
 * никто не исполнял: турнир ждал команды организатора, а висящая регистрация блокировала
 * суточный автомат.
 */

const closesAt = new Date('2026-09-26T18:00:00Z');
const at = (offsetMinutes: number): Date => new Date(closesAt.getTime() + offsetMinutes * 60_000);

describe('шаг регистрации', () => {
  it('задолго до старта — ждём', () => {
    expect(registrationStep(closesAt, at(-60), 0)).toBe('wait');
  });

  /** Тик раз в минуту — напоминание привязано к первой минуте окна и уходит один раз. */
  it('за 15 минут напоминает, и только в эту минуту', () => {
    expect(registrationStep(closesAt, at(-15), 3)).toBe('remind');
    expect(registrationStep(closesAt, at(-14.5), 3)).toBe('remind');
    expect(registrationStep(closesAt, at(-14), 3)).toBe('wait');
    expect(registrationStep(closesAt, at(-16), 3)).toBe('wait');
  });

  it('время пришло и отметились двое — старт', () => {
    expect(registrationStep(closesAt, at(0), 2)).toBe('start');
    expect(registrationStep(closesAt, at(30), 5)).toBe('start');
  });

  /**
   * Отметившихся мало — сразу не отменяем: люди могут подходить. Предупреждение один раз в
   * момент старта, дальше ждём.
   */
  it('играть некому — предупреждает один раз и ждёт', () => {
    expect(registrationStep(closesAt, at(0), 1)).toBe('warn');
    expect(registrationStep(closesAt, at(0.5), 0)).toBe('warn');
    expect(registrationStep(closesAt, at(1), 1)).toBe('wait');
    expect(registrationStep(closesAt, at(90), 1)).toBe('wait');
  });

  it('за время ожидания отметились — стартует, не дожидаясь срока', () => {
    expect(registrationStep(closesAt, at(45), 2)).toBe('start');
  });

  it('два часа после старта и всё ещё некому — отмена', () => {
    const grace = EMPTY_GRACE_MS / 60_000;
    expect(registrationStep(closesAt, at(grace - 1), 1)).toBe('wait');
    expect(registrationStep(closesAt, at(grace), 1)).toBe('cancel');
  });
});
