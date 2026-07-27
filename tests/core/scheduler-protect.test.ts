import { describe, expect, it, vi } from 'vitest';

/** Перехватываем аргументы конструктора Cron, не запуская настоящее расписание. */
const constructorCalls: Array<{ expression: string; options: Record<string, unknown> }> = [];

vi.mock('croner', () => ({
  Cron: class {
    constructor(expression: string, options: Record<string, unknown>) {
      constructorCalls.push({ expression, options });
    }
    stop(): void {}
  },
}));

import type { Config } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import type { ModuleContext } from '../../src/core/module.js';
import { buildRegistry } from '../../src/core/registry.js';
import { createScheduler } from '../../src/core/scheduler.js';

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

    createScheduler({ registry, ctx }).start();

    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]?.options['protect']).toBe(true);
    expect(constructorCalls[0]?.expression).toBe('*/30 * * * *');
  });

  it('передаёт имя джобы, чтобы её было видно в диагностике croner', () => {
    constructorCalls.length = 0;
    const registry = buildRegistry([
      { name: 'm', jobs: [{ name: 'identity:rank-sync', cron: '*/30 * * * *', run: async () => {} }] },
    ]);

    createScheduler({ registry, ctx }).start();

    expect(constructorCalls[0]?.options['name']).toBe('identity:rank-sync');
  });
});
