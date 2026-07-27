import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import type { ModuleContext } from '../../src/core/module.js';
import { buildRegistry } from '../../src/core/registry.js';
import { createScheduler } from '../../src/core/scheduler.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);
const ctx = { logger } as unknown as ModuleContext;

describe('createScheduler', () => {
  it('выполняет джобу по имени через runOnce', async () => {
    const run = vi.fn(async () => {});
    const registry = buildRegistry([{ name: 'm', jobs: [{ name: 'sync', cron: '*/30 * * * *', run }] }]);
    const scheduler = createScheduler({ registry, ctx });

    await scheduler.runOnce('sync');

    expect(run).toHaveBeenCalledOnce();
  });

  it('падает на неизвестном имени джобы', async () => {
    const registry = buildRegistry([{ name: 'm' }]);
    const scheduler = createScheduler({ registry, ctx });

    await expect(scheduler.runOnce('нет-такой')).rejects.toThrow(/нет-такой/);
  });

  it('не пробрасывает ошибку джобы наружу', async () => {
    const registry = buildRegistry([
      {
        name: 'm',
        jobs: [
          {
            name: 'broken',
            cron: '*/30 * * * *',
            run: async () => {
              throw new Error('джоба сломалась');
            },
          },
        ],
      },
    ]);
    const scheduler = createScheduler({ registry, ctx });

    await expect(scheduler.runOnce('broken')).resolves.toBeUndefined();
  });

  it('отвергает некорректное выражение cron при старте', () => {
    const registry = buildRegistry([{ name: 'm', jobs: [{ name: 'bad', cron: 'вообще-не-cron', run: async () => {} }] }]);
    const scheduler = createScheduler({ registry, ctx });

    expect(() => scheduler.start()).toThrow(/bad/);
  });

  it('останавливает все джобы по stop', () => {
    const registry = buildRegistry([{ name: 'm', jobs: [{ name: 'sync', cron: '*/30 * * * *', run: async () => {} }] }]);
    const scheduler = createScheduler({ registry, ctx });

    scheduler.start();
    expect(() => scheduler.stop()).not.toThrow();
  });
});
