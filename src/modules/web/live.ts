import type { FastifyInstance } from 'fastify';
import type { Cache } from '../../core/cache.js';
import type { EventBus } from '../../core/events/bus.js';
import type { BotEvents } from '../../core/events/events.js';
import type { Logger } from '../../core/logger.js';

/**
 * Живая витрина: страница сетки и драфта узнают об изменении сразу, а не по F5.
 *
 * Server-Sent Events, а не WebSocket: витрине не нужно ничего говорить серверу — только
 * слушать. SSE — это обычный HTTP-ответ, который не заканчивается: его пропускает любой прокси,
 * браузер сам переподключается, а на сервере не нужна ни библиотека, ни второй протокол.
 *
 * Сообщение говорит только «изменилось», без нового состояния. Страница по нему перечитывает
 * себя тем же запросом, что и при открытии: у драфта ответ разный для капитана и зрителя, и
 * рассылать готовое состояние значило бы собирать его на каждого подписчика отдельно — или,
 * хуже, рассылать всем одинаковое.
 *
 * Бот — один процесс, поэтому раздача живёт в памяти. Второй процесс потребовал бы Redis
 * pub/sub между ними; пока процесса два не будет, это было бы кодом ни для чего.
 */

export interface LiveClient {
  /** `false` — буфер сокета полон: клиент не успевает читать. */
  write(chunk: string): boolean;
  end(): void;
}

export interface LiveChange {
  type: string;
  matchId?: number;
}

export interface LiveHub {
  /** Подписать клиента на турнир. `false` — мест нет, ответить надо отказом. */
  add(tournamentId: number, client: LiveClient): boolean;
  remove(tournamentId: number, client: LiveClient): void;
  /** Сообщить об изменении. Изменения одного турнира за короткое окно уходят одним сообщением. */
  publish(tournamentId: number, change: LiveChange): void;
  /** При остановке: иначе открытые потоки держали бы остановку до таймаута. */
  closeAll(): void;
  readonly size: number;
  readonly full: boolean;
}

export interface LiveHubOptions {
  /** Предел одновременных подписчиков на весь бот. */
  max?: number;
  /**
   * Окно склейки. Закрытие матча — это цепочка: матч закрыт, победитель продвинулся, следующий
   * матч стал играбельным. Три сообщения подряд заставили бы страницу перечитаться трижды.
   */
  debounceMs?: number;
  /** Пустая строка-комментарий раз в интервал: прокси рвут соединение, по которому давно тихо. */
  heartbeatMs?: number;
}

const DEFAULT_MAX = 300;
const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_HEARTBEAT_MS = 25_000;

