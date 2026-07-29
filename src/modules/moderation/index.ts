import { createHash } from 'node:crypto';
import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type GuildMember,
  type Message,
  type TextChannel,
} from 'discord.js';
import type { Cache } from '../../core/cache.js';
import type { Database } from '../../core/db/client.js';
import { UserError } from '../../core/errors.js';
import type { BotModule, CommandDefinition, EventHandler, ModuleContext } from '../../core/module.js';
import { createModerationService, type ModerationService } from './service.js';
import type { GuardSettingsRow, InfractionKind, InfractionRow } from './schema.js';

/** Снятие истёкших наказаний — раз в минуту: мут на 10 минут должен сниматься вовремя. */
const EXPIRY_CRON = '* * * * *';
const EXPIRY_BATCH = 50;

const KIND_LABELS: Record<InfractionKind, string> = {
  note: 'заметка',
  warn: 'предупреждение',
  mute: 'мут',
  kick: 'кик',
  ban: 'бан',
  unmute: 'снятие мута',
  unban: 'разбан',
};

export interface ModerationModuleDeps {
  db: Database;
  cache: Cache;
}

/**
 * Модерация: антиспам, антирейд, предупреждения с историей, муты со сроком, тикеты, журнал.
 *
 * Главное решение: **любое действие сначала попадает в журнал, потом в Discord.** Discord
 * историю не хранит — снятый мут не отличить от никогда не выданного, а причину знает только
 * тот, кто выдал. Без своего журнала «предупреждали ли его раньше» становится вопросом к
 * памяти модератора, а это худший источник правды при разборе спорной блокировки.
 *
 * Из того же следует порядок: журнал пишется даже если действие в Discord не удалось.
 * Расхождение «в журнале есть, в Discord нет» разбирается по логам, обратное — нет.
 */
