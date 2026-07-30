import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type GuildMember,
} from 'discord.js';
import { eq } from 'drizzle-orm';
import type { Cache } from '../../core/cache.js';
import type { Database } from '../../core/db/client.js';
import { UserError } from '../../core/errors.js';
import type { BotModule, CommandDefinition, EventHandler, ModuleContext } from '../../core/module.js';
import { serverStatus } from './bridge.js';
import { welcomeSettings, type WelcomeSettingsRow } from './schema.js';
import { BTN_FIRST_STEP, firstStep, welcomeMessage } from './texts.js';

/**
 * Окно, в котором повторный заход того же человека считается тем же событием. Discord
 * обычно не досылает `guildMemberAdd`, но переподключение шлюза случается, и двойное
 * приветствие в канале выглядит поломкой. Настоящий повторный вход через десять минут
 * поздороваться, наоборот, должен.
 */
const GREETED_WINDOW_MS = 10 * 60 * 1_000;

export interface WelcomeModuleDeps {
  db: Database;
  cache: Cache;
}

async function settingsOf(db: Database, guildId: string): Promise<WelcomeSettingsRow> {
  const [row] = await db.select().from(welcomeSettings).where(eq(welcomeSettings.guildId, guildId));
  if (row) return row;

  const [created] = await db
    .insert(welcomeSettings)
    .values({ guildId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const [again] = await db.select().from(welcomeSettings).where(eq(welcomeSettings.guildId, guildId));
  if (!again) throw new Error('настройки приветствия не создались');
  return again;
}

/**
 * Модуль встречи. Держится на одном принципе: новичку называется **один** следующий шаг,
 * а не список возможностей. Список читают ровно до третьего пункта.
 *
 * Роли по играм модуль не настраивает и не выдаёт: ими уже владеет модуль поиска
 * тиммейтов (`/lfg-setup` задаёт роль для упоминаний по каждой игре). Вторая настройка
 * тех же ролей означала бы, что администратор задаёт их дважды и однажды разойдётся.
 */
export function createWelcomeModule(deps: WelcomeModuleDeps): BotModule {
  const { db, cache } = deps;

  async function save(
    guildId: string,
    patch: Partial<Omit<WelcomeSettingsRow, 'guildId'>>,
  ): Promise<WelcomeSettingsRow> {
    const [row] = await db
      .insert(welcomeSettings)
      .values({ guildId, ...patch })
      .onConflictDoUpdate({
        target: welcomeSettings.guildId,
        set: { ...patch, updatedAt: new Date() },
      })
      .returning();
    if (!row) throw new Error('настройки приветствия не сохранились');
    return row;
  }

  /** Выдаёт роль зашедшему. Отказ Discord не должен отменять приветствие. */
  async function grantAutoRole(
    ctx: ModuleContext,
    member: GuildMember,
    settings: WelcomeSettingsRow,
  ): Promise<void> {
    if (!settings.autoRoleId) return;
    try {
      await member.roles.add(settings.autoRoleId);
    } catch (error) {
      // Чаще всего это иерархия ролей: роль бота стоит ниже выдаваемой.
      ctx.logger.warn(
        { err: error, guildId: member.guild.id, roleId: settings.autoRoleId },
        'роль новичку не выдалась',
      );
    }
  }

  function greeter(): EventHandler<'guildMemberAdd'> {
    return {
      event: 'guildMemberAdd',
      async handle(ctx, member: GuildMember): Promise<void> {
        const settings = await settingsOf(db, member.guild.id);
        if (!settings.enabled) return;

        // Счётчик в окне: второй заход того же человека внутри окна — это переподключение
        // шлюза, а не новый человек.
        const seen = await cache.incrementInWindow(
          `welcome:${member.guild.id}:${member.id}`,
          GREETED_WINDOW_MS,
        );
        if (seen > 1) return;

        await grantAutoRole(ctx, member, settings);

        if (settings.channelId) {
          const channel = await ctx.client.channels.fetch(settings.channelId).catch(() => null);
          if (channel?.type === ChannelType.GuildText) {
            const payload = welcomeMessage(settings, member.id);
            await channel.send(payload).catch((error: unknown) => {
              ctx.logger.warn(
                { err: error, channelId: settings.channelId },
                'приветствие в канал не отправилось',
              );
            });
          }
        }

        if (!settings.dmEnabled) return;

        // Личка может быть закрыта — это нормальная настройка приватности, а не сбой.
        const status = await serverStatus(db, member.guild.id, member.id);
        await member
          .send([`Привет! Ты на сервере **${member.guild.name}**.`, '', firstStep(status, settings)].join('\n'))
          .catch(() => undefined);
      },
    };
  }

  function stepButton(): EventHandler<'interactionCreate'> {
    return {
      event: 'interactionCreate',
      async handle(_ctx, interaction): Promise<void> {
        if (!interaction.isButton() || interaction.customId !== BTN_FIRST_STEP) return;
        if (!interaction.guildId) return;

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const settings = await settingsOf(db, interaction.guildId);
        const status = await serverStatus(db, interaction.guildId, interaction.user.id);
        await interaction.editReply({ content: firstStep(status, settings) });
      },
    };
  }

  /** Личный разбор доступен и командой: кнопка живёт под приветствием, а оно уезжает вверх. */
  function startCommand(): CommandDefinition {
    return {
      defer: { ephemeral: true },
      builder: new SlashCommandBuilder()
        .setName('start')
        .setDescription('С чего начать на этом сервере — один следующий шаг для тебя'),

      async execute(interaction): Promise<void> {
        if (!interaction.guildId) throw new UserError('Эта команда работает только на сервере.');
        const settings = await settingsOf(db, interaction.guildId);
        const status = await serverStatus(db, interaction.guildId, interaction.user.id);
        await interaction.editReply({ content: firstStep(status, settings) });
      },
    };
  }

  function welcomeCommand(): CommandDefinition {
    return {
      defer: { ephemeral: true },
      builder: new SlashCommandBuilder()
        .setName('welcome')
        .setDescription('Встреча новичков')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((sub) =>
          sub.setName('here').setDescription('Встречать новичков в этом канале'),
        )
        .addSubcommand((sub) => sub.setName('off').setDescription('Перестать встречать'))
        .addSubcommand((sub) =>
          sub.setName('test').setDescription('Показать приветствие и разбор так, как их увидит новичок'),
        )
        .addSubcommand((sub) =>
          sub
            .setName('config')
            .setDescription('Роль новичку, каналы правил и турниров, своя первая строка')
            .addRoleOption((option) =>
              option.setName('role').setDescription('Роль, выдаваемая каждому зашедшему'),
            )
            .addChannelOption((option) =>
              option.setName('rules').setDescription('Канал с правилами').addChannelTypes(ChannelType.GuildText),
            )
            .addChannelOption((option) =>
              option
                .setName('tournaments')
                .setDescription('Канал, где происходят турниры')
                .addChannelTypes(ChannelType.GuildText),
            )
            .addStringOption((option) =>
              option.setName('greeting').setDescription('Своя первая строка приветствия').setMaxLength(300),
            )
            .addBooleanOption((option) =>
              option.setName('dm').setDescription('Писать ли новичку в личные сообщения'),
            ),
        ),

      async execute(interaction): Promise<void> {
        if (!interaction.guildId) throw new UserError('Эта команда работает только на сервере.');
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'here') {
          if (!interaction.channelId) throw new UserError('Не понял, в каком канале мы находимся.');
          const saved = await save(interaction.guildId, {
            enabled: true,
            channelId: interaction.channelId,
          });
          await interaction.editReply({
            content: [
              `Встречаю новичков в <#${saved.channelId}>.`,
              saved.autoRoleId ? `Роль при входе: <@&${saved.autoRoleId}>.` : 'Роль при входе не задана — `/welcome config role:…`.',
              saved.tournamentChannelId
                ? `Показываю на турниры: <#${saved.tournamentChannelId}>.`
                : 'Канал турниров не задан — новичку не на что указать: `/welcome config tournaments:…`.',
              '',
              'Посмотреть, что увидит новичок: `/welcome test`.',
            ].join('\n'),
          });
          return;
        }

        if (subcommand === 'off') {
          await save(interaction.guildId, { enabled: false });
          await interaction.editReply({
            content: 'Больше не встречаю. Настройки сохранены — `/welcome here` включит обратно.',
          });
          return;
        }

        if (subcommand === 'test') {
          const settings = await settingsOf(db, interaction.guildId);
          const status = await serverStatus(db, interaction.guildId, interaction.user.id);
          const preview = welcomeMessage(settings, interaction.user.id);
          await interaction.editReply({
            content: [
              '**Так выглядит приветствие в канале:**',
              preview.content,
              '',
              '**А так — разбор по кнопке, для тебя прямо сейчас:**',
              firstStep(status, settings),
            ].join('\n'),
          });
          return;
        }

        if (subcommand === 'config') {
          const role = interaction.options.getRole('role');
          const rules = interaction.options.getChannel('rules');
          const tournamentsChannel = interaction.options.getChannel('tournaments');
          const greeting = interaction.options.getString('greeting');
          const dm = interaction.options.getBoolean('dm');

          const patch: Partial<Omit<WelcomeSettingsRow, 'guildId'>> = {};
          if (role) patch.autoRoleId = role.id;
          if (rules) patch.rulesChannelId = rules.id;
          if (tournamentsChannel) patch.tournamentChannelId = tournamentsChannel.id;
          if (greeting !== null) patch.greeting = greeting;
          if (dm !== null) patch.dmEnabled = dm;

          if (Object.keys(patch).length === 0) {
            throw new UserError('Нечего менять: укажи хотя бы один параметр.');
          }

          const saved = await save(interaction.guildId, patch);
          await interaction.editReply({
            content: [
              'Сохранено.',
              `Встреча: ${saved.enabled ? `включена в <#${saved.channelId ?? '?'}>` : 'выключена'}`,
              `Роль при входе: ${saved.autoRoleId ? `<@&${saved.autoRoleId}>` : 'нет'}`,
              `Правила: ${saved.rulesChannelId ? `<#${saved.rulesChannelId}>` : 'нет'}`,
              `Турниры: ${saved.tournamentChannelId ? `<#${saved.tournamentChannelId}>` : 'нет'}`,
              `В личку: ${saved.dmEnabled ? 'пишу' : 'не пишу'}`,
            ].join('\n'),
          });
          return;
        }

        throw new UserError('Неизвестная подкоманда.');
      },
    };
  }

  return {
    name: 'welcome',
    commands: [welcomeCommand(), startCommand()],
    events: [greeter(), stepButton()],
  };
}
