import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { explainBackupFailure, runBackup } from '../../core/backup.js';
import type { Config } from '../../core/config.js';
import type { Database } from '../../core/db/client.js';
import type { BotModule, CommandDefinition, ModuleContext, ScheduledJob } from '../../core/module.js';
import { createGrantsService } from '../web/grants.js';
import { deliverBackup, findBackupChannel } from './delivery.js';

/**
 * Обслуживание: то, что должно происходить само и о чём никто не помнит, пока не станет
 * поздно. Сейчас здесь два пункта — бэкап базы и уборка просроченных пропусков на витрину.
 *
 * Джобы живут в модуле, а не рядом с планировщиком, потому что модули — единственный
 * способ объявить джобу в этом проекте, и завести ради бэкапа второй механизм означало бы
 * два места, где что-то запускается по расписанию.
 *
 * Настройки — в переменных окружения: расписание бэкапа и канал для него решает тот, кто
 * разворачивает бота, а не администратор сервера в Discord. Команда одна — `/backup`, снять
 * дамп сейчас: перед рискованной операцией и чтобы убедиться, что бэкап вообще доходит, не
 * дожидаясь четырёх утра.
 */

/** Раз в сутки, ночью: пропуски живут сутки, и чаще проверять нечего. */
const GRANT_SWEEP_CRON = '17 4 * * *';

export function createMaintenanceModule(deps: { config: Config; db: Database }): BotModule {
  const { config } = deps;
  const grants = createGrantsService({ db: deps.db });

  /**
   * Просроченные пропуски в конструктор форматов. Уборка нужна не для безопасности —
   * просроченный пропуск и так не действует, это проверяет `owner` в grants.ts, — а для
   * того, чтобы таблица не росла вечно.
   */
  const sweepGrants: ScheduledJob = {
    name: 'maintenance:grants-sweep',
    cron: GRANT_SWEEP_CRON,
    async run(ctx): Promise<void> {
      const removed = await grants.sweepExpired(new Date());
      if (removed > 0) ctx.logger.info({ removed }, 'просроченные пропуски на витрину убраны');
    },
  };

  /** Один бэкап за раз: ручной запуск посреди ночного делал бы два дампа в одну минуту. */
  let running: Promise<BackupOutcome> | null = null;

  /**
   * Снять дамп и доставить его. Итог — одна фраза для того, кто спросил: владельцу в ответ
   * на `/backup` и в лог для ночной джобы. Отказ на любом шаге называется словами, а в
   * канал бэкапов уходит тоже: утром там должно быть видно либо файл, либо причину.
   */
  async function backupAndDeliver(ctx: ModuleContext): Promise<BackupOutcome> {
    const lookup = config.BACKUP_CHANNEL_ID ? await findBackupChannel(ctx.client, config.BACKUP_CHANNEL_ID) : null;
    if (lookup && !lookup.ok) ctx.logger.error({ reason: lookup.reason }, 'канал для бэкапов не годится');

    let result: Awaited<ReturnType<typeof runBackup>>;
    try {
      result = await runBackup({
        databaseUrl: config.BACKUP_DATABASE_URL ?? config.DATABASE_URL,
        directory: config.BACKUP_DIR,
        keepDays: config.BACKUP_KEEP_DAYS,
        logger: ctx.logger,
      });
    } catch (error) {
      const reason = explainBackupFailure(error);
      // Не сделанный бэкап — плохо, упавший из-за него бот — хуже: только запись и сигнал.
      ctx.logger.error({ err: error, reason }, 'бэкап базы не сделан');
      if (lookup?.ok) {
        await lookup.channel
          .send({ content: `❌ Бэкап базы не сделан: ${reason}` })
          .catch((sendError: unknown) => ctx.logger.error({ err: sendError }, 'и сообщить об этом в канал не вышло'));
      }
      return { ok: false, text: `Бэкап не сделан: ${reason}` };
    }

    ctx.logger.info(
      { file: result.file, megabytes: Math.round((result.bytes / 1_048_576) * 100) / 100, removed: result.removed.length },
      'дамп базы снят',
    );

    if (!lookup) {
      ctx.logger.warn('BACKUP_CHANNEL_ID не задан: дамп лежит в каталоге контейнера и пропадёт при обновлении');
      return {
        ok: false,
        text: 'Дамп снят, но канал для бэкапов не задан (`BACKUP_CHANNEL_ID`). Файл лежит в каталоге контейнера и пропадёт при первом обновлении бота.',
      };
    }
    if (!lookup.ok) return { ok: false, text: `Дамп снят, но не отправлен: ${lookup.reason}.` };

    try {
      const delivery = await deliverBackup(lookup.channel, {
        name: basename(result.file),
        data: await readFile(result.file),
        now: new Date(),
      });
      if (!delivery.sent) return { ok: false, text: `Дамп снят, но не отправлен: ${delivery.reason}` };
      ctx.logger.info({ parts: delivery.parts }, 'бэкап базы отправлен в канал');
      return {
        ok: true,
        text: `Бэкап отправлен в <#${config.BACKUP_CHANNEL_ID}>${delivery.parts > 1 ? ` частями: ${delivery.parts}` : ''}.`,
      };
    } catch (error) {
      ctx.logger.error({ err: error }, 'дамп снят, но в канал не ушёл');
      return {
        ok: false,
        text: `Дамп снят, но в канал не ушёл: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  function once(ctx: ModuleContext): { outcome: Promise<BackupOutcome>; joined: boolean } {
    if (running) return { outcome: running, joined: true };
    running = backupAndDeliver(ctx).finally(() => {
      running = null;
    });
    return { outcome: running, joined: false };
  }

  const backup: ScheduledJob = {
    name: 'maintenance:backup',
    cron: config.BACKUP_CRON,
    async run(ctx): Promise<void> {
      await once(ctx).outcome;
    },
  };

  const backupCommand: CommandDefinition = {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('backup')
      .setDescription('Снять бэкап базы сейчас и отправить его в закрытый канал бэкапов')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction, ctx): Promise<void> {
      const { outcome, joined } = once(ctx);
      const result = await outcome;
      await interaction.editReply({
        content: `${joined ? 'Бэкап уже шёл — дождался его. ' : ''}${result.ok ? '✅' : '⚠️'} ${result.text}`,
      });
    },
  };

  return {
    name: 'maintenance',
    commands: [backupCommand],
    jobs: config.BACKUP_ENABLED ? [sweepGrants, backup] : [sweepGrants],
  };
}

interface BackupOutcome {
  ok: boolean;
  text: string;
}
