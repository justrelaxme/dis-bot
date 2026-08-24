import { describe, expect, it, vi } from 'vitest';
import {
  classifyStartupFailure,
  describeFailure,
  explainStartupFailure,
  isTransient,
  migrateWithRetry,
} from '../../../src/core/db/startup.js';

/**
 * Разбор отказа при старте. Тест написан по живому случаю: хостинг перезапускал бота по кругу,
 * в логе стояло «миграции не применились», и разбираться пришлось с миграциями — а база просто
 * не давала соединения, потому что у неё кончилась квота.
 *
 * Поэтому главное, что здесь проверяется, — не классификация сама по себе, а то, что каждый
 * отказ называет себя. Ложный след в сообщении дороже отсутствия сообщения: он отправляет
 * искать поломку туда, где её нет.
 */

/** Ошибка приходит завёрнутой: drizzle оборачивает ошибку pg, а та — ошибку сети. */
function wrapped(message: string, cause: unknown): Error {
  return Object.assign(new Error(message), { cause });
}

function pgError(message: string, code?: string): Error {
  const error = new Error(message);
  if (code !== undefined) Object.assign(error, { code });
  return error;
}

describe('почему база не далась', () => {
  /**
   * Ровно та ошибка, что пришла с сервера. Квота приходит как обычный отказ запроса, и без
   * своей проверки выглядела бы поломкой миграции — то есть виноватым оказался бы код.
   */
  it('исчерпанная квота Neon опознаётся квотой, а не поломкой миграции', () => {
    const error = wrapped(
      'Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"',
      new Error('Your account or project has exceeded the compute time quota. Upgrade your plan to increase limits.'),
    );

    expect(classifyStartupFailure(error)).toBe('quota');
  });

  it('квота видна и через две обёртки', () => {
    const error = wrapped('внешняя', wrapped('средняя', new Error('project has exceeded the data transfer quota')));

    expect(classifyStartupFailure(error)).toBe('quota');
  });

  it('недоступная база: код соединения', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']) {
      const error = wrapped('Failed query: select 1', pgError('connect failed', code));
      expect(classifyStartupFailure(error), code).toBe('unreachable');
    }
  });

  it('недоступная база: формулировки без кода', () => {
    for (const message of [
      'Connection terminated unexpectedly',
      'timeout expired',
      'Could not connect to the endpoint',
      'The endpoint is disabled',
    ]) {
      expect(classifyStartupFailure(new Error(message)), message).toBe('unreachable');
    }
  });

  it('не пустили: коды пароля, базы и прав', () => {
    for (const code of ['28P01', '28000', '3D000', '42501']) {
      const error = wrapped('Failed query', pgError('отказано', code));
      expect(classifyStartupFailure(error), code).toBe('auth');
    }
  });

  /**
   * Тоже из живого случая. Pooler Supabase подписан их собственным центром, которого нет в
   * наборе Node, и `verify-full` его отвергает. Без своей ветки это опознавалось как поломка
   * миграции — то есть снова ложный след, только про другое.
   */
  it('непроверенный сертификат опознаётся сертификатом', () => {
    const error = wrapped(
      'Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"',
      new Error('self-signed certificate in certificate chain'),
    );

    expect(classifyStartupFailure(error)).toBe('tls');
  });

  it('сертификат: коды OpenSSL', () => {
    for (const code of [
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'CERT_HAS_EXPIRED',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ]) {
      expect(classifyStartupFailure(pgError('tls', code)), code).toBe('tls');
    }
  });

  /**
   * Сертификат проверяется раньше пароля не по вкусу, а по порядку событий: TLS падает до
   * того, как база успевает сказать хоть что-то про пароль.
   */
  it('сертификат важнее пароля, когда в тексте есть и то и другое', () => {
    const error = wrapped(
      'password authentication failed',
      new Error('self-signed certificate in certificate chain'),
    );

    expect(classifyStartupFailure(error)).toBe('tls');
  });

  it('не пустили: сообщение про пароль', () => {
    expect(classifyStartupFailure(new Error('password authentication failed for user "bot"'))).toBe('auth');
  });

  /**
   * Единственный случай, когда виноват код. Всё, что не опознано, попадает сюда намеренно:
   * незнакомый отказ лучше показать как поломку миграции и разобрать, чем молча счесть сетевым
   * и уйти в бесконечные повторы.
   */
  it('настоящая ошибка миграции остаётся ошибкой миграции', () => {
    const error = wrapped(
      'Failed query: ALTER TABLE "tournaments" ADD COLUMN "x" integer',
      pgError('column "x" of relation "tournaments" already exists', '42701'),
    );

    expect(classifyStartupFailure(error)).toBe('migration');
  });

  it('неизвестный отказ считается ошибкой миграции, а не сетевой', () => {
    expect(classifyStartupFailure(new Error('что-то совсем другое'))).toBe('migration');
    expect(classifyStartupFailure('строка вместо ошибки')).toBe('migration');
    expect(classifyStartupFailure(null)).toBe('migration');
  });

  /** Кольцо в cause не должно приводить к бесконечному обходу. */
  it('кольцевая причина не вешает разбор', () => {
    const first = new Error('первая');
    const second = new Error('вторая');
    Object.assign(first, { cause: second });
    Object.assign(second, { cause: first });

    expect(classifyStartupFailure(first)).toBe('migration');
  });
});

describe('стоит ли пробовать ещё раз', () => {
  /** Квота и пароль от повтора не меняются — повторять их значит тянуть время впустую. */
  it('переспрашивается только недоступность', () => {
    expect(isTransient('unreachable')).toBe(true);
    expect(isTransient('quota')).toBe(false);
    expect(isTransient('auth')).toBe(false);
    expect(isTransient('tls')).toBe(false);
    expect(isTransient('migration')).toBe(false);
  });
});