export function createModerationModule(deps: ModerationModuleDeps): BotModule {
  const moderation = createModerationService({ db: deps.db, cache: deps.cache });

  async function log(ctx: ModuleContext, settings: GuardSettingsRow, text: string): Promise<void> {
    if (!settings.logChannelId) return;
    try {
      const channel = await ctx.client.channels.fetch(settings.logChannelId);
      if (channel && channel.type === ChannelType.GuildText) {
        await (channel as TextChannel).send({ content: text, allowedMentions: { parse: [] } });
      }
    } catch (error) {
      ctx.logger.warn({ err: error }, 'не удалось написать в канал журнала модерации');
    }
  }

  /**
   * Выдаёт мут. Таймаут Discord, а не роль: он снимается сам по сроку даже если бот лежит, а
   * роль без работающего бота осталась бы на человеке навсегда.
   */
  async function applyMute(
    ctx: ModuleContext,
    member: GuildMember,
    minutes: number,
    reason: string,
  ): Promise<boolean> {
    try {
      await member.timeout(minutes * 60_000, reason);
      return true;
    } catch (error) {
      ctx.logger.warn({ err: error, userId: member.id }, 'не удалось выдать мут');
      return false;
    }
  }

  /** Антиспам: скорость, копипаста, массовые упоминания. */
  function spamGuard(): EventHandler<'messageCreate'> {
    return {
      event: 'messageCreate',
      async handle(ctx, message: Message): Promise<void> {
        if (message.author.bot || !message.inGuild() || !message.member) return;

        // Модератора не глушим: иначе бот однажды заглушит того, кто пришёл его останавливать.
        if (message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;

        const settings = await moderation.settings(message.guildId);
        if (settings.antispamEnabled !== 'yes') return;

        const reasons: string[] = [];

        const rate = await moderation.bumpMessageRate(
          message.guildId,
          message.author.id,
          settings.spamWindowSeconds,
        );
        if (rate > settings.spamMessages) {
          reasons.push(`${rate} сообщений за ${settings.spamWindowSeconds} с`);
        }

        const body = message.content.trim().toLowerCase();
        if (body.length > 0) {
          const hash = createHash('sha1').update(body).digest('hex').slice(0, 16);
          const dup = await moderation.bumpDuplicate(
            message.guildId,
            message.author.id,
            hash,
            settings.spamWindowSeconds * 4,
          );
          if (dup >= settings.spamDuplicates) reasons.push(`одно и то же сообщение ${dup} раз`);
        }

        const mentions = message.mentions.users.size + message.mentions.roles.size;
        if (mentions >= settings.spamMentions) reasons.push(`${mentions} упоминаний в одном сообщении`);

        if (reasons.length === 0) return;

        const reason = `Антиспам: ${reasons.join(', ')}`;
        // Журнал первым: если Discord откажет, у модератора всё равно останется след.
        const record = await moderation.record({
          guildId: message.guildId,
          userId: message.author.id,
          moderatorId: null,
          kind: 'mute',
          source: 'automod',
          reason,
          expiresAt: new Date(Date.now() + settings.spamMuteMinutes * 60_000),
          details: { channelId: message.channelId, sample: message.content.slice(0, 200) },
        });

        const muted = await applyMute(ctx, message.member, settings.spamMuteMinutes, reason);
        await message.delete().catch(() => null);

        await log(
          ctx,
          settings,
          [
            `🔇 **Мут ${settings.spamMuteMinutes} мин** — <@${message.author.id}> (\`${message.author.id}\`)`,
            `Причина: ${reason}`,
            `Запись №${record.id}${muted ? '' : ' · **выдать мут не удалось**, проверьте права бота'}`,
          ].join('\n'),
        );
      },
    };
  }

  /**
   * Антирейд: много заходов за короткое окно. Бот не банит и не кикает сам — он поднимает
   * тревогу и включает проверку. Автоматический бан на волне заходов однажды выкосит наплыв
   * настоящих людей после упоминания сервера где-нибудь, и отменить это будет нечем.
   */
  function raidGuard(): EventHandler<'guildMemberAdd'> {
    return {
      event: 'guildMemberAdd',
      async handle(ctx, member: GuildMember): Promise<void> {
        const settings = await moderation.settings(member.guild.id);
        if (settings.antiraidEnabled !== 'yes') return;

        const joins = await moderation.bumpJoinRate(member.guild.id, settings.raidWindowSeconds);
        if (joins !== settings.raidJoins) return; // ровно на пороге — чтобы не спамить тревогой

        await log(
          ctx,
          settings,
          [
            `🚨 **Возможен рейд:** ${joins} заходов за ${settings.raidWindowSeconds} с.`,
            'Бот никого не тронул — решение за вами. Если это рейд, поднимите уровень проверки в настройках сервера.',
          ].join('\n'),
        );
      },
    };
  }

  return {
    name: 'moderation',

    commands: [modCommand(moderation, log, applyMute), ticketCommand(moderation), guardCommand(moderation)],

    events: [spamGuard(), raidGuard()],

    jobs: [
      {
        name: 'moderation:expire',
        cron: EXPIRY_CRON,
        async run(ctx): Promise<void> {
          for (const row of await moderation.expiredPunishments(new Date(), EXPIRY_BATCH)) {
            // Таймауты Discord снимает сам; мы закрываем запись, чтобы история была честной.
            await moderation.lift(row.id, 'system');
            const settings = await moderation.settings(row.guildId);
            await log(
              ctx,
              settings,
              `⏱️ Срок истёк: ${KIND_LABELS[row.kind]} для <@${row.userId}> (запись №${row.id}).`,
            );
          }
        },
      },
    ],
  };
}

function historyLine(row: InfractionRow): string {
  const when = `<t:${Math.floor(row.createdAt.getTime() / 1_000)}:d>`;
  const by = row.moderatorId ? `<@${row.moderatorId}>` : 'бот';
  const lifted = row.liftedAt ? ' · _снято_' : '';
  return `\`№${row.id}\` ${when} — **${KIND_LABELS[row.kind]}** от ${by}: ${row.reason}${lifted}`;
}

function modCommand(
  moderation: ModerationService,
  log: (ctx: ModuleContext, settings: GuardSettingsRow, text: string) => Promise<void>,
  applyMute: (ctx: ModuleContext, member: GuildMember, minutes: number, reason: string) => Promise<boolean>,
): CommandDefinition {
  return {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('mod')
      .setDescription('Модерация')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addSubcommand((sub) =>
        sub
          .setName('warn')
          .setDescription('Предупредить')
          .addUserOption((option) => option.setName('user').setDescription('Кого').setRequired(true))
          .addStringOption((option) => option.setName('reason').setDescription('За что').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('mute')
          .setDescription('Заглушить на время')
          .addUserOption((option) => option.setName('user').setDescription('Кого').setRequired(true))
          .addIntegerOption((option) =>
            option.setName('minutes').setDescription('На сколько минут').setRequired(true).setMinValue(1).setMaxValue(40320),
          )
          .addStringOption((option) => option.setName('reason').setDescription('За что').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('unmute')
          .setDescription('Снять мут досрочно')
          .addUserOption((option) => option.setName('user').setDescription('Кого').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('history')
          .setDescription('История нарушений')
          .addUserOption((option) => option.setName('user').setDescription('Чья').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('lift')
          .setDescription('Снять запись из истории (запись остаётся, но помечается снятой)')
          .addIntegerOption((option) => option.setName('id').setDescription('Номер записи').setRequired(true)),
      ),

    async execute(interaction, ctx): Promise<void> {
      if (!interaction.inGuild()) throw new UserError('Эта команда работает только на сервере.');
      const guildId = interaction.guildId;
      const settings = await moderation.settings(guildId);
      const actorId = interaction.user.id;

      switch (interaction.options.getSubcommand()) {
        case 'warn': {
          const user = interaction.options.getUser('user', true);
          const reason = interaction.options.getString('reason', true);
          const record = await moderation.record({
            guildId,
            userId: user.id,
            moderatorId: actorId,
            kind: 'warn',
            reason,
          });

          const warns = await moderation.activeWarns(guildId, user.id);
          let extra = '';

          // Автоматический мут по числу предупреждений: иначе третий варн ничем не отличается
          // от первого, и предупреждения перестают что-либо значить.
          if (warns >= settings.warnsToMute) {
            const member = await interaction.guild?.members.fetch(user.id).catch(() => null);
            await moderation.record({
              guildId,
              userId: user.id,
              moderatorId: null,
              kind: 'mute',
              source: 'automod',
              reason: `Накопилось предупреждений: ${warns}`,
              expiresAt: new Date(Date.now() + settings.warnMuteMinutes * 60_000),
            });
            if (member) await applyMute(ctx, member, settings.warnMuteMinutes, `Предупреждений: ${warns}`);
            extra = `\nЭто ${warns}-е предупреждение — выдан мут на ${settings.warnMuteMinutes} мин.`;
          }

          await log(
            ctx,
            settings,
            `⚠️ **Предупреждение** — <@${user.id}> от <@${actorId}>: ${reason} (запись №${record.id})${extra}`,
          );
          await interaction.editReply({ content: `Предупреждение выдано. Активных: ${warns}.${extra}` });
          return;
        }

        case 'mute': {
          const user = interaction.options.getUser('user', true);
          const minutes = interaction.options.getInteger('minutes', true);
          const reason = interaction.options.getString('reason', true);

          const record = await moderation.record({
            guildId,
            userId: user.id,
            moderatorId: actorId,
            kind: 'mute',
            reason,
            expiresAt: new Date(Date.now() + minutes * 60_000),
          });

          const member = await interaction.guild?.members.fetch(user.id).catch(() => null);
          const ok = member ? await applyMute(ctx, member, minutes, reason) : false;

          await log(
            ctx,
            settings,
            `🔇 **Мут ${minutes} мин** — <@${user.id}> от <@${actorId}>: ${reason} (запись №${record.id})${ok ? '' : ' · **не применилось**, проверьте права'}`,
          );
          await interaction.editReply({
            content: ok
              ? `Мут на ${minutes} мин выдан.`
              : `Запись создана (№${record.id}), но Discord мут не принял — проверьте, что у бота есть право «Тайм-аут участников» и его роль выше.`,
          });
          return;
        }

        case 'unmute': {
          const user = interaction.options.getUser('user', true);
          const active = await moderation.activeOfKind(guildId, user.id, 'mute');
          if (active) await moderation.lift(active.id, actorId);

          const member = await interaction.guild?.members.fetch(user.id).catch(() => null);
          await member?.timeout(null, `Снял <@${actorId}>`).catch(() => null);
          await moderation.record({
            guildId,
            userId: user.id,
            moderatorId: actorId,
            kind: 'unmute',
            reason: 'снято досрочно',
          });

          await log(ctx, settings, `🔊 **Мут снят** — <@${user.id}> снял <@${actorId}>`);
          await interaction.editReply({ content: 'Мут снят.' });
          return;
        }

        case 'history': {
          const user = interaction.options.getUser('user', true);
          const rows = await moderation.history(guildId, user.id);
          const warns = await moderation.activeWarns(guildId, user.id);

          await interaction.editReply({
            content:
              rows.length === 0
                ? `У <@${user.id}> история чистая.`
                : [
                    `## История <@${user.id}>`,
                    `Активных предупреждений: **${warns}**`,
                    '',
                    ...rows.map(historyLine),
                  ].join('\n'),
            allowedMentions: { parse: [] },
          });
          return;
        }

        case 'lift': {
          const id = interaction.options.getInteger('id', true);
          const lifted = await moderation.lift(id, actorId);
          if (!lifted) throw new UserError(`Записи №${id} нет, или она уже снята.`);
          await log(ctx, settings, `↩️ Запись №${id} снята <@${actorId}> (была: ${KIND_LABELS[lifted.kind]}).`);
          await interaction.editReply({ content: `Запись №${id} снята. Сама запись осталась в истории.` });
          return;
        }

        default:
          throw new UserError('Неизвестная подкоманда.');
      }
    },
  };
}

/**
 * Тикеты: приватная ветка между человеком и модераторами. Ветка, а не канал — она
 * архивируется и не оставляет мусор в списке каналов.
 */
function ticketCommand(moderation: ModerationService): CommandDefinition {
  return {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('ticket')
      .setDescription('Написать модераторам приватно')
      .addStringOption((option) =>
        option.setName('topic').setDescription('С чем нужна помощь').setRequired(true).setMaxLength(100),
      ),

    async execute(interaction, ctx): Promise<void> {
      if (!interaction.inGuild()) throw new UserError('Эта команда работает только на сервере.');
      const guildId = interaction.guildId;

      const existing = await moderation.openTicketOf(guildId, interaction.user.id);
      if (existing) {
        throw new UserError(`У тебя уже открыт тикет: <#${existing.threadId}>. Напиши в него.`);
      }

      const settings = await moderation.settings(guildId);
      const parentId = settings.logChannelId ?? interaction.channelId;
      const channel = await ctx.client.channels.fetch(parentId).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildText) {
        throw new UserError('Модераторы ещё не настроили канал для тикетов. Скажи им про `/guard here`.');
      }

      const topic = interaction.options.getString('topic', true);
      const thread = await (channel as TextChannel).threads.create({
        name: `Тикет: ${topic}`.slice(0, 100),
        type: ChannelType.PrivateThread,
        invitable: false,
        reason: `Тикет от ${interaction.user.tag}`,
      });
      await thread.members.add(interaction.user.id).catch(() => null);
      await thread.send(
        [
          `<@${interaction.user.id}> открыл тикет.`,
          `**Тема:** ${topic}`,
          '',
          'Опиши подробнее, что случилось. Модераторы видят эту ветку, остальные — нет.',
        ].join('\n'),
      );

      await moderation.openTicket({ guildId, userId: interaction.user.id, threadId: thread.id, topic });
      await interaction.editReply({ content: `Тикет открыт: <#${thread.id}>` });
    },
  };
}

function guardCommand(moderation: ModerationService): CommandDefinition {
  return {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('guard')
      .setDescription('Настройка защиты сервера')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub.setName('here').setDescription('Писать о срабатываниях и открывать тикеты в этом канале'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('antispam')
          .setDescription('Пороги антиспама')
          .addBooleanOption((option) => option.setName('enabled').setDescription('Включить'))
          .addIntegerOption((option) =>
            option.setName('messages').setDescription('Сообщений за окно').setMinValue(3).setMaxValue(30),
          )
          .addIntegerOption((option) =>
            option.setName('seconds').setDescription('Длина окна в секундах').setMinValue(3).setMaxValue(60),
          )
          .addIntegerOption((option) =>
            option.setName('mute_minutes').setDescription('На сколько мутить').setMinValue(1).setMaxValue(1440),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('antiraid')
          .setDescription('Порог антирейда')
          .addBooleanOption((option) => option.setName('enabled').setDescription('Включить'))
          .addIntegerOption((option) =>
            option.setName('joins').setDescription('Заходов за окно').setMinValue(3).setMaxValue(50),
          )
          .addIntegerOption((option) =>
            option.setName('seconds').setDescription('Длина окна в секундах').setMinValue(10).setMaxValue(300),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('warns')
          .setDescription('Сколько предупреждений до автоматического мута')
          .addIntegerOption((option) =>
            option.setName('count').setDescription('Сколько').setRequired(true).setMinValue(2).setMaxValue(10),
          )
          .addIntegerOption((option) =>
            option.setName('minutes').setDescription('На сколько мутить').setMinValue(5).setMaxValue(10080),
          ),
      )
      .addSubcommand((sub) => sub.setName('show').setDescription('Показать текущие настройки')),

    async execute(interaction): Promise<void> {
      if (!interaction.inGuild()) throw new UserError('Эта команда работает только на сервере.');
      const guildId = interaction.guildId;

      switch (interaction.options.getSubcommand()) {
        case 'here': {
          await moderation.saveSettings(guildId, { logChannelId: interaction.channelId });
          await interaction.editReply({
            content: 'Сюда буду писать о срабатываниях защиты, и здесь же будут открываться тикеты.',
          });
          return;
        }
        case 'antispam': {
          const patch: Partial<GuardSettingsRow> = {};
          const enabled = interaction.options.getBoolean('enabled');
          if (enabled !== null) patch.antispamEnabled = enabled ? 'yes' : 'no';
          const messages = interaction.options.getInteger('messages');
          if (messages !== null) patch.spamMessages = messages;
          const seconds = interaction.options.getInteger('seconds');
          if (seconds !== null) patch.spamWindowSeconds = seconds;
          const muteMinutes = interaction.options.getInteger('mute_minutes');
          if (muteMinutes !== null) patch.spamMuteMinutes = muteMinutes;

          const saved = await moderation.saveSettings(guildId, patch);
          await interaction.editReply({
            content: `Антиспам ${saved.antispamEnabled === 'yes' ? 'включён' : 'выключен'}: больше ${saved.spamMessages} сообщений за ${saved.spamWindowSeconds} с → мут ${saved.spamMuteMinutes} мин. Модераторов не трогает.`,
          });
          return;
        }
        case 'antiraid': {
          const patch: Partial<GuardSettingsRow> = {};
          const enabled = interaction.options.getBoolean('enabled');
          if (enabled !== null) patch.antiraidEnabled = enabled ? 'yes' : 'no';
          const joins = interaction.options.getInteger('joins');
          if (joins !== null) patch.raidJoins = joins;
          const seconds = interaction.options.getInteger('seconds');
          if (seconds !== null) patch.raidWindowSeconds = seconds;

          const saved = await moderation.saveSettings(guildId, patch);
          await interaction.editReply({
            content: `Антирейд ${saved.antiraidEnabled === 'yes' ? 'включён' : 'выключен'}: ${saved.raidJoins} заходов за ${saved.raidWindowSeconds} с → тревога в канал. Бот сам никого не банит — решение за вами.`,
          });
          return;
        }
        case 'warns': {
          const count = interaction.options.getInteger('count', true);
          const minutes = interaction.options.getInteger('minutes');
          const saved = await moderation.saveSettings(guildId, {
            warnsToMute: count,
            ...(minutes !== null ? { warnMuteMinutes: minutes } : {}),
          });
          await interaction.editReply({
            content: `${saved.warnsToMute} предупреждения → мут на ${saved.warnMuteMinutes} мин.`,
          });
          return;
        }
        case 'show': {
          const s = await moderation.settings(guildId);
          await interaction.editReply({
            content: [
              '## Защита сервера',
              `Журнал: ${s.logChannelId ? `<#${s.logChannelId}>` : '**не задан** — модераторы не увидят срабатываний, поправьте `/guard here`'}`,
              `Антиспам: ${s.antispamEnabled === 'yes' ? 'вкл' : 'выкл'} — >${s.spamMessages} за ${s.spamWindowSeconds} с, ${s.spamDuplicates} повторов, ${s.spamMentions} упоминаний → мут ${s.spamMuteMinutes} мин`,
              `Антирейд: ${s.antiraidEnabled === 'yes' ? 'вкл' : 'выкл'} — ${s.raidJoins} заходов за ${s.raidWindowSeconds} с → тревога`,
              `Предупреждения: ${s.warnsToMute} → мут ${s.warnMuteMinutes} мин`,
            ].join('\n'),
          });
          return;
        }
        default:
          throw new UserError('Неизвестная подкоманда.');
      }
    },
  };
}
