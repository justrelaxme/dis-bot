import { ProviderError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';

const TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 300;
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 60_000;

/** Коды, при которых повтор осмыслен. 404 и 403 повторять бессмысленно. */
const RETRIABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface FetchClientDeps {
  provider: string;
  logger: Logger;
  metrics?: Metrics;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface JsonInit extends RequestInit {
  schema?: { parse(input: unknown): unknown };
}

export interface FetchClient {
  json<T>(url: string, init?: RequestInit & { schema?: { parse(input: unknown): T } }): Promise<T>;
}

export function createFetchClient(deps: FetchClientDeps): FetchClient {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let consecutiveFailures = 0;
  let breakerOpenedAt: number | null = null;

  function breakerIsOpen(): boolean {
    if (breakerOpenedAt === null) return false;
    if (now() - breakerOpenedAt >= BREAKER_COOLDOWN_MS) {
      breakerOpenedAt = null;
      consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  function recordFailure(): void {
    consecutiveFailures += 1;
    if (consecutiveFailures >= BREAKER_THRESHOLD && breakerOpenedAt === null) {
      breakerOpenedAt = now();
      deps.logger.warn({ provider: deps.provider }, 'circuit breaker открыт');
    }
    deps.metrics?.providerErrors.inc({ provider: deps.provider });
  }

  async function attempt(url: string, init: JsonInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function backoffMs(attemptNumber: number, response: Response | null): number {
    const retryAfter = response?.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return seconds * 1_000;
    }
    const exponential = BASE_BACKOFF_MS * 2 ** (attemptNumber - 1);
    // Джиттер: без него все ожидающие клиенты просыпаются одновременно.
    return exponential + Math.floor(exponential * 0.5 * Math.random());
  }

  return {
    async json<T>(url: string, init: RequestInit & { schema?: { parse(input: unknown): T } } = {}): Promise<T> {
      if (breakerIsOpen()) {
        throw new ProviderError(`${deps.provider} недоступен: circuit breaker открыт`, deps.provider);
      }

      let lastProblem = 'неизвестная ошибка';

      for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber += 1) {
        let response: Response | null = null;
        try {
          response = await attempt(url, init);
        } catch (error) {
          lastProblem = error instanceof Error ? error.message : 'сетевой сбой';
          recordFailure();
          if (attemptNumber === MAX_ATTEMPTS) break;
          await sleep(backoffMs(attemptNumber, null));
          continue;
        }

        if (response.ok) {
          let payload: unknown;
          try {
            payload = await response.json();
          } catch (error) {
            // Ответ пришёл (200), но тело не разобралось — повторять бессмысленно, тело уже такое.
            recordFailure();
            throw new ProviderError(`не удалось разобрать ответ: ${(error as Error).message}`, deps.provider, error);
          }

          if (!init.schema) {
            consecutiveFailures = 0;
            return payload as T;
          }
          try {
            const parsed = init.schema.parse(payload);
            consecutiveFailures = 0;
            return parsed;
          } catch (error) {
            // Ответ пришёл, но формат не тот — повторять бессмысленно.
            recordFailure();
            throw new ProviderError(`неожиданный формат ответа: ${(error as Error).message}`, deps.provider, error);
          }
        }

        lastProblem = `HTTP ${response.status}`;
        recordFailure();

        if (!RETRIABLE_STATUS.has(response.status) || attemptNumber === MAX_ATTEMPTS) break;
        await sleep(backoffMs(attemptNumber, response));
      }

      throw new ProviderError(`${deps.provider} недоступен: ${lastProblem}`, deps.provider);
    },
  };
}
