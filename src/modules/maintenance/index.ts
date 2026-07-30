import { runBackup } from '../../core/backup.js';
import type { Config } from '../../core/config.js';
import type { BotModule } from '../../core/module.js';

/**
 * Обслуживание: то, что должно происходить само и о чём никто не помнит, пока не станет
 * поздно. Пока здесь один пункт — бэкап базы.
 *
 * Джоба живёт в модуле, а не рядом с планировщиком, потому что модули — единственный
 * способ объявить джобу в этом проекте, и завести ради бэкапа второй механизм означало бы
 * два места, где что-то запускается по расписанию.
 *
 * Ни команд, ни событий: настраивать нечего, всё в переменных окружения. Расписание
 * бэкапа — это решение того, кто разворачивает бота, а не администратора сервера в Discord.
 */
export function createMaintenanceModule(deps: { config: Config }): BotModule {
  const { config } = deps;

  return {
    name: 'maintenance',

    jobs: config.BACKUP_ENABLED
      ? [
          {
            name: 'maintenance:backup',
            cron: config.BACKUP_CRON,
            async run(ctx): Promise<void> {
              try {
                const result = await runBackup({
                  databaseUrl: config.DATABASE_URL,
                  directory: config.BACKUP_DIR,
                  keepDays: config.BACKUP_KEEP_DAYS,
                  logger: ctx.logger,
                });
                ctx.logger.info(
                  {
                    file: result.file,
                    megabytes: Math.round((result.bytes / 1_048_576) * 100) / 100,
                    removed: result.removed.length,
                  },
                  'бэкап базы сделан',
                );
              } catch (error) {
                // Не сделанный бэкап — плохо, упавший из-за него бот — хуже. Поэтому
                // только громкая запись в лог: она и есть сигнал, что надо разобраться.
                ctx.logger.error(
                  { err: error, directory: config.BACKUP_DIR },
                  'бэкап базы не сделан — проверьте, что в образе есть pg_dump и есть права на запись',
                );
              }
            },
          },
        ]
      : [],
  };
}
