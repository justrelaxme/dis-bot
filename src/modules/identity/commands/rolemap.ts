import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { UserError } from '../../../core/errors.js';
import type { CommandDefinition } from '../../../core/module.js';
import { DOTA_MEDALS } from '../ranks/dota.js';
import { RIOT_TIERS, VALORANT_TIERS } from '../ranks/riot.js';
import type { ProviderId } from '../schema.js';
import type { RoleMappingService } from '../services/role-mapping.js';

const PROVIDER_CHOICES: Array<{ name: string; value: ProviderId }> = [
  { name: 'Steam / Dota 2', value: 'steam' },
  { name: 'League of Legends', value: 'riot-lol' },
  { name: 'Teamfight Tactics', value: 'riot-tft' },
  { name: 'Valorant', value: 'riot-valorant' },
];

const MODE_CHOICES = [
  { name: 'LoL: соло/дуо', value: 'solo-duo' },
  { name: 'LoL: гибкая', value: 'flex' },
  { name: 'TFT: рейтинг', value: 'tft-ranked' },
  { name: 'Dota 2: медаль', value: 'dota-mmr' },
  { name: 'Valorant: соревновательный', value: 'val-competitive' },
];

function tiersFor(provider: ProviderId): readonly string[] {
  if (provider === 'steam') return DOTA_MEDALS;
  if (provider === 'riot-valorant') return VALORANT_TIERS;
  return RIOT_TIERS;
}

export function createRoleMapCommand(deps: { roles: RoleMappingService }): CommandDefinition {
  return {
    builder: new SlashCommandBuilder()
      .setName('rolemap')
      .setDescription('Настроить выдачу ролей по игровому рангу')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Привязать роль к рангу')
          .addStringOption((option) =>
            option.setName('provider').setDescription('Игра').setRequired(true).addChoices(...PROVIDER_CHOICES),
          )
          .addStringOption((option) =>
            option.setName('mode').setDescription('Режим').setRequired(true).addChoices(...MODE_CHOICES),
          )
          .addStringOption((option) => option.setName('tier').setDescription('Тир, например PLATINUM').setRequired(true))
          .addRoleOption((option) => option.setName('role').setDescription('Какую роль выдавать').setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('Показать настроенные соответствия'))
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Убрать соответствие')
          .addStringOption((option) =>
            option.setName('provider').setDescription('Игра').setRequired(true).addChoices(...PROVIDER_CHOICES),
          )
          .addStringOption((option) =>
            option.setName('mode').setDescription('Режим').setRequired(true).addChoices(...MODE_CHOICES),
          )
          .addStringOption((option) => option.setName('tier').setDescription('Тир').setRequired(true)),
      ),

    async execute(interaction) {
      const guildId = interaction.guildId;
      if (!guildId) {
        throw new UserError('Эта команда работает только на сервере.');
      }

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'list') {
        const mappings = await deps.roles.listMappings(guildId);
        if (mappings.length === 0) {
          await interaction.reply({
            content: 'Соответствия ранг → роль пока не настроены. Добавь первое через `/rolemap set`.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const lines = mappings.map((m) => `• ${m.provider} / ${m.mode} / **${m.tier}** → <@&${m.roleId}>`);
        await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
        return;
      }

      const provider = interaction.options.getString('provider', true) as ProviderId;
      const mode = interaction.options.getString('mode', true);
      const tier = interaction.options.getString('tier', true).trim().toUpperCase();

      const allowed = tiersFor(provider);
      if (!allowed.includes(tier)) {
        throw new UserError(`Для «${provider}» тир «${tier}» не подходит. Допустимые: ${allowed.join(', ')}.`);
      }

      if (subcommand === 'remove') {
        const removed = await deps.roles.removeMapping(guildId, provider, mode, tier);
        if (!removed) {
          throw new UserError('Такое соответствие не найдено.');
        }
        await interaction.reply({ content: 'Соответствие убрано.', flags: MessageFlags.Ephemeral });
        return;
      }

      const role = interaction.options.getRole('role');
      if (!role) {
        throw new UserError('Не удалось прочитать роль. Выбери её из списка.');
      }

      await deps.roles.setMapping(guildId, provider, mode, tier, role.id);
      await interaction.reply({
        content: `Готово: ${provider} / ${mode} / **${tier}** → <@&${role.id}>. Применится при следующей синхронизации.`,
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}
