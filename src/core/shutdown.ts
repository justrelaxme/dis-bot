import type { Logger } from './logger.js';

export interface Shutdown {
  /** Помечает работу как незавершённую: drain её дождётся. */
  track<T>(work: Promise<T>): Promise<T>;
  /** Регистрирует шаг остановки. Шаги выполняются в порядке регистрации. */
  onSignal(handler: () => Promise<void>): void;
  drain(timeoutMs: number): Promise<void>;
}

export function createShutdown(deps: { logger: Logger }): Shutdown {
  const inFlight = new Set<Promise<unknown>>();
  const handlers: Array<() => Promise<void>> = [];

  return {
    track<T>(work: Promise<T>): Promise<T> {
      inFlight.add(work);
      void work.catch(() => undefined).finally(() => inFlight.delete(work));
      return work;
    },

    onSignal(handler: () => Promise<void>): void {
      handlers.push(handler);
    },

    async drain(timeoutMs: number): Promise<void> {
      if (inFlight.size > 0) {
        deps.logger.info({ count: inFlight.size }, 'дожидаемся незавершённой работы');
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            deps.logger.warn('таймаут ожидания — останавливаемся принудительно');
            resolve();
          }, timeoutMs);
        });
        await Promise.race([Promise.allSettled([...inFlight]).then(() => undefined), deadline]);
        if (timer) clearTimeout(timer);
      }

      for (const handler of handlers) {
        try {
          await handler();
        } catch (error) {
          deps.logger.error({ err: error }, 'шаг остановки упал');
        }
      }
    },
  };
}
