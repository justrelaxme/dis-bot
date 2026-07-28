import { MessageFlags, SlashCommandBuilder } from 'discord.js';
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

export function createUnlinkCommand(deps: IdentityDeps): CommandDefinition {
  return {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('unlink')
      .setDescription('Отвязать игровой аккаунт и снять выданные за него роли')
      .addStringOption((option) =>
        option.setName('provider').setDescription('Какую привязку убрать').setRequired(true).addChoices(...PROVIDER_CHOICES),
      ),

    async execute(interaction) {
      const provider = interaction.options.getString('provider', true) as ProviderId;
      const userId = interaction.user.id;

      const removed = await deps.linking.unlinkAccount(userId, provider);
      if (!removed) {
        throw new UserError('У тебя не было такой привязки.');
      }

      // Роли снимаются пустым набором рангов: логика та же, что при синхронизации.
      // Свежий member берётся отдельным fetch — interaction.member в гильдийном
      // контексте бывает "частичным" (APIInteractionGuildMember без .roles.add/.remove).
      if (interaction.guild) {
        const member = await interaction.guild.members.fetch(userId);
        await deps.roles.applyRoles(member, interaction.guild.id, provider, []);
      }

      await deps.bus.emit('account.unlinked', { userId, provider });

      await interaction.followUp({
        content: 'Привязка убрана, выданные за неё роли сняты.',
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}
