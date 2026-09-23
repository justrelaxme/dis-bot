import { ProviderError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';

const TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 300;
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 60_000;

/**
 * Дольше этого `Retry-After` не ждём внутри запроса. Сервис вправе попросить час, но
 * заснуть на час посреди нажатия кнопки значит оставить человека без ответа, а джобу —
 * висеть до следующего деплоя. Долгая просьба подождать — это отказ сейчас.
 */
const MAX_RETRY_AFTER_MS = 10_000;

/**
 * На сколько самое большее предохранитель закрывает дорогу после долгого `Retry-After`.
 * Раньше просьбы звонить незачем — ответ будет тот же, — но и сутки молчать из-за одного
 * странного заголовка нельзя.
 */
const MAX_BREAKER_HOLD_MS = 15 * 60_000;

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
  /** До какого момента предохранитель не пускает наружу. `null` — закрыт, звонить можно. */
  let breakerOpenUntil: number | null = null;

  function breakerIsOpen(): boolean {
    if (breakerOpenUntil === null) return false;
    if (now() >= breakerOpenUntil) {
      breakerOpenUntil = null;
      consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  function recordFailure(): void {
    consecutiveFailures += 1;
    if (consecutiveFailures >= BREAKER_THRESHOLD && breakerOpenUntil === null) {
      breakerOpenUntil = now() + BREAKER_COOLDOWN_MS;
      deps.logger.warn({ provider: deps.provider }, 'circuit breaker открыт');
    }
    deps.metrics?.providerErrors.inc({ provider: deps.provider });
  }

  /** Сервис сам сказал, когда приходить: до этого момента звонить незачем. */
  function holdBreaker(ms: number): void {
    const until = now() + Math.min(ms, MAX_BREAKER_HOLD_MS);
    breakerOpenUntil = Math.max(breakerOpenUntil ?? 0, until);
    deps.logger.warn({ provider: deps.provider, waitMs: ms }, 'сервис просит подождать — предохранитель открыт до срока');
  }

  /**
   * Запрос вместе с телом ответа под одним таймером. Раньше таймер снимался, как только
   * приходили заголовки, и медленное тело могло тянуться без всякого предела: заголовки
   * отдаются сразу, а данные — как получится.
   */
  async function attempt(url: string, init: JsonInit): Promise<{ response: Response; body: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        // Тело отказа не нужно, а недочитанное держит соединение.
        await response.body?.cancel().catch(() => undefined);
        return { response, body: null };
      }
      return { response, body: await response.text() };
    } finally {
      clearTimeout(timer);
    }
  }

  /** `Retry-After` в миллисекундах: бывает числом секунд и бывает HTTP-датой. */
  function retryAfterMs(response: Response): number | null {
    const header = response.headers.get('retry-after');
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const at = Date.parse(header);
    return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
  }

  function backoffMs(attemptNumber: number, response: Response | null): number {
    const asked = response ? retryAfterMs(response) : null;
    if (asked !== null) return asked;
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
        let body: string | null = null;
        try {
          ({ response, body } = await attempt(url, init));
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
            payload = JSON.parse(body ?? '');
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

        const asked = retryAfterMs(response);
        if (asked !== null && asked > MAX_RETRY_AFTER_MS) {
          holdBreaker(asked);
          lastProblem = `HTTP ${response.status}, просит подождать ${Math.ceil(asked / 1_000)} с`;
          break;
        }
        await sleep(backoffMs(attemptNumber, response));
      }

      throw new ProviderError(`${deps.provider} недоступен: ${lastProblem}`, deps.provider);
    },
  };
}
