import { Redis } from 'ioredis';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

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
      const value = await options.load();
      await this.write(key, value, options.staleMs);
      return { value, stale: false, storedAt: new Date() };
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
    const task: Promise<void> = this.doRefresh(key, options).finally(() => {
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

  private async write<T>(key: string, value: T, staleMs: number): Promise<void> {
    const entry: StoredEntry<T> = { value, storedAt: Date.now() };
    await this.redis.set(this.dataKey(key), JSON.stringify(entry), 'PX', staleMs);
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
