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
    const seen: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      // Намеренно без .catch на результате track(): именно так track используется в
      // index.ts (`void shutdown.track(...)`, без внешнего catch). Если бы отклонение
      // гасил не track, а внешний .catch, тест был бы зелёным при любой реализации
      // track и не доказывал бы ничего.
      void shutdown.track(Promise.reject(new Error('работа упала')));

      // Восстановлено из исходной версии теста: drain обязан завершиться даже над
      // упавшей отслеживаемой работой, а не только не уронить процесс необработанным
      // отклонением — это отдельное свойство, и его тоже нужно пинить.
      await expect(shutdown.drain(100)).resolves.toBeUndefined();

      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
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
