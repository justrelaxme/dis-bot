import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type TextChannel,
  type VoiceChannel,
} from 'discord.js';
import type { Logger } from '../../../core/logger.js';

/**
 * Комнаты турнира. Их две, и одна другую не заменяет.
 *
 * Голосовой канал команды — приватный, живёт весь турнир, туда пускает только состав.
 * Ссылки на лобби и пароли идут во встроенный чат голосового канала, поэтому отдельный
 * текстовый канал на команду не нужен.
 *
 * Ветка матча — куда пускает **обе** команды пары. Каналы команд приватные, значит
 * соперники иначе не свяжутся, а им надо договориться о лобби, пароле и времени.
 *
 * Ничего из этого не является носителем состояния: результат живёт в базе. Поэтому отказ
 * Discord при создании комнаты не отменяет матч, а отказ при уборке не мешает закрыть
 * турнир — иначе незакрытый из-за канала турнир заблокировал бы завтрашний цикл.
 */

export interface TeamRoom {
  entrantId: number;
  channelId: string | null;
}

export interface ChannelsGateway {
  createTeamVoice(input: {
    guild: Guild;
    categoryId: string | null;
    tournamentName: string;
    entrantId: number;
    teamName: string;
    memberIds: string[];
  }): Promise<string | null>;
  createMatchThread(input: {
    guild: Guild;
    parentId: string | null;
    title: string;
    memberIds: string[];
  }): Promise<string | null>;
  archiveThread(guild: Guild, threadId: string): Promise<void>;
  deleteChannel(guild: Guild, channelId: string): Promise<void>;
}

/** Discord обрезает имена каналов; режем сами, чтобы имя оставалось узнаваемым. */
function channelName(prefix: string, name: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'команда';
  return `${prefix}${cleaned}`.slice(0, 90);
}

export function createChannelsGateway(logger: Logger): ChannelsGateway {
  return {
    async createTeamVoice(input): Promise<string | null> {
      try {
        const channel = await input.guild.channels.create({
          name: channelName('🎧 ', input.teamName),
          type: ChannelType.GuildVoice,
          ...(input.categoryId ? { parent: input.categoryId } : {}),
          permissionOverwrites: [
            // Всем — закрыто: и видеть, и войти. Иначе «приватный канал команды»
            // приватен только на словах.
            {
              id: input.guild.roles.everyone.id,
              deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
            },
            ...input.memberIds.map((id) => ({
              id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.Speak,
                PermissionFlagsBits.SendMessages,
              ],
            })),
          ],
          reason: `Турнир «${input.tournamentName}»: комната команды`,
        });
        return channel.id;
      } catch (error) {
        // Нет прав, исчерпан лимит каналов, категория удалена — играть это не мешает.
        logger.warn({ err: error, entrantId: input.entrantId }, 'не удалось создать голосовой канал команды');
        return null;
      }
    },

    async createMatchThread(input): Promise<string | null> {
      if (!input.parentId) return null;
      try {
        const parent = await input.guild.channels.fetch(input.parentId);
        if (!parent || parent.type !== ChannelType.GuildText) return null;

        const thread = await (parent as TextChannel).threads.create({
          name: input.title.slice(0, 100),
          type: ChannelType.PrivateThread,
          invitable: false,
          reason: 'Комната матча: соперникам нужно договориться о лобби',
        });

        for (const id of input.memberIds) {
          // Добавление участника может отказать по одному человеку (ушёл с сервера) —
          // это не повод не создавать комнату для остальных.
          try {
            await thread.members.add(id);
          } catch (error) {
            logger.warn({ err: error, userId: id }, 'не удалось добавить игрока в ветку матча');
          }
        }
        return thread.id;
      } catch (error) {
        logger.warn({ err: error }, 'не удалось создать ветку матча');
        return null;
      }
    },

    async archiveThread(guild, threadId): Promise<void> {
      try {
        const thread = await guild.channels.fetch(threadId);
        if (thread?.isThread()) await thread.setArchived(true, 'Матч завершён');
      } catch (error) {
        logger.warn({ err: error, threadId }, 'не удалось заархивировать ветку матча');
      }
    },

    async deleteChannel(guild, channelId): Promise<void> {
      try {
        const channel = await guild.channels.fetch(channelId);
        // Уже удалён руками — это не ошибка уборки.
        if (channel) await channel.delete('Турнир завершён: уборка комнат');
      } catch (error) {
        logger.warn({ err: error, channelId }, 'не удалось удалить канал турнира');
      }
    },
  };
}

/** Тип нужен только для сужения: голосовой канал у нас всегда гильдейский. */
export type TournamentVoiceChannel = VoiceChannel;
