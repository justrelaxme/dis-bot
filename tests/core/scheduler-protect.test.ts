import { describe, expect, it, vi } from 'vitest';

/** Перехватываем аргументы конструктора Cron, не запуская настоящее расписание. */
const constructorCalls: Array<{ expression: string; options: Record<string, unknown> }> = [];
const stopMocks: ReturnType<typeof vi.fn>[] = [];

vi.mock('croner', () => ({
  Cron: class {
    stop = vi.fn();
    constructor(expression: string, options: Record<string, unknown>) {
      constructorCalls.push({ expression, options });
      stopMocks.push(this.stop);
    }
  },
}));

import type { Config } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import type { ModuleContext } from '../../src/core/module.js';
import { buildRegistry } from '../../src/core/registry.js';
import { createScheduler } from '../../src/core/scheduler.js';
import { createShutdown } from '../../src/core/shutdown.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);
const ctx = { logger } as unknown as ModuleContext;

describe('createScheduler: защита от наложения запусков', () => {
  it('передаёт croner protect: true для каждой джобы', () => {
    // Без protect медленная джоба синхронизации рангов запустится параллельно с собой
    // и удвоит расход лимита внешнего API — то есть сломает ровно то, ради чего
    // существует весь rate limiting. Опция обязана быть.
    constructorCalls.length = 0;
    const registry = buildRegistry([
      { name: 'm', jobs: [{ name: 'sync', cron: '*/30 * * * *', run: async () => {} }] },
    ]);

    createScheduler({ registry, ctx, shutdown: createShutdown({ logger }) }).start();

    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]?.options['protect']).toBe(true);
    expect(constructorCalls[0]?.expression).toBe('*/30 * * * *');
  });

  it('передаёт имя джобы, чтобы её было видно в диагностике croner', () => {
    constructorCalls.length = 0;
    const registry = buildRegistry([
      { name: 'm', jobs: [{ name: 'identity:rank-sync', cron: '*/30 * * * *', run: async () => {} }] },
    ]);

    createScheduler({ registry, ctx, shutdown: createShutdown({ logger }) }).start();

    expect(constructorCalls[0]?.options['name']).toBe('identity:rank-sync');
  });

  it('останавливает все джобы по stop', () => {
    // Утверждение not.toThrow() проходит и если тело stop() заменить на {} —
    // здесь проверяем, что croner.stop() реально вызван на каждом созданном инстансе.
    constructorCalls.length = 0;
    stopMocks.length = 0;
    const registry = buildRegistry([
      { name: 'm', jobs: [{ name: 'sync', cron: '*/30 * * * *', run: async () => {} }] },
    ]);
    const scheduler = createScheduler({ registry, ctx, shutdown: createShutdown({ logger }) });

    scheduler.start();
    scheduler.stop();

    expect(stopMocks).toHaveLength(1);
    for (const stop of stopMocks) {
      expect(stop).toHaveBeenCalledOnce();
    }
  });
});
