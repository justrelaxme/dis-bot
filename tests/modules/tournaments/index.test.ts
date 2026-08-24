import { Cron } from 'croner';
import { describe, expect, it } from 'vitest';
import type { Cache } from '../../../src/core/cache.js';
import type { Config } from '../../../src/core/config.js';
import type { Database } from '../../../src/core/db/client.js';
import { EventBus } from '../../../src/core/events/bus.js';
import { createLogger } from '../../../src/core/logger.js';
import { createTournamentsModule } from '../../../src/modules/tournaments/index.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

function moduleWith() {
  // {} as Database — тот же приём, что и в scripts/deploy-commands.ts: конструирование
  // модуля не должно вызывать ни одного метода БД, иначе регистрация команд (у которой
  // БД — пустая заглушка) упала бы ещё до первого HTTP-запроса к Discord.
  const db = {} as unknown as Database;
  return createTournamentsModule({
    db,
    logger,
    bus: new EventBus(logger),
    // Кэш такой же заглушкой: справочник героев запрашивается при создании драфта, а не
    // при сборке модуля, и ни один метод здесь не вызывается.
    cache: {} as unknown as Cache,
    publicBaseUrl: 'https://bot.example.com',
  });
}

describe('модуль tournaments', () => {
  it('регистрирует команды турниров и джобы, не трогая БД при сборке модуля', () => {
    const botModule = moduleWith();

    expect(botModule.name).toBe('tournaments');
    expect(botModule.commands?.map((c) => c.builder.name).sort()).toEqual([
      'checkin',
      'match',
      'stats',
      'team',
      'tournament',
    ]);
    expect(botModule.jobs?.map((j) => j.name).sort()).toEqual([
      'tournaments:abandon',
      'tournaments:auto-confirm',
      'tournaments:cycle',
      'tournaments:draft-timeout',
      'tournaments:poll-finalize',
    ]);
    // Кнопки состава, подтверждение результата и подсказки имён форматов обслуживает сам
    // модуль: роутер ядра занимается только slash-командами. Оба обработчика слушают одно и
    // то же событие — Discord присылает и нажатия, и запрос автодополнения как interactionCreate.
    expect(botModule.events?.map((e) => e.event)).toEqual(['interactionCreate', 'interactionCreate']);
  });

  it('объявляет корректные cron-выражения для своих джоб', () => {
    const jobs = moduleWith().jobs ?? [];
    expect(jobs.length).toBeGreaterThan(0);

    for (const job of jobs) {
      // Croner бросает на некорректном выражении — тем же способом планировщик
      // (src/core/scheduler.ts) проверяет джобы модулей при старте.
      const cron = new Cron(job.cron, { protect: true, paused: true, name: `test-${job.name}` });
      expect(cron.getPattern()).toBeTruthy();
      cron.stop();
    }
  });
});
