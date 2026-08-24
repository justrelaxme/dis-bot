import { Pool } from 'pg';
import { classifyStartupFailure, describeFailure, type StartupFailure } from './startup.js';

/**
 * Проверка строки подключения — до того, как её пропишут боту.
 *
 * Появилось при переезде базы. Проверять новую базу перезапуском бота — плохой способ:
 * ответом будет не «строка неверна», а цикл падений в логе хостинга, из которого причину
 * ещё надо выковырять. Проверка отдельной командой отвечает сразу и словами.
 *
 * Что именно она смотрит: пускает ли база, шифруется ли соединение, какие миграции уже
 * применены и сколько в ней таблиц. Этого набора хватает, чтобы отличить четыре состояния,
 * которые выглядят одинаково, а лечатся по-разному: не та строка, база пустая, база уже
 * готова, база чужая.
 */

export interface ProbeSuccess {
  ok: true;
  /** Версия сервера — по ней видно, что это Postgres, а не что-то совместимое наполовину. */
  version: string;
  database: string;
  /** Шифруется ли соединение. Для облачной базы «нет» означает, что что-то не так. */
  encrypted: boolean;
  /** Сколько миграций применено и последняя из них. Пустая база — законное состояние. */
  migrations: { count: number; last: string | null };
  /** Таблиц в схеме public. Ноль означает «бот здесь ещё не запускался». */
  tables: number;
}

export interface ProbeFailure {
  ok: false;
  failure: StartupFailure;
  /** Что делать, словами. Тот же разбор, что и при старте бота. */
  message: string;
  error: unknown;
}

export type ProbeResult = ProbeSuccess | ProbeFailure;

/** Таблица drizzle с применёнными миграциями. Её отсутствие — не ошибка, а «база пустая». */
const MIGRATIONS_TABLE = 'drizzle.__drizzle_migrations';

/**
 * Пробует подключиться и рассказать, что нашла. Не бросает: отказ — это тоже результат
 * проверки, и разбирать его должен вызывающий, а не стек.
 *
 * Таймаут короткий нарочно. Проверку запускают руками и ждут ответа, а не уходят пить чай:
 * недоступная база должна сказать об этом за секунды.
 */
export async function probeDatabase(
  connectionString: string,
  options: { timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: options.timeoutMs ?? 8_000,
  });
  // Простаивающий клиент может умереть сам по себе, и без слушателя это необработанное
  // исключение — то есть проверка упала бы вместо ответа.
  pool.on('error', () => {});

  try {
    const client = await pool.connect();
    try {
      const version = await client.query<{ version: string; database: string }>(
        'select version() as version, current_database() as database',
      );

      // Шифрование спрашиваем у самой базы, а не выводим из строки подключения: в строке
      // может стоять одно, а на деле получиться другое.
      const ssl = await client
        .query<{ ssl: boolean }>('select ssl from pg_stat_ssl where pid = pg_backend_pid()')
        .catch(() => ({ rows: [] as { ssl: boolean }[] }));

      const tables = await client.query<{ count: string }>(
        "select count(*)::text as count from information_schema.tables where table_schema = 'public'",
      );

      // Таблицы миграций может не быть — это пустая база, и спрашивать её надо так, чтобы
      // отсутствие не выглядело сбоем.
      const migrations = await client
        .query<{ count: string; last: string | null }>(
          `select count(*)::text as count, max(hash) as last from ${MIGRATIONS_TABLE}`,
        )
        .catch(() => null);

      return {
        ok: true,
        version: version.rows[0]?.version ?? 'неизвестно',
        database: version.rows[0]?.database ?? 'неизвестно',
        encrypted: ssl.rows[0]?.ssl === true,
        migrations: {
          count: Number(migrations?.rows[0]?.count ?? 0),
          last: migrations?.rows[0]?.last ?? null,
        },
        tables: Number(tables.rows[0]?.count ?? 0),
      };
    } finally {
      client.release();
    }
  } catch (error) {
    const failure = classifyStartupFailure(error);
    return { ok: false, failure, message: describeFailure(failure), error };
  } finally {
    await pool.end().catch(() => {});
  }
}

/** Короткая версия сервера: из `version()` нужна первая часть, остальное — про сборку. */
export function shortVersion(version: string): string {
  const match = /^PostgreSQL \d+(\.\d+)?/.exec(version);
  return match?.[0] ?? version.slice(0, 40);
}

/**
 * Что делать дальше, исходя из найденного. Проверка бесполезна, если после неё непонятно,
 * готова база или нет.
 */
export function verdictOf(probe: ProbeSuccess): string {
  if (probe.tables === 0) {
    return 'база пустая — бот создаст таблицы сам при первом старте (MIGRATE_ON_START=true)';
  }
  if (probe.migrations.count === 0) {
    return 'в базе есть таблицы, но нет отметок о миграциях: похоже, это чужая база, а не бота — проверьте, что строка ведёт туда, куда нужно';
  }
  return `база готова: применено миграций ${probe.migrations.count}, таблиц ${probe.tables}`;
}
