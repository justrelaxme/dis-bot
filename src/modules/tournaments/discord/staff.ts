import { PermissionFlagsBits, type ActionRowBuilder, type ButtonBuilder, type Guild } from 'discord.js';
import type { Logger } from '../../../core/logger.js';
import type { TournamentRow, TournamentSettingsRow } from '../schema.js';
import type { TournamentSettingsService } from '../services/settings.js';

/**
 * Позвать человека. Спор, неявка, отказ, который бот сам не исправит, — всё это до сих пор
 * оставалось там, где случилось: спор висел в закрытой ветке матча, пока организатор случайно
 * туда не заглянет. Правило проекта — отказ виден тому, кто может его исправить, — здесь
 * исполняется буквально: сигнал уходит в канал штаба с упоминанием роли организаторов.
 *
 * Куда именно — по убыванию уместности: канал штаба из `/tournament settings`, иначе канал
 * объявлений турнира, иначе личка владельцу сервера. Кого звать — роль организаторов, иначе
 * владельца. Молчать нельзя ни в одном из случаев: сказать не туда лучше, чем не сказать.
 */

export interface StaffDeps {
  settings: Pick<TournamentSettingsService, 'get'>;
  /** Гасит повторы одного и того же сигнала: джобы тикают раз в минуту. */
  cache?: { incrementInWindow(key: string, windowMs: number): Promise<number> };
  logger: Logger;
}

/** Участник в объёме, нужном для проверки права. */
export interface OrganizerCandidate {
  permissions: { has(permission: bigint): boolean } | string;
  roles: { cache: { has(roleId: string): boolean } } | string[];
}

/**
 * Организатор — тот, у кого «Управление сервером», или тот, у кого роль организаторов. Роль
 * нужна затем, чтобы разбирать споры могли и те, кому доверили турниры, но не весь сервер.
 */
export function isOrganizer(member: OrganizerCandidate | null, settings: TournamentSettingsRow | null): boolean {
  if (!member) return false;
  if (typeof member.permissions !== 'string' && member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return true;
  }
  const roleId = settings?.organizerRoleId;
  if (!roleId) return false;
  return Array.isArray(member.roles) ? member.roles.includes(roleId) : member.roles.cache.has(roleId);
}

export interface StaffAlert {
  text: string;
  tournament?: TournamentRow | null;
  /** Одинаковые сигналы с этим ключом внутри окна уходят один раз. */
  dedupeKey?: string;
  dedupeMs?: number;
  /**
   * Кнопки решения — «техпобеда», «переиграть». Только в канале: в личке у кнопки нет сервера,
   * и решать оттуда нечем, — поэтому там текст с командой.
   */
  components?: ActionRowBuilder<ButtonBuilder>[];
}

export type StaffDelivery = 'sent' | 'deduped' | 'nowhere';

const DEFAULT_DEDUPE_MS = 60 * 60 * 1_000;

export async function staffAlert(deps: StaffDeps, guild: Guild, alert: StaffAlert): Promise<StaffDelivery> {
  if (alert.dedupeKey && deps.cache) {
    const seen = await deps.cache
      .incrementInWindow(`staff:${guild.id}:${alert.dedupeKey}`, alert.dedupeMs ?? DEFAULT_DEDUPE_MS)
      .catch(() => 1);
    if (seen > 1) return 'deduped';
  }

  const settings = await deps.settings.get(guild.id).catch(() => null);
  const roleId = settings?.organizerRoleId ?? null;
  const mention = roleId ? `<@&${roleId}>` : `<@${guild.ownerId}>`;
  const content = `${mention} ${alert.text}`;
  const allowedMentions = roleId ? { roles: [roleId] } : { users: [guild.ownerId] };

  for (const channelId of [settings?.staffChannelId, alert.tournament?.announceChannelId]) {
    if (!channelId) continue;
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isSendable()) continue;
    const sent = await channel
      .send({ content, allowedMentions, ...(alert.components ? { components: alert.components } : {}) })
      .then(() => true)
      .catch((error: unknown) => {
        deps.logger.warn({ err: error, channelId }, 'сигнал в штаб не отправился в канал');
        return false;
      });
    if (sent) return 'sent';
  }

  // Каналов нет или они недоступны — владельцу в личку. Это последний адресат: он может и
  // задать канал штаба, и выдать боту права.
  const owner = await guild.fetchOwner().catch(() => null);
  const delivered = await owner
    ?.send(`${alert.text}\n\n_Канал штаба не задан или недоступен — поэтому в личку. Задать: \`/tournament settings\`._`)
    .then(() => true)
    .catch(() => false);
  if (delivered) return 'sent';

  deps.logger.error({ guildId: guild.id, text: alert.text }, 'сигнал в штаб некуда отправить');
  return 'nowhere';
}
