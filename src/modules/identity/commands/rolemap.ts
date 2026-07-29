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
  { name: 'TFT: двойной подъём', value: 'tft-double-up' },
  { name: 'Dota 2: медаль', value: 'dota-mmr' },
  { name: 'Valorant: соревновательный', value: 'val-competitive' },
];

function tiersFor(provider: ProviderId): readonly string[] {
  if (provider === 'steam') return DOTA_MEDALS;
  if (provider === 'riot-valorant') return VALORANT_TIERS;
  return RIOT_TIERS;
}

/**
 * Режимы, реально существующие у провайдера (см. ranks/riot.ts QUEUE_TO_MODE,
 * ranks/dota.ts normalizeDotaRank и providers/valorant.ts VALORANT_MODE). Раньше
 * режим не сверялся с провайдером вообще: `provider=steam, mode=solo-duo, tier=LEGEND`
 * принимался целиком (тир LEGEND валиден для Dota, а mode='solo-duo' — это режим
 * LoL) и создавал маппинг, который не совпадёт никогда — applyRoles ищет роль по
 * паре (mode, tier) из рангов, которые провайдер реально возвращает, а такой пары
 * для Dota не бывает.
 */
const MODES_BY_PROVIDER: Record<ProviderId, readonly string[]> = {
  steam: ['dota-mmr'],
  'riot-lol': ['solo-duo', 'flex'],
  'riot-tft': ['tft-ranked', 'tft-double-up'],
  'riot-valorant': ['val-competitive'],
};

function modesFor(provider: ProviderId): readonly string[] {
  return MODES_BY_PROVIDER[provider];
}

export function createRoleMapCommand(deps: { roles: RoleMappingService }): CommandDefinition {
  return {
    // list/set/remove — это round-trip в Postgres ДО первого ответа Discord (см.
    // profile.ts с тем же обоснованием). План исключал /rolemap из defer как
    // «не делает сетевых вызовов» — посылка неверна, поэтому defer добавлен.
    // Окно ответа Discord 3 секунды, и при медленной БД оно закроется без defer.
    defer: { ephemeral: true },
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
      const guild = interaction.guild;
      if (!guild) {
        throw new UserError('Эта команда работает только на сервере.');
      }
      const guildId = guild.id;

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'list') {
        const mappings = await deps.roles.listMappings(guildId);
        if (mappings.length === 0) {
          await interaction.followUp({
            content: 'Соответствия ранг → роль пока не настроены. Добавь первое через `/rolemap set`.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const lines = mappings.map((m) => `• ${m.provider} / ${m.mode} / **${m.tier}** → <@&${m.roleId}>`);
        await interaction.followUp({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
        return;
      }

      const provider = interaction.options.getString('provider', true) as ProviderId;
      const mode = interaction.options.getString('mode', true);
      const tier = interaction.options.getString('tier', true).trim().toUpperCase();

      const allowedTiers = tiersFor(provider);
      if (!allowedTiers.includes(tier)) {
        throw new UserError(`Для «${provider}» тир «${tier}» не подходит. Допустимые: ${allowedTiers.join(', ')}.`);
      }

      // Тир и режим проверяются раздельно, но оба обязаны соответствовать одному и
      // тому же provider: «provider=steam, mode=solo-duo, tier=LEGEND» — тир LEGEND
      // пройдёт проверку выше (это медаль Dota), а mode=solo-duo — режим LoL, для
      // Steam такого не существует. Без этой проверки такой маппинг создавался бы и
      // никогда бы не сработал: applyRoles ищет роль по паре (mode, tier) из рангов,
      // которые реально возвращает normalizeDotaRank, а mode='solo-duo' там взяться
      // не может.
      const allowedModes = modesFor(provider);
      if (!allowedModes.includes(mode)) {
        throw new UserError(`Для «${provider}» режим «${mode}» не подходит. Допустимые: ${allowedModes.join(', ')}.`);
      }

      if (subcommand === 'remove') {
        const removed = await deps.roles.removeMapping(guildId, provider, mode, tier);
        if (!removed) {
          throw new UserError('Такое соответствие не найдено.');
        }
        await interaction.followUp({ content: 'Соответствие убрано.', flags: MessageFlags.Ephemeral });
        return;
      }

      const role = interaction.options.getRole('role');
      if (!role) {
        throw new UserError('Не удалось прочитать роль. Выбери её из списка.');
      }

      // Управляемость роли проверяется ДО записи маппинга, а не после: раньше
      // единственной проверкой был тир, и `/rolemap set` рапортовал «Готово», даже
      // если бот физически не мог назначить указанную роль. Настройка молча не
      // работала: applyRoles падал бы 50013 внутри обработчика rank.changed, EventBus
      // гасит это через Promise.allSettled и просто пишет в лог — администратор эту
      // строку никогда не увидит, только то, что роли не выдаются.
      const botMember = guild.members.me;
      if (!botMember) {
        throw new UserError('Не удалось проверить права бота на этом сервере — попробуй ещё раз через пару секунд.');
      }

      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        throw new UserError(
          'У бота нет права «Управление ролями» на этом сервере — без него он не сможет выдавать роли ни по одному ' +
            'маппингу. Выдай это право роли бота в настройках сервера и повтори команду.',
        );
      }

      if (role.managed) {
        throw new UserError(
          `Ролью «${role.name}» управляет интеграция (бот, буст-роль, роль подписки Twitch и т.п.) — Discord не ` +
            'позволяет назначать такие роли вручную. Выбери обычную роль сервера.',
        );
      }

      if (role.position >= botMember.roles.highest.position) {
        throw new UserError(
          `Роль «${role.name}» стоит не ниже роли бота в списке ролей сервера, поэтому бот физически не сможет ` +
            'её выдавать. Поднимите роль бота выше нужной в Настройках сервера → Роли и повторите команду.',
        );
      }

      await deps.roles.setMapping(guildId, provider, mode, tier, role.id);
      await interaction.followUp({
        content: `Готово: ${provider} / ${mode} / **${tier}** → <@&${role.id}>. Применится при следующей синхронизации.`,
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}