describe('текст отказа', () => {
  const kinds = ['quota', 'unreachable', 'auth', 'tls', 'migration'] as const;

  it('у каждой причины свой, и они не похожи друг на друга', () => {
    const texts = kinds.map(describeFailure);

    expect(new Set(texts).size).toBe(texts.length);
  });

  /** Про квоту надо сказать прямо, что код ни при чём: иначе искать будут в миграциях. */
  it('про квоту сказано, что код тут ни при чём', () => {
    expect(describeFailure('quota')).toMatch(/тариф/);
    expect(describeFailure('quota')).toMatch(/ни при чём/);
  });

  it('про недоступность есть подсказка про localhost в контейнере', () => {
    expect(describeFailure('unreachable')).toMatch(/localhost/);
  });

  /** Ошибка сертификата бесполезна без того, что с ней делать: путь к центру и его цена. */
  it('про сертификат сказано, чем его лечить', () => {
    expect(describeFailure('tls')).toMatch(/sslrootcert/);
    expect(describeFailure('tls')).toMatch(/no-verify/);
  });

  /**
   * Разбор без последствий: тот же текст нужен проверке строки подключения, где бот и не
   * запускался — «бот не стартует» там было бы неправдой.
   */
  it('сам разбор про остановку бота не говорит', () => {
    for (const kind of kinds) {
      expect(describeFailure(kind), kind).not.toMatch(/не стартует/);
    }
  });

  it('в фатальный лог последствие дописывается', () => {
    for (const kind of kinds) {
      expect(explainStartupFailure(kind), kind).toContain(describeFailure(kind));
      expect(explainStartupFailure(kind), kind).toMatch(/бот не стартует/);
    }
  });

  /** Формулировка дословная: по ней ищут в логах, и менять её значит ломать поиск. */
  it('про поломку миграции — прежняя строка', () => {
    expect(explainStartupFailure('migration')).toBe('миграции не применились — бот не стартует');
  });
});

describe('повтор миграции', () => {
  const noWait = { sleep: async (): Promise<void> => {}, delayMs: (): number => 0 };

  it('успех с первого раза — одна попытка', async () => {
    const run = vi.fn(async () => {});

    const result = await migrateWithRetry(run, noWait);

    expect(result).toEqual({ ok: true, attemptsUsed: 1 });
    expect(run).toHaveBeenCalledTimes(1);
  });

  /**
   * База, засыпающая при простое, на первом соединении отвечает не сразу. Упасть из-за этого
   * значит уйти в перезапуск на ровном месте — а перезапуск стоит дороже двух секунд ожидания.
   */
  it('недоступная база переспрашивается и поднимается со второй попытки', async () => {
    let calls = 0;
    const run = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw pgError('connect ECONNREFUSED', 'ECONNREFUSED');
    });

    const result = await migrateWithRetry(run, noWait);

    expect(result.ok).toBe(true);
    expect(result.attemptsUsed).toBe(2);
  });

  it('исчерпанная квота не переспрашивается ни разу', async () => {
    const run = vi.fn(async () => {
      throw new Error('exceeded the compute time quota');
    });

    const result = await migrateWithRetry(run, noWait);

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('quota');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('ошибка миграции не переспрашивается: она от повтора не пройдёт', async () => {
    const run = vi.fn(async () => {
      throw pgError('column already exists', '42701');
    });

    const result = await migrateWithRetry(run, noWait);

    expect(result.failure).toBe('migration');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('недоступность до конца попыток отдаёт причину, а не молчание', async () => {
    const run = vi.fn(async () => {
      throw pgError('connect ETIMEDOUT', 'ETIMEDOUT');
    });

    const result = await migrateWithRetry(run, { ...noWait, attempts: 3 });

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('unreachable');
    expect(result.attemptsUsed).toBe(3);
    expect(run).toHaveBeenCalledTimes(3);
  });

  /** О каждом повторе надо сказать: иначе десять секунд тишины при старте выглядят зависанием. */
  it('о повторе сообщается с номером попытки и паузой', async () => {
    const onRetry = vi.fn();
    let calls = 0;
    const run = async (): Promise<void> => {
      calls += 1;
      if (calls < 3) throw pgError('connect ECONNREFUSED', 'ECONNREFUSED');
    };

    await migrateWithRetry(run, { sleep: async () => {}, delayMs: (attempt) => attempt * 1_000, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, { attempt: 1, attempts: 3, waitMs: 1_000 });
    expect(onRetry).toHaveBeenNthCalledWith(2, { attempt: 2, attempts: 3, waitMs: 2_000 });
  });

  it('одна попытка означает одну попытку', async () => {
    const run = vi.fn(async () => {
      throw pgError('connect ECONNREFUSED', 'ECONNREFUSED');
    });

    await migrateWithRetry(run, { ...noWait, attempts: 1 });

    expect(run).toHaveBeenCalledTimes(1);
  });

  /** Пауза между попытками должна быть настоящей, а не нулевой: иначе повтор ничего не ждёт. */
  it('по умолчанию между попытками есть пауза', async () => {
    // Ожидания складываются в массив, а не читаются из mock.calls: без объявленного параметра
    // тип аргументов у мока пустой, и прочитать длину паузы тест бы не смог.
    const waited: number[] = [];
    let calls = 0;
    const run = async (): Promise<void> => {
      calls += 1;
      if (calls === 1) throw pgError('connect ECONNREFUSED', 'ECONNREFUSED');
    };

    await migrateWithRetry(run, {
      sleep: async (ms: number) => {
        waited.push(ms);
      },
    });

    expect(waited).toHaveLength(1);
    expect(waited[0]).toBeGreaterThan(0);
  });
});
