/**
 * Разовый бэкап базы руками — тем же кодом, что и по расписанию. Нужен для двух вещей:
 * снять дамп перед рискованной операцией и проверить, что бэкап вообще работает, не
 * дожидаясь четырёх утра.
 *
 * Запуск: npm run backup
 */
import { loadConfig } from '../src/core/config.js';
import { runBackup } from '../src/core/backup.js';
import { createLogger } from '../src/core/logger.js';

const config = loadConfig();
const logger = createLogger(config);

const result = await runBackup({
  databaseUrl: config.DATABASE_URL,
  directory: config.BACKUP_DIR,
  keepDays: config.BACKUP_KEEP_DAYS,
  logger,
});

logger.info(
  {
    файл: result.file,
    мегабайт: Math.round((result.bytes / 1_048_576) * 100) / 100,
    удалено_старых: result.removed.length,
  },
  'бэкап готов; восстановление: gunzip -c <файл> | psql "$DATABASE_URL"',
);
