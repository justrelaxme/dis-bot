import { Redis } from 'ioredis';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { logRedisErrors } from './redis.js';

export interface CachedValue<T> {
  value: T;
  /** true — значение отдано просроченным, обновление идёт в фоне. */
  stale: boolean;
  storedAt: Date;
}

export interface SwrOptions<T> {
  /** До этого возраста значение считается свежим. */
  ttlMs: number;
  /** До этого возраста просроченное значение ещё можно отдать. */
  staleMs: number;
  load: () => Promise<T>;
}

interface StoredEntry<T> {
  value: T;
  storedAt: number;
}

const REFRESH_LOCK_MS = 30_000;
/** Сколько суммарно ждать запись победителя лока на холодном промахе, прежде чем сдаться и грузить самому. */
const STAMPEDE_POLL_TIMEOUT_MS = 2_000;
const STAMPEDE_POLL_STEP_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class Cache {
  private readonly redis: Redis;
  /**
   * Фоновые обновления — fire-and-forget для вызывающего кода `swr()`, но не для
   * `close()`: иначе `quit()` обрывает ещё не завершённый SET/DEL посреди работы,
   * и вместо тихого закрытия получаем "Connection is closed" в логах.
   */
  private readonly pendingRefreshes = new Set<Promise<void>>();

  constructor(
    config: Config,
    private readonly logger: Logger,
  ) {
    this.redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });

    // Обработчик обязателен: ioredis — EventEmitter, и `error` без слушателя убивает
    // процесс. Общий (src/core/redis.ts) ещё и называет адрес и глушит повторы — иначе
    // три клиента втроём заваливают лог одинаковыми строками без единой полезной.
    logRedisErrors(this.redis, { logger, redisUrl: config.REDIS_URL, label: 'кэш' });
  }

  /**
   * Счётчик событий в скользящем окне: возвращает, сколько раз это случилось с начала окна.
   *
   * `INCR` атомарен, поэтому два одновременных сообщения не потеряют друг друга — а именно
   * это и происходит при флуде, ради распознавания которого счётчик и нужен. Срок ставится
   * только на первом инкременте: иначе каждое новое событие продлевало бы окно, и оно
   * никогда бы не закрылось.
   *
   * Счётчик в Redis, а не в памяти процесса, по той же причине, что и пауза начисления
   * опыта: после перезапуска нарушителю не должно доставаться чистое окно.
   */
  async incrementInWindow(key: string, windowMs: number): Promise<number> {
    const count = await this.redis.incr(`window:${key}`);
    if (count === 1) await this.redis.pexpire(`window:${key}`, windowMs);
    return count;
  }

  async swr<T>(key: string, options: SwrOptions<T>): Promise<CachedValue<T>> {
    const entry = await this.read<T>(key);
    const age = entry ? Date.now() - entry.storedAt : Number.POSITIVE_INFINITY;

    if (entry && age < options.ttlMs) {
      return { value: entry.value, stale: false, storedAt: new Date(entry.storedAt) };
    }

    if (entry && age < options.staleMs) {
      this.refreshInBackground(key, options);
      return { value: entry.value, stale: true, storedAt: new Date(entry.storedAt) };
    }

    try {
      const loaded = await this.loadWithLock(key, options);
      return { value: loaded.value, stale: false, storedAt: new Date(loaded.storedAt) };
    } catch (error) {
      // Загрузчик упал. Просроченное лучше ошибки — но только если оно есть.
      if (entry) {
        this.logger.warn({ key, err: error }, 'загрузчик упал, отдаём просроченное значение');
        return { value: entry.value, stale: true, storedAt: new Date(entry.storedAt) };
      }
      throw error;
    }
  }

  async drop(key: string): Promise<void> {
    await this.redis.del(this.dataKey(key));
  }

  async close(): Promise<void> {
    // Дожидаемся фоновых обновлений вместо того, чтобы оборвать их разрывом соединения.
    await Promise.allSettled(this.pendingRefreshes);
    await this.redis.quit();
  }

  /** Планирует обновление в фоне, не блокируя вызывающего. Лок защищает от стампида. */
  private refreshInBackground<T>(key: string, options: SwrOptions<T>): void {
    const task: Promise<void> = this.doRefresh(key, options)
      .catch((error: unknown) => {
        // Обработчик обязателен здесь, а не только в close(): .finally ниже удаляет
        // задачу из набора раньше, чем отклонение всплывёт, поэтому allSettled в
        // close() его уже не поймает — получилось бы необработанное отклонение.
        this.logger.error({ key, err: error }, 'фоновое обновление кэша сорвалось');
      })
      .finally(() => {
        this.pendingRefreshes.delete(task);
      });
    this.pendingRefreshes.add(task);
  }

  private async doRefresh<T>(key: string, options: SwrOptions<T>): Promise<void> {
    const acquired = await this.redis.set(this.lockKey(key), '1', 'PX', REFRESH_LOCK_MS, 'NX');
    if (acquired !== 'OK') return;

    try {
      const value = await options.load();
      await this.write(key, value, options.staleMs);
    } catch (error) {
      this.logger.warn({ key, err: error }, 'фоновое обновление кэша не удалось');
    } finally {
      await this.redis.del(this.lockKey(key));
    }
  }

  /**
   * Холодный промах под локом: без него N параллельных вызывающих зовут
   * options.load() одновременно — ровно то, от чего лок в doRefresh уже защищает
   * тёплый путь, но не холодный.
   */
  private async loadWithLock<T>(key: string, options: SwrOptions<T>): Promise<StoredEntry<T>> {
    const acquired = await this.redis.set(this.lockKey(key), '1', 'PX', REFRESH_LOCK_MS, 'NX');
    if (acquired === 'OK') {
      try {
        return await this.loadAndStore(key, options);
      } finally {
        await this.redis.del(this.lockKey(key));
      }
    }

    const winnerEntry = await this.pollForData<T>(key);
    if (winnerEntry) return winnerEntry;

    // Победитель лока не появился за отведённое время: завис или упал между
    // взятием лока и записью. Застрявший победитель не должен блокировать всех
    // остальных навечно — поэтому грузим сами в обход лока, а не отдаём ошибку.
    return this.loadAndStore(key, options);
  }

  private async loadAndStore<T>(key: string, options: SwrOptions<T>): Promise<StoredEntry<T>> {
    const value = await options.load();
    const storedAt = await this.write(key, value, options.staleMs);
    return { value, storedAt };
  }

  /** Ждёт появления записи, которую пишет победитель лока, до STAMPEDE_POLL_TIMEOUT_MS. */
  private async pollForData<T>(key: string): Promise<StoredEntry<T> | undefined> {
    const deadline = Date.now() + STAMPEDE_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(STAMPEDE_POLL_STEP_MS);
      const entry = await this.read<T>(key);
      if (entry) return entry;
    }
    return undefined;
  }

  private async read<T>(key: string): Promise<StoredEntry<T> | null> {
    const raw = await this.redis.get(this.dataKey(key));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as StoredEntry<T>;
    } catch {
      // Битая запись бесполезна и неотличима от отсутствия — выбрасываем.
      await this.drop(key);
      return null;
    }
  }

  private async write<T>(key: string, value: T, staleMs: number): Promise<number> {
    const storedAt = Date.now();
    const entry: StoredEntry<T> = { value, storedAt };
    await this.redis.set(this.dataKey(key), JSON.stringify(entry), 'PX', staleMs);
    return storedAt;
  }

  private dataKey(key: string): string {
    return `cache:${key}`;
  }

  private lockKey(key: string): string {
    return `cache:lock:${key}`;
  }
}

export function createCache(config: Config, logger: Logger): Cache {
  return new Cache(config, logger);
}
