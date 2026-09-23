import { describe, expect, it } from 'vitest';
import { createProgressionService } from '../../../src/modules/progression/service.js';
import { applyVoiceTransition } from '../../../src/modules/progression/voice.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();

const MINUTE = 60_000;

/**
 * Голосовые сессии против настоящего Postgres: сессия одна на человека (уникальность в
 * схеме), и именно на этом ломался переход между каналами — открытие перезаписывало
 * время входа, а закрытие удаляло строку независимо от канала.
 */
describe('голосовые сессии', () => {
  it('переход между каналами засчитывает минуты в канале, из которого ушли', async () => {
    const progression = createProgressionService({ db: pg.db });
    const guildId = '71000000000000001';
    const userId = '72000000000000001';
    const t0 = new Date('2026-01-01T20:00:00Z');

    await applyVoiceTransition(progression, guildId, userId, null, 'канал-а', t0);

    const switched = await applyVoiceTransition(
      progression,
      guildId,
      userId,
      'канал-а',
      'канал-б',
      new Date(t0.getTime() + 30 * MINUTE),
    );
    expect(switched).toBe(30);

    // Сессия в новом канале пережила переход и считается с момента перехода.
    const left = await applyVoiceTransition(
      progression,
      guildId,
      userId,
      'канал-б',
      null,
      new Date(t0.getTime() + 50 * MINUTE),
    );
    expect(left).toBe(20);
  });

  it('мут в том же канале не обнуляет сессию', async () => {
    const progression = createProgressionService({ db: pg.db });
    const guildId = '71000000000000002';
    const userId = '72000000000000002';
    const t0 = new Date('2026-01-01T20:00:00Z');

    await applyVoiceTransition(progression, guildId, userId, null, 'канал-а', t0);
    const muted = await applyVoiceTransition(
      progression,
      guildId,
      userId,
      'канал-а',
      'канал-а',
      new Date(t0.getTime() + 10 * MINUTE),
    );
    expect(muted).toBe(0);

    const left = await applyVoiceTransition(
      progression,
      guildId,
      userId,
      'канал-а',
      null,
      new Date(t0.getTime() + 25 * MINUTE),
    );
    expect(left).toBe(25);
  });

  it('закрытие без открытой сессии даёт ноль, а не ошибку', async () => {
    const progression = createProgressionService({ db: pg.db });
    expect(await progression.closeVoiceSession('71000000000000003', '72000000000000003', new Date())).toBe(0);
  });
});
