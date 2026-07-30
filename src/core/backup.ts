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
 * Запускает `pg_dump` и пишет сжатый дамп. Пароль передаётся через переменную окружения
 * дочернего процесса, а не в аргументах: аргументы видны в списке процессов любому, кто
 * может его посмотреть.
 */
export async function runBackup(options: BackupOptions): Promise<BackupResult> {
  const now = options.now ?? new Date();
  await mkdir(options.directory, { recursive: true });

  const file = join(options.directory, backupFileName(now));
  const child = spawn(
    'pg_dump',
    ['--no-owner', '--no-privileges', '--format=plain', options.databaseUrl],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

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

  const code = await exited;
  if (code !== 0) {
    await unlink(file).catch(() => undefined);
    const detail = errors.join('').trim().slice(0, 500);
    throw new Error(`pg_dump завершился с кодом ${code}${detail ? `: ${detail}` : ''}`);
  }

  const info = await stat(file);
  const removed = await rotate(options.directory, options.keepDays, now, options.logger);
  return { file, bytes: info.size, removed };
}
