/**
 * Разбор отказа при старте: почему база не далась и что с этим делать.
 *
 * Появилось из живого случая. Хостинг перезапускал бота по кругу, в логе стояло «миграции не
 * применились — бот не стартует», и разбираться пришлось с миграциями. А настоящая причина
 * лежала строкой ниже, в причине причины: у базы Neon кончилась квота вычислительного времени,
 * и она не давала соединения вообще — до миграций дело не доходило.
 *
 * Отсюда правило, которое этот файл и выполняет: **сообщение об отказе обязано называть тот
 * отказ, который случился**. «Миграции не применились» при недоступной базе — не неточность, а
 * ложный след: он отправляет искать поломку туда, где её нет.
 *
 * Второе следствие: не всякий отказ стоит считать окончательным. База, которая засыпает при
 * простое (так работают Neon, Supabase и прочие serverless), на первом соединении отвечает не
 * сразу, и упасть из-за этого значит уйти в перезапуск на ровном месте. Недоступность стоит
 * переспросить, а вот кончившуюся квоту и неверный пароль — нет: они от повтора не меняются.
 */

/** Почему не удалось. От этого зависит и текст, и стоит ли пробовать ещё раз. */
export type StartupFailure =
  /** Тариф базы исчерпан: соединения не будет, сколько ни проси. */
  | 'quota'
  /** База не отвечает: не тот адрес, не поднялась, спит или сеть. Переспросить стоит. */
  | 'unreachable'
  /** Не пустили: пароль, имя базы, права. Повтор не поможет. */
  | 'auth'
  /** Соединение было, упала сама миграция. Это единственный случай, когда виноват код. */
  | 'migration';

/** Коды соединения из node: сеть, DNS, таймаут. */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
]);

/**
 * Коды Postgres, означающие «не пустили»: неверный пароль, нет такой базы, нет прав.
 * Полный список в документации Postgres, класс 28 и 3D.
 */
const AUTH_CODES = new Set(['28000', '28P01', '3D000', '42501']);

/** Ошибка приходит завёрнутой: drizzle оборачивает ошибку pg, а та — ошибку сети. */
function chain(error: unknown): unknown[] {
  const seen: unknown[] = [];
  let current = error;
  // Ограничение на глубину — защита от кольца в cause, а не от глубокой обёртки.
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    seen.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return seen;
}

function textOf(error: unknown): string {
  return chain(error)
    .map((item) => (item instanceof Error ? item.message : String(item)))
    .join(' ')
    .toLowerCase();
}

function codesOf(error: unknown): string[] {
  return chain(error)
    .map((item) => (item as { code?: unknown }).code)
    .filter((code): code is string => typeof code === 'string');
}

/**
 * Что именно случилось. Порядок проверок значим: квота приходит как обычная ошибка запроса и
 * без своей проверки выглядела бы поломкой миграции, то есть виноватым оказался бы код.
 */
export function classifyStartupFailure(error: unknown): StartupFailure {
  const text = textOf(error);
  const codes = codesOf(error);

  // Формулировки хостингов разные, общее в них одно — слово «quota». Проверяется до всего
  // остального: соединения нет, но выглядит это как отказ на первом же запросе.
  if (text.includes('quota') || text.includes('compute time')) return 'quota';

  if (codes.some((code) => AUTH_CODES.has(code))) return 'auth';
  if (text.includes('password authentication failed') || text.includes('role') && text.includes('does not exist')) {
    return 'auth';
  }

  if (codes.some((code) => NETWORK_CODES.has(code))) return 'unreachable';
  if (
    text.includes('connection terminated') ||
    text.includes('timeout expired') ||
    text.includes('connection refused') ||
    text.includes('endpoint is disabled') ||
    text.includes('could not connect')
  ) {
    return 'unreachable';
  }

  return 'migration';
}

/** Стоит ли пробовать ещё раз. Квота и пароль от повтора не меняются, недоступность — да. */
export function isTransient(failure: StartupFailure): boolean {
  return failure === 'unreachable';
}

/**
 * В чём дело и что делать. Без последствий для бота: этот же разбор нужен и проверке строки
 * подключения (`npm run db:check`), где бот и не запускался, — а «бот не стартует» там было бы
 * неправдой. Последствие приписывает тот, кто действительно падает: `startupFatalMessage`.
 */
export function describeFailure(failure: StartupFailure): string {
  switch (failure) {
    case 'quota':
      return 'база отказала по тарифу: у неё кончилась квота (у Neon это вычислительное время). Код и миграции тут ни при чём — она не даст соединения, пока квота не восстановится или не сменится тариф';
    case 'unreachable':
      return 'база не отвечает. Проверьте DATABASE_URL, доступность хоста и то, что база поднята: внутри контейнера localhost — это сам контейнер, и базы там нет';
    case 'auth':
      return 'база не пустила: не подошли пароль, имя базы или прав недостаточно';
    case 'migration':
      return 'миграции не применились';
  }
}

/**
 * Строка для фатального лога при старте. Формулировка «миграции не применились — бот не
 * стартует» осталась дословной: по ней ищут в логах, и менять её значит ломать поиск.
 */
export function explainStartupFailure(failure: StartupFailure): string {
  return `${describeFailure(failure)} — бот не стартует`;
}

export interface MigrateAttemptOptions {
  /**
   * Сколько раз пробовать при недоступной базе. Три попытки, потому что спящая serverless-база
   * просыпается за единицы секунд, а четвёртая попытка уже ничего не добавляет — если не
   * поднялась за десяток секунд, дело не в холодном старте.
   */
  attempts?: number;
  /** Пауза перед повтором по номеру попытки. Подменяется в тестах, чтобы не ждать всерьёз. */
  delayMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; attempts: number; waitMs: number }) => void;
}

const DEFAULT_ATTEMPTS = 3;
/** 2 и 5 секунд: холодный старт спящей базы укладывается в это с запасом. */
const DEFAULT_DELAYS = [2_000, 5_000];

export interface MigrateResult {
  ok: boolean;
  failure?: StartupFailure;
  error?: unknown;
  /** Сколько попыток понадобилось. Полезно в логе: «поднялась со второй» — это сигнал. */
  attemptsUsed: number;
}

/**
 * Применяет миграции, переспрашивая недоступную базу. Не бросает: решение о том, что делать с
 * отказом, принимает вызывающий — здесь ему отдаётся разобранная причина.
 */
export async function migrateWithRetry(
  run: () => Promise<void>,
  options: MigrateAttemptOptions = {},
): Promise<MigrateResult> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const delayMs = options.delayMs ?? ((attempt: number) => DEFAULT_DELAYS[attempt - 1] ?? 5_000);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await run();
      return { ok: true, attemptsUsed: attempt };
    } catch (error) {
      last = error;
      const failure = classifyStartupFailure(error);
      if (!isTransient(failure) || attempt === attempts) {
        return { ok: false, failure, error, attemptsUsed: attempt };
      }
      const waitMs = delayMs(attempt);
      options.onRetry?.({ attempt, attempts, waitMs });
      await sleep(waitMs);
    }
  }

  // Недостижимо: цикл всегда возвращает результат. Ветка нужна, чтобы тип был честным.
  return { ok: false, failure: classifyStartupFailure(last), error: last, attemptsUsed: attempts };
}