export function createLiveHub(options: LiveHubOptions = {}): LiveHub {
  const max = options.max ?? DEFAULT_MAX;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const rooms = new Map<number, Set<LiveClient>>();
  const pending = new Map<number, { types: Set<string>; matchIds: Set<number>; timer: NodeJS.Timeout }>();
  let size = 0;

  const drop = (tournamentId: number, client: LiveClient): void => {
    const room = rooms.get(tournamentId);
    if (!room?.delete(client)) return;
    size -= 1;
    if (room.size === 0) rooms.delete(tournamentId);
  };

  /** Отправка одному клиенту. Не успевает читать — отключаем: браузер переподключится сам. */
  const send = (tournamentId: number, client: LiveClient, chunk: string): void => {
    let ok = false;
    try {
      ok = client.write(chunk);
    } catch {
      ok = false;
    }
    if (ok) return;
    drop(tournamentId, client);
    try {
      client.end();
    } catch {
      // Сокет уже закрыт — это и есть то, из-за чего мы отключаем.
    }
  };

  const heartbeat = setInterval(() => {
    for (const [tournamentId, room] of rooms) {
      for (const client of [...room]) send(tournamentId, client, ':\n\n');
    }
  }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  // Сердцебиение не должно держать процесс живым само по себе.
  heartbeat.unref();

  const flush = (tournamentId: number): void => {
    const batch = pending.get(tournamentId);
    pending.delete(tournamentId);
    const room = rooms.get(tournamentId);
    if (!batch || !room) return;
    const data = JSON.stringify({ types: [...batch.types], matchIds: [...batch.matchIds] });
    for (const client of [...room]) send(tournamentId, client, `event: change\ndata: ${data}\n\n`);
  };

  return {
    add(tournamentId, client): boolean {
      if (size >= max) return false;
      let room = rooms.get(tournamentId);
      if (!room) {
        room = new Set();
        rooms.set(tournamentId, room);
      }
      if (!room.has(client)) {
        room.add(client);
        size += 1;
      }
      return true;
    },

    remove: drop,

    publish(tournamentId, change): void {
      // Никто не смотрит — и копить нечего.
      if (!rooms.has(tournamentId)) return;
      let batch = pending.get(tournamentId);
      if (!batch) {
        const timer = setTimeout(() => flush(tournamentId), debounceMs);
        timer.unref();
        batch = { types: new Set(), matchIds: new Set(), timer };
        pending.set(tournamentId, batch);
      }
      batch.types.add(change.type);
      if (change.matchId !== undefined) batch.matchIds.add(change.matchId);
    },

    closeAll(): void {
      clearInterval(heartbeat);
      for (const batch of pending.values()) clearTimeout(batch.timer);
      pending.clear();
      for (const room of rooms.values()) {
        for (const client of room) {
          try {
            client.end();
          } catch {
            // Уже закрыт.
          }
        }
      }
      rooms.clear();
      size = 0;
    },

    get size(): number {
      return size;
    },

    get full(): boolean {
      return size >= max;
    },
  };
}

/** Какие события витрина слушает и к какому матчу каждое относится. */
const LIVE_EVENTS = [
  'match.ready',
  'match.reported',
  'match.disputed',
  'match.confirmed',
  'tournament.started',
  'tournament.finished',
  'tournament.cancelled',
  'tournament.entrants',
  'draft.changed',
] as const satisfies readonly (keyof BotEvents)[];

/**
 * Связка шины с витриной. Кэш страницы сетки сбрасывается до рассылки: иначе страница,
 * перечитанная по сигналу, получила бы ту же копию из кэша, что и секунду назад.
 */
export function wireLive(deps: { bus: EventBus; hub: LiveHub; cache: Pick<Cache, 'drop'>; logger: Logger }): void {
  for (const event of LIVE_EVENTS) {
    deps.bus.on(event, async (payload) => {
      const { tournamentId } = payload;
      await Promise.all([
        deps.cache.drop(`web:tournament:${tournamentId}`),
        deps.cache.drop('web:index'),
      ]).catch((error: unknown) => deps.logger.warn({ err: error, tournamentId }, 'кэш витрины не сбросился'));
      deps.hub.publish(tournamentId, {
        type: event,
        ...('matchId' in payload ? { matchId: payload.matchId } : {}),
      });
    });
  }
}

export function registerLiveRoutes(server: FastifyInstance, deps: { hub: LiveHub }): void {
  server.get<{ Params: { id: string } }>('/api/live/t/:id', (request, reply) => {
    const tournamentId = Number.parseInt(request.params.id, 10);
    if (!Number.isInteger(tournamentId) || tournamentId <= 0) {
      void reply.code(404).send({ error: 'Такого турнира нет.' });
      return;
    }
    if (deps.hub.full) {
      // Мест нет — страница останется рабочей, просто без живых обновлений: скрипт на ней
      // переподключится позже и обновится сам.
      void reply.code(503).header('retry-after', '30').send({ error: 'Слишком много зрителей — обновляйте вручную.' });
      return;
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      // Буферизующий прокси (nginx) иначе копил бы сообщения и отдавал пачками.
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    });
    // Через сколько браузеру переподключаться после обрыва.
    raw.write('retry: 3000\n\n');

    const client: LiveClient = { write: (chunk) => raw.write(chunk), end: () => raw.end() };
    deps.hub.add(tournamentId, client);
    request.raw.on('close', () => deps.hub.remove(tournamentId, client));
  });
}
