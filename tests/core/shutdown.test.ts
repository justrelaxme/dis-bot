import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import { createShutdown } from '../../src/core/shutdown.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

describe('createShutdown', () => {
  it('дожидается отслеживаемой работы', async () => {
    const shutdown = createShutdown({ logger });
    let finished = false;

    void shutdown.track(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          finished = true;
          resolve();
        }, 30),
      ),
    );

    await shutdown.drain(1_000);
    expect(finished).toBe(true);
  });

  it('возвращает результат отслеживаемой работы', async () => {
    const shutdown = createShutdown({ logger });
    await expect(shutdown.track(Promise.resolve(7))).resolves.toBe(7);
  });

  it('перестаёт ждать по истечении таймаута', async () => {
    const shutdown = createShutdown({ logger });
    void shutdown.track(new Promise<void>((resolve) => setTimeout(resolve, 5_000)));

    const startedAt = Date.now();
    await shutdown.drain(50);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('не ломается на упавшей отслеживаемой работе', async () => {
    const shutdown = createShutdown({ logger });
    void shutdown.track(Promise.reject(new Error('работа упала'))).catch(() => {});

    await expect(shutdown.drain(100)).resolves.toBeUndefined();
  });

  it('вызывает зарегистрированные обработчики сигнала по порядку', async () => {
    const shutdown = createShutdown({ logger });
    const order: string[] = [];
    shutdown.onSignal(async () => {
      order.push('first');
    });
    shutdown.onSignal(async () => {
      order.push('second');
    });

    await shutdown.drain(100);

    expect(order).toEqual(['first', 'second']);
  });
});
