import type { Redis } from 'ioredis';
import type { Logger } from './logger.js';

/**
 * Обработчик ошибок Redis, общий для всех трёх клиентов (кэш, кулдаун, лимитер).
 *
 * Появился по итогам живого развёртывания. Каждый клиент писал в лог свою ошибку на каждой
 * попытке переподключения, и втроём они превращали лог в стену одинаковых строк, из которой
 * нельзя было вычитать ни причину, ни то, что бот при этом вообще-то работает. А причина
 * была простая: управляемый Redis требует TLS, а в строке подключения стояло `redis://`
 * вместо `rediss://`.
 *
 * Поэтому здесь две вещи. Во-первых, к ошибке добавляется адрес — схема и хост, без пароля:
 * «ECONNRESET» без адреса не отвечает ни на один вопрос. Во-вторых, повторы придушены: одна
 * запись в минуту на клиента и счётчик подавленных. Обработчик остаётся обязательным — у
 * ioredis это EventEmitter, и событие `error` без слушателя убивает процесс.
 */

/** Одна запись в минуту на клиента: чаще — это шум, реже — можно не заметить проблему. */
const REPEAT_INTERVAL_MS = 60_000;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '']);

/** Куда мы стучимся: схема и хост, без пароля. Плюс подсказка про TLS, если она уместна. */
function describeRedisTarget(redisUrl: string): Record<string, string> {
  let url: URL;
  try {
    url = new URL(redisUrl);
  } catch {
    return { redis: 'адрес не разобрался как URL' };
  }

  const local = LOCAL_HOSTS.has(url.hostname);
  const insecureRemote = url.protocol === 'redis:' && !local;

  return {
    scheme: url.protocol.replace(':', ''),
    host: url.hostname,
    port: url.port || '6379',
    ...(local
      ? { hint: 'Redis указан на localhost. Внутри контейнера localhost — это сам контейнер' }
      : {}),
    ...(insecureRemote
      ? {
          hint: 'подключение без TLS. Управляемый Redis (Upstash, Redis Cloud) принимает только TLS и рвёт соединение — нужна схема rediss:// с двумя «s»',
        }
      : {}),
  };
}

export function logRedisErrors(
  redis: Redis,
  deps: { logger: Logger; redisUrl: string; label: string },
): void {
  let lastLoggedAt = 0;
  let suppressed = 0;

  redis.on('error', (error: Error) => {
    const now = Date.now();
    if (now - lastLoggedAt < REPEAT_INTERVAL_MS) {
      suppressed += 1;
      return;
    }

    deps.logger.error(
      {
        err: error,
        ...describeRedisTarget(deps.redisUrl),
        ...(suppressed > 0 ? { skipped: suppressed } : {}),
      },
      `ошибка соединения с Redis: ${deps.label}`,
    );
    lastLoggedAt = now;
    suppressed = 0;
  });
}

/**
 * Прибавка к счётчику окна одной атомарной операцией: `INCR` и срок в одном скрипте.
 *
 * Раньше это были два вызова — `INCR`, а при первом значении отдельный `PEXPIRE`. Упади
 * процесс между ними или оборвись связь — и счётчик оставался без срока навсегда: лимит
 * запросов к API или окно антиспама переставали открываться, пока ключ не удалят руками.
 *
 * Срок ставится не только на первом значении, но и всякий раз, когда его нет: так скрипт
 * заодно лечит ключи, застрявшие без срока при прежнем порядке. Существующий срок не
 * трогается — иначе каждое событие продлевало бы окно, и оно не закрывалось бы никогда.
 */
const INCREMENT_IN_WINDOW = `
local count = redis.call('INCR', KEYS[1])
if redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

export async function incrementInWindow(redis: Redis, key: string, windowMs: number): Promise<number> {
  const count = await redis.eval(INCREMENT_IN_WINDOW, 1, key, String(windowMs));
  return Number(count);
}
