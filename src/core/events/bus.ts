import type { Logger } from '../logger.js';
import type { BotEvents } from './events.js';

type Handler<K extends keyof BotEvents> = (payload: BotEvents[K]) => void | Promise<void>;

export class EventBus {
  // Значения гетерогенны по ключу, поэтому единый тип здесь невыразим;
  // безопасность обеспечивают сигнатуры on/emit.
  private readonly handlers = new Map<keyof BotEvents, Set<(payload: never) => void | Promise<void>>>();

  constructor(private readonly logger: Logger) {}

  on<K extends keyof BotEvents>(event: K, handler: Handler<K>): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as (payload: never) => void | Promise<void>);
    this.handlers.set(event, set);
    return () => {
      set.delete(handler as (payload: never) => void | Promise<void>);
    };
  }

  /**
   * Доставляет событие всем подписчикам и дожидается их завершения.
   * Упавший обработчик логируется и не влияет на остальных.
   */
  async emit<K extends keyof BotEvents>(event: K, payload: BotEvents[K]): Promise<void> {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;

    const results = await Promise.allSettled(
      [...set].map(async (handler) => {
        await (handler as unknown as Handler<K>)(payload);
      }),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error({ event, err: result.reason }, 'обработчик события упал');
      }
    }
  }
}
