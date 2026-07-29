import { DiscordAPIError, MessageFlags, RESTJSONErrorCodes, SlashCommandBuilder } from 'discord.js';
import type { Guild, GuildMember } from 'discord.js';
import { UserError } from '../../../core/errors.js';
import type { CommandDefinition } from '../../../core/module.js';
import type { ProviderId } from '../schema.js';
import type { IdentityDeps } from './link.js';

const PROVIDER_CHOICES: Array<{ name: string; value: ProviderId }> = [
  { name: 'Steam / Dota 2', value: 'steam' },
  { name: 'League of Legends', value: 'riot-lol' },
  { name: 'Teamfight Tactics', value: 'riot-tft' },
  { name: 'Valorant', value: 'riot-valorant' },
];

const PROVIDER_LABELS: Record<ProviderId, string> = {
  steam: 'Steam / Dota 2',
  'riot-lol': 'League of Legends',
  'riot-tft': 'Teamfight Tactics',
  'riot-valorant': 'Valorant',
};

/**
 * /link riot одним подтверждением создаёт сразу две привязки — riot-lol и riot-tft
 * делят общий PUUID и общее доказательство владения (см. commands/link.ts). Раз они
 * привязываются вместе одной командой, отвязывать их нужно тоже вместе: иначе игрок
 * мог бы отвязать «League of Legends», услышать «привязка убрана, роли сняты», а
 * riot-tft остался бы привязан как ни в чём не бывало — продолжал бы синхронизироваться
 * и выдавать роли за TFT, хотя игрок уверен, что отвязался полностью.
 */
const RIOT_PAIR: readonly ProviderId[] = ['riot-lol', 'riot-tft'];

function groupFor(provider: ProviderId): readonly ProviderId[] {
  return RIOT_PAIR.includes(provider) ? RIOT_PAIR : [provider];
}

/**
 * null означает «снимать физически не с кого и не с чего» (участник вышел с сервера
 * между командами) — это не сбой отвязки. Настоящий сбой fetch (Discord недоступен,
 * иная ошибка API) обязан пробрасываться дальше как есть, а не тихо трактоваться так
 * же: иначе за «участника нет» выдавался бы и временный сетевой сбой, при котором
 * участник на месте, а мы просто не смогли его увидеть.
 */
async function fetchMemberOrNull(guild: Guild, userId: string): Promise<GuildMember | null> {
  try {
    return await guild.members.fetch(userId);
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMember) {
      return null;
    }
    throw error;
  }
}

export function createUnlinkCommand(deps: IdentityDeps): CommandDefinition {
  return {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('unlink')
      .setDescription('Отвязать игровой аккаунт и снять выданные за него роли')
      .addStringOption((option) =>
        option.setName('provider').setDescription('Какую привязку убрать').setRequired(true).addChoices(...PROVIDER_CHOICES),
      ),

    async execute(interaction, ctx) {
      const requested = interaction.options.getString('provider', true) as ProviderId;
      const userId = interaction.user.id;

      // riot-lol/riot-tft отвязываются парой (см. RIOT_PAIR выше), но пара могла уже
      // быть неполной — например, из-за старого частичного сбоя /link riot, когда
      // вторая из двух привязок не сохранилась. Поэтому берём только те провайдеры
      // группы, что реально привязаны сейчас (listAccounts), а не дёргаем unlinkAccount
      // для обоих вслепую.
      const group = groupFor(requested);
      const accounts = await deps.linking.listAccounts(userId);
      const present = group.filter((provider) => accounts.some((a) => a.provider === provider));

      if (present.length === 0) {
        throw new UserError('У тебя не было такой привязки.');
      }

      // Роли снимаются, пока привязки ещё в БД, а НЕ после их удаления. Раньше
      // unlinkAccount уже возвращал true, и только потом шли guild.members.fetch и
      // roles.remove — если они падали (нет права Manage Roles, роль бота ниже
      // снимаемой), получалось противоречивое состояние: БД говорит «отвязано»,
      // account.unlinked уже опубликован, а роли всё ещё висят на игроке — и снять их
      // больше нечем, потому что маппинг для уже отвязанного провайдера не применяется.
      // Теперь при сбое здесь исполнение прерывается ДО unlinkAccount и ДО emit —
      // ни БД, ни событие не меняются, отвязку можно просто повторить после починки прав.
      if (interaction.guild) {
        const guild = interaction.guild;
        try {
          const member = await fetchMemberOrNull(guild, userId);
          if (member) {
            for (const provider of present) {
              await deps.roles.applyRoles(member, guild.id, provider, []);
            }
          }
        } catch (error) {
          ctx.logger.warn(
            { err: error, userId, guildId: guild.id, providers: present },
            'не удалось снять роли при отвязке аккаунта — привязка оставлена как есть',
          );
          throw new UserError(
            'Не получилось снять роли за эту привязку — возможно, у бота нет права «Управление ролями», ' +
              'его роль стоит ниже снимаемой в списке ролей сервера, либо Discord сейчас недоступен. ' +
              'Привязка не тронута, роли не менялись — поправь права бота (или порядок ролей) и повтори ' +
              'команду, либо обратись к администратору.',
          );
        }
      }

      const removed: ProviderId[] = [];
      for (const provider of present) {
        if (await deps.linking.unlinkAccount(userId, provider)) removed.push(provider);
      }

      for (const provider of removed) {
        await deps.bus.emit('account.unlinked', { userId, provider });
      }

      // Честно про частичность: если часть пары не была привязана (riot-tft
      // отсутствовал из-за старого сбоя /link riot), это стоит сказать прямо, а не
      // тем же текстом, что и при полной отвязке.
      const missing = group.filter((provider) => !present.includes(provider));
      const tail =
        missing.length > 0 ? ` ${missing.map((provider) => PROVIDER_LABELS[provider]).join(', ')} и так не было привязано.` : '';

      await interaction.followUp({
        content: `Привязка убрана, выданные за неё роли сняты.${tail}`,
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}
