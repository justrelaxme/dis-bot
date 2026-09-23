import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import type { Logger } from './logger.js';

/**
 * Бэкап базы. Потеря Postgres здесь означает безвозвратную потерю уровней, монет,
 * достижений и всей турнирной летописи — то есть всего, что нельзя восстановить ни из
 * Discord, ни из API игр. Привязки и ранги подтянутся заново, а история нет.
 *
 * Дамп делает `pg_dump`, а не свой обход таблиц. Свой обход — это код, от которого зависит
 * возможность восстановиться, и проверять его пришлось бы вечно; `pg_dump` уже проверен
 * всеми, и его вывод принимает `psql` без нашего участия. Цена — бинарь в образе.
 *
 * Отказ бэкапа никогда не роняет бота: не сделанный вчера бэкап хуже, чем не сделанный
 * сегодня, но остановившийся бот хуже обоих.
 */

export interface BackupOptions {
  databaseUrl: string;
  /** Куда складывать. Создаётся, если нет. */
  directory: string;
  /** Сколько дней хранить. Без ротации диск кончится молча. */
  keepDays: number;
  logger: Logger;
  /** Для тестов и ручного запуска: метка времени в имени файла. */
  now?: Date;
}

export interface BackupResult {
  file: string;
  bytes: number;
  removed: string[];
}

const PREFIX = 'disbot-';
const SUFFIX = '.sql.gz';

/** Имя файла с временем в UTC: сортировка по имени совпадает с сортировкой по времени. */
export function backupFileName(now: Date): string {
  const iso = now.toISOString();
  return `${PREFIX}${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${SUFFIX}`;
}

/**
 * Удаляет дампы старше `keepDays`. Считаем по времени изменения файла, а не по имени:
 * имя можно поменять руками, а вопрос «что удалять» должен решаться по факту.
 */
async function rotate(directory: string, keepDays: number, now: Date, logger: Logger): Promise<string[]> {
  if (keepDays <= 0) return [];
  const deadline = now.getTime() - keepDays * 24 * 60 * 60 * 1_000;
  const removed: string[] = [];

  for (const name of await readdir(directory)) {
    if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) continue;
    const path = join(directory, name);
    try {
      const info = await stat(path);
      if (info.mtimeMs >= deadline) continue;
      await unlink(path);
      removed.push(name);
    } catch (error) {
      // Файл уже удалён или занят — это не повод прерывать ротацию остальных.
      logger.warn({ err: error, file: name }, 'старый дамп не удалился');
    }
  }
  return removed;
}

/**
 * Пароль отдельно от адреса. Адрес уходит аргументом `pg_dump`, а аргументы видит любой, кто
 * может посмотреть список процессов; пароль поэтому едет в `PGPASSWORD` дочернего процесса.
 * Адрес, который не разобрался как URL, отдаётся как есть — пусть `pg_dump` скажет, что с
 * ним не так, своими словами.
 */
export function splitPassword(databaseUrl: string): { url: string; password: string | null } {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return { url: databaseUrl, password: null };
  }
  if (!parsed.password) return { url: databaseUrl, password: null };
  const password = decodeURIComponent(parsed.password);
  parsed.password = '';
  return { url: parsed.toString(), password };
}

/**
 * Запускает `pg_dump` и пишет сжатый дамп. Пароль передаётся через переменную окружения
 * дочернего процесса, а не в аргументах: аргументы видны в списке процессов любому, кто
 * может его посмотреть.
 */
export async function runBackup(options: BackupOptions): Promise<BackupResult> {
  const now = options.now ?? new Date();
  await mkdir(options.directory, { recursive: true });

  const file = join(options.directory, backupFileName(now));
  const target = splitPassword(options.databaseUrl);
  const child = spawn('pg_dump', ['--no-owner', '--no-privileges', '--format=plain', target.url], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(target.password ? { PGPASSWORD: target.password } : {}) },
  });

  const errors: string[] = [];
  child.stderr.on('data', (chunk: Buffer) => {
    errors.push(chunk.toString());
  });

  const exited = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });

  try {
    await pipeline(child.stdout, createGzip(), createWriteStream(file));
  } catch (error) {
    child.kill();
    // Незавершённый файл хуже отсутствующего: он выглядит бэкапом и не является им.
    await unlink(file).catch(() => undefined);
    throw error;
  }

  let code: number;
  try {
    code = await exited;
  } catch (error) {
    // Процесс не запустился вовсе (нет pg_dump): файл при этом уже создан пустым.
    await unlink(file).catch(() => undefined);
    throw error;
  }
  if (code !== 0) {
    await unlink(file).catch(() => undefined);
    const detail = errors.join('').trim().slice(0, 500);
    throw new Error(`pg_dump завершился с кодом ${code}${detail ? `: ${detail}` : ''}`);
  }

  const info = await stat(file);
  const removed = await rotate(options.directory, options.keepDays, now, options.logger);
  return { file, bytes: info.size, removed };
}

/**
 * Предел одного вложения, с запасом. У бота на сервере без бустов Discord принимает файлы
 * до 10 МиБ; полмегабайта запаса — на то, что сверх самих байтов уходит в запрос.
 */
export const BACKUP_PART_LIMIT = Math.floor(9.5 * 1_048_576);

/**
 * Как порезать дамп на вложения: границы `[start, end)` по порядку. Резать приходится по
 * байтам, а не по строкам SQL — файл сжат, — поэтому части склеиваются обратно простым
 * `cat` в том же порядке, а не поштучно.
 */
export function planParts(bytes: number, limit: number = BACKUP_PART_LIMIT): Array<[number, number]> {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('предел части должен быть положительным');
  if (bytes <= 0) return [];
  const parts: Array<[number, number]> = [];
  for (let start = 0; start < bytes; start += limit) {
    parts.push([start, Math.min(start + limit, bytes)]);
  }
  return parts;
}

/**
 * Отказ бэкапа словами того, кто будет его чинить. Сырое `spawn pg_dump ENOENT` верно, но
 * ничего не говорит человеку, который открыл канал бэкапов утром и увидел, что файла нет.
 */
export function explainBackupFailure(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);

  if (code === 'ENOENT' && /pg_dump/u.test(message)) {
    return 'в окружении бота нет `pg_dump`. В образе из Dockerfile он есть; если хостинг собирает бота без Dockerfile, нужен пакет клиента PostgreSQL той же версии, что и сервер.';
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `нет прав на запись в каталог для дампа (${message}). Задайте BACKUP_DIR с правом записи или оставьте пустым — тогда возьмётся временный каталог системы.`;
  }
  if (/server version mismatch/iu.test(message)) {
    return 'версия `pg_dump` старше версии сервера базы, и дамп он делать отказывается. Нужен клиент PostgreSQL не старше сервера.';
  }
  if (/password authentication failed/iu.test(message)) {
    return 'база не приняла пароль. Проверьте BACKUP_DATABASE_URL (или DATABASE_URL, если отдельной строки нет).';
  }
  if (/prepared statement|pgbouncer|transaction pool/iu.test(message)) {
    return 'дамп через transaction pooler не работает. Укажите в BACKUP_DATABASE_URL session pooler (порт 5432) или прямое подключение.';
  }
  return message.slice(0, 500);
}
