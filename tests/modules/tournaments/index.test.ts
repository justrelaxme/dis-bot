import { Cron } from 'croner';
import { describe, expect, it } from 'vitest';
import type { Database } from '../../../src/core/db/client.js';
import { createTournamentsModule } from '../../../src/modules/tournaments/index.js';

describe('модуль tournaments', () => {
  it('регистрирует /tournament и джобу финализации, не трогая БД при сборке модуля', () => {
    // {} as Database — тот же приём, что и в scripts/deploy-commands.ts: конструирование
    // модуля не должно вызывать ни одного метода БД, иначе регистрация команд (у которой
    // БД — пустая заглушка) упала бы ещё до первого HTTP-запроса к Discord.
    const db = {} as unknown as Database;
    const botModule = createTournamentsModule({ db });

    expect(botModule.name).toBe('tournaments');
    expect(botModule.commands?.map((c) => c.builder.name)).toEqual(['tournament']);
    expect(botModule.jobs?.map((j) => j.name)).toEqual(['tournaments:poll-finalize']);
  });

  it('объявляет корректное cron-выражение для джобы финализации', () => {
    const db = {} as unknown as Database;
    const botModule = createTournamentsModule({ db });
    const job = botModule.jobs?.[0];
    expect(job).toBeDefined();

    // Croner бросает на некорректном выражении — тем же способом планировщик
    // (src/core/scheduler.ts) проверяет джобы модулей при старте.
    const cron = new Cron(job?.cron ?? '', { protect: true, paused: true, name: 'test-tournaments-poll-finalize' });
    expect(cron.getPattern()).toBeTruthy();
    cron.stop();
  });
});
