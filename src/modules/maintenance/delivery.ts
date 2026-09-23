import { PermissionFlagsBits, type Client } from 'discord.js';
import { BACKUP_PART_LIMIT, planParts } from '../../core/backup.js';

/**
 * Доставка дампа туда, что переживает контейнер: в закрытый канал Discord.
 *
 * Почему Discord, а не хранилище. Бэкап, лежащий в каталоге контейнера, исчезает при первом
 * же обновлении бота, а заводить ради сотен килобайт S3 с ключами — значит завести ещё одну
 * вещь, которая однажды молча перестанет работать. Клиент Discord у бота уже есть, файлы
 * Discord хранит бессрочно, и владелец видит каждую ночь, что бэкап пришёл.
 *
 * Цена одна и серьёзная: дамп — это вся база, включая привязки игровых аккаунтов. Поэтому
 * в канал, который видит @everyone, бот дамп не отправит ни при каких обстоятельствах, а
 * скажет об этом в тот же канал — иначе «бэкапа нет» выглядело бы как «бэкап сломан».
 */

export interface BackupChannel {
  /** Видит ли канал любой участник сервера. */
  readonly public: boolean;
  send(payload: {
    content: string;
    files?: Array<{ attachment: Buffer; name: string }>;
  }): Promise<unknown>;
}

export type ChannelLookup = { ok: true; channel: BackupChannel } | { ok: false; reason: string };

/**
 * Канал для бэкапов и то, годится ли он. Отказы названы так, чтобы их можно было исправить,
 * не открывая код: какого права не хватает и где.
 */
export async function findBackupChannel(client: Client, channelId: string): Promise<ChannelLookup> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    return { ok: false, reason: `канал ${channelId} не найден или бот его не видит (BACKUP_CHANNEL_ID)` };
  }
  if (channel.isDMBased() || !channel.isSendable()) {
    return { ok: false, reason: `в канал ${channelId} нельзя отправлять сообщения — нужен текстовый канал сервера` };
  }

  const me = channel.guild.members.me;
  const mine = me ? channel.permissionsFor(me) : null;
  if (!mine?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles])) {
    return {
      ok: false,
      reason: `у бота нет прав «Отправлять сообщения» и «Прикреплять файлы» в <#${channelId}>`,
    };
  }

  // Неизвестное считаем открытым: ошибиться в сторону «не отправил» можно, в обратную — нет.
  const everyone = channel.permissionsFor(channel.guild.roles.everyone);
  const isPublic = everyone?.has(PermissionFlagsBits.ViewChannel) ?? true;

  return {
    ok: true,
    channel: {
      public: isPublic,
      send: (payload) => channel.send(payload),
    },
  };
}

export interface DumpToDeliver {
  /** Имя файла дампа, например `disbot-2026-09-23-0400.sql.gz`. */
  name: string;
  data: Buffer;
  now: Date;
}

export type DeliveryResult = { sent: true; parts: number } | { sent: false; reason: string };

function megabytes(bytes: number): string {
  return `${(Math.round((bytes / 1_048_576) * 100) / 100).toLocaleString('ru-RU')} МБ`;
}

/**
 * Отправляет дамп частями по одной на сообщение. По одной, а не пачкой: предел Discord
 * считается и на файл, и на запрос целиком, и десять частей в одном сообщении упёрлись бы во
 * второй.
 *
 * Части нумеруются с ведущим нулём, чтобы `cat имя.part*` склеивал их в правильном порядке:
 * без нуля оболочка поставила бы десятую часть перед второй.
 */
export async function deliverBackup(
  channel: BackupChannel,
  dump: DumpToDeliver,
  limit: number = BACKUP_PART_LIMIT,
): Promise<DeliveryResult> {
  if (channel.public) {
    const reason =
      'этот канал видит @everyone, а дамп — это вся база, включая привязки аккаунтов. Закройте канал для @everyone, оставив доступ боту и владельцу.';
    await channel.send({ content: `⚠️ Бэкап базы снят, но сюда не отправлен: ${reason}` });
    return { sent: false, reason };
  }

  const parts = planParts(dump.data.length, limit);
  if (parts.length === 0) return { sent: false, reason: 'дамп пустой — отправлять нечего' };

  const when = dump.now.toISOString().slice(0, 16).replace('T', ' ');
  const restore =
    parts.length === 1
      ? `Восстановление: \`gunzip -c ${dump.name} | psql "$DATABASE_URL"\``
      : `Склеить по порядку: \`cat ${dump.name}.part* > ${dump.name}\`, затем \`gunzip -c ${dump.name} | psql "$DATABASE_URL"\``;
  const header = [
    `🗄️ Бэкап базы · ${when} UTC · ${megabytes(dump.data.length)}${parts.length > 1 ? ` · ${parts.length} части` : ''}`,
    restore,
    ...(parts.length > 1
      ? ['База переросла одно вложение Discord. Пока это не мешает, но стоит знать, что она растёт.']
      : []),
  ].join('\n');

  for (const [index, [start, end]] of parts.entries()) {
    const name = parts.length === 1 ? dump.name : `${dump.name}.part${String(index + 1).padStart(2, '0')}`;
    await channel.send({
      content: index === 0 ? header : `Часть ${index + 1} из ${parts.length}`,
      files: [{ attachment: dump.data.subarray(start, end), name }],
    });
  }

  return { sent: true, parts: parts.length };
}
