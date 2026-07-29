import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  type GuildMember,
  type Message,
  type VoiceState,
} from 'discord.js';
import type { Cache } from '../../core/cache.js';
import type { Database } from '../../core/db/client.js';
import { UserError } from '../../core/errors.js';
import type { BotModule, CommandDefinition, EventHandler, ModuleContext } from '../../core/module.js';
import {
  ACHIEVEMENTS,
  MESSAGE_COOLDOWN_MS,
  MIN_MESSAGE_LENGTH,
  VOICE_MIN_PARTNERS,
  XP_PER_MESSAGE,
  XP_TOURNAMENT_WIN,
  isNightOwlHour,
  progressToNext,
} from './rules.js';
import { createProgressionService, type ProgressionService } from './service.js';

/** Снятие просроченных покупок — раз в 10 минут: точность до минуты здесь не нужна. */
const EXPIRY_CRON = '*/10 * * * *';
const EXPIRY_BATCH = 50;
const LEADERBOARD_SIZE = 15;

export interface ProgressionModuleDeps {
  db: Database;
  cache: Cache;
}

/**
 * Прогрессия: опыт за активность, уровни, роли за уровень, валюта, магазин, достижения,
 * сезоны и лидерборд.
 *
 * Опыт хранится журналом событий, а текущая сумма — кэшем поверх него: счётчик дешевле
 * читать, но по нему нельзя ответить «за что мне столько» и «не накрутил ли он», а эти
 * вопросы возникают в первый же месяц.
 */
export function createProgressionModule(deps: ProgressionModuleDeps): BotModule {
  const progression = createProgressionService({ db: deps.db });

  /**
   * Пауза между начислениями за сообщения живёт в Redis, а не в памяти: процесс
   * перезапускается, и с памятью пауза обнулялась бы вместе с ним — то есть флуд можно было
   * бы продолжать после каждого рестарта.
   */
  async function messageCooldownPassed(guildId: string, userId: string): Promise<boolean> {
    const stamped = await deps.cache.swr(`xp:cooldown:${guildId}:${userId}`, {
      ttlMs: MESSAGE_COOLDOWN_MS,
      staleMs: MESSAGE_COOLDOWN_MS,
      load: async () => Date.now(),
    });
    // Значение только что записали — значит паузы не было. Если оно уже лежало, пауза идёт.
    return Date.now() - stamped.value < 1_000;
  }

  /** Выдаёт роли за перешагнутые уровни. Отказ Discord не отменяет начисленный уровень. */
  async function applyLevelUp(ctx: ModuleContext, member: GuildMember, top: number): Promise<void> {
    const rewards = await progression.levelRewardsUpTo(member.guild.id, top);
    for (const reward of rewards) {
      if (member.roles.cache.has(reward.roleId)) continue;
      try {
        await member.roles.add(reward.roleId, `Прогрессия: уровень ${reward.level}`);
      } catch (error) {
        ctx.logger.warn({ err: error, roleId: reward.roleId }, 'не удалось выдать роль за уровень');
      }
    }
  }

  function messageXpHandler(): EventHandler<'messageCreate'> {
    return {
      event: 'messageCreate',
      async handle(ctx, message: Message): Promise<void> {
        if (message.author.bot || !message.inGuild()) return;
        if (message.content.trim().length < MIN_MESSAGE_LENGTH) return;

        const guildId = message.guildId;
        const userId = message.author.id;

        await progression.countMessage(guildId, userId);

        // Ночная смена — по времени сообщения, а не начисления: они расходятся, если бот
        // был занят.
        if (isNightOwlHour(message.createdAt.getHours())) {
          await progression.grantAchievement(guildId, userId, 'night-owl').catch(() => null);
        }

        if (!(await messageCooldownPassed(guildId, userId))) return;

        const result = await progression.award(guildId, userId, XP_PER_MESSAGE, 'message', {
          channelId: message.channelId,
        });
        if (result.levelsGained.length === 0) return;

        const level = result.profile.level;
        if (message.member) await applyLevelUp(ctx, message.member, level);
        if (level >= 10) await progression.grantAchievement(guildId, userId, 'level-10').catch(() => null);

        await message.reply({
          content: `<@${userId}> — уровень **${level}**. Монет: ${result.profile.coins}. Потратить: \`/shop\`.`,
          allowedMentions: { users: [userId] },
        });
      },
    };
  }

  function voiceXpHandler(): EventHandler<'voiceStateUpdate'> {
    return {
      event: 'voiceStateUpdate',
      async handle(ctx, before: VoiceState, after: VoiceState): Promise<void> {
        if (after.member?.user.bot) return;
        const guildId = after.guild.id;
        const userId = after.id;

        // Зашёл или переключил канал — сессия открывается заново.
        if (after.channelId && after.channelId !== before.channelId) {
          await progression.openVoiceSession(guildId, userId, after.channelId);
        }

        if (!before.channelId || before.channelId === after.channelId) return;

        const minutes = await progression.closeVoiceSession(guildId, userId, new Date());
        if (minutes <= 0) return;

        // Платим за общение, а не за подключённый микрофон: если в канале никого больше не
        // было, опыт не начисляем. Считаем по каналу, из которого вышли.
        const others = before.channel?.members.filter((m) => !m.user.bot && m.id !== userId).size ?? 0;
        if (others < VOICE_MIN_PARTNERS) return;

        const result = await progression.awardVoice(guildId, userId, minutes);
        if (result && result.levelsGained.length > 0 && after.member) {
          await applyLevelUp(ctx, after.member, result.profile.level);
        }
      },
    };
  }

  return {
    name: 'progression',

    commands: [
      rankCommand(progression),
      topCommand(progression),
      shopCommand(progression),
      adminCommand(progression),
    ],

    events: [messageXpHandler(), voiceXpHandler()],

    jobs: [
      {
        name: 'progression:expire-purchases',
        cron: EXPIRY_CRON,
        async run(ctx): Promise<void> {
          for (const { purchase, item } of await progression.expiredPurchases(new Date(), EXPIRY_BATCH)) {
            const guild = await ctx.client.guilds.fetch(purchase.guildId).catch(() => null);
            const member = await guild?.members.fetch(purchase.userId).catch(() => null);
            if (member) {
              await member.roles
                .remove(item.payload, 'Прогрессия: срок покупки истёк')
                .catch((error: unknown) =>
                  ctx.logger.warn({ err: error, roleId: item.payload }, 'не удалось снять роль по истечении'),
                );
            }
            // Помечаем снятым в любом случае: иначе джоба вечно натыкается на покупку,
            // роль которой уже удалили руками.
            await progression.markRevoked(purchase.id);
          }
        },
      },
    ],

    async setup(ctx): Promise<void> {
      // Прогрессия подписывается на чужие события сама: турниры и привязки о ней не знают,
      // иначе они зависели бы от её наличия.
      ctx.bus.on('account.linked', async (payload) => {
        await progression.grantAchievement(payload.guildId, payload.userId, 'linked').catch(() => null);
      });

      ctx.bus.on('tournament.finished', async (payload) => {
        for (const userId of payload.winnerUserIds) {
          await progression.award(payload.guildId, userId, XP_TOURNAMENT_WIN, 'tournament-win', {
            tournamentId: payload.tournamentId,
          });
          await progression.grantAchievement(payload.guildId, userId, 'champion').catch(() => null);
        }
      });

      ctx.logger.info('прогрессия подписалась на привязки и турниры');
    },
  };
}

function achievementTitle(code: string): string {
  return ACHIEVEMENTS.find((achievement) => achievement.code === code)?.title ?? code;
}

function rankCommand(progression: ProgressionService): CommandDefinition {
  return {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('rank')
      .setDescription('Твой уровень, опыт, монеты и достижения')
      .addUserOption((option) => option.setName('user').setDescription('Чей профиль посмотреть')),

    async execute(interaction): Promise<void> {
      if (!interaction.inGuild()) throw new UserError('Эта команда работает только на сервере.');
      const target = interaction.options.getUser('user') ?? interaction.user;

      const profile = await progression.profile(interaction.guildId, target.id);
      const place = await progression.rankOf(interaction.guildId, target.id);
      const earned = await progression.listAchievements(interaction.guildId, target.id);
      const { level, have, need } = progressToNext(profile.xp);

      const filled = need === 0 ? 10 : Math.min(Math.round((have / need) * 10), 10);
      const bar = '▰'.repeat(filled) + '▱'.repeat(10 - filled);

      await interaction.editReply({
        content: [
          `## ${target.displayName}`,
          `Уровень **${level}** · место **${place}** · монет **${profile.coins}**`,
          `${bar}  ${have} / ${need} до следующего`,
          '',
          `Сообщений: ${profile.messages} · в голосовых: ${Math.round(profile.voiceMinutes / 60)} ч`,
          '',
          earned.length > 0
            ? `**Достижения (${earned.length} из ${ACHIEVEMENTS.length}):** ${earned.map((row) => achievementTitle(row.code)).join(', ')}`
            : `Достижений пока нет — их ${ACHIEVEMENTS.length}. Первое даётся за привязку игрового аккаунта: \`/link\`.`,
        ].join('\n'),
      });
    },
  };
}

function topCommand(progression: ProgressionService): CommandDefinition {
  return {
    defer: { ephemeral: false },
    builder: new SlashCommandBuilder().setName('top').setDescription('Лидерборд сезона по опыту'),

    async execute(interaction): Promise<void> {
      if (!interaction.inGuild()) throw new UserError('Эта команда работает только на сервере.');
      const season = await progression.currentSeason(interaction.guildId);
      const rows = await progression.leaderboard(interaction.guildId, LEADERBOARD_SIZE);

      if (rows.length === 0) {
        await interaction.editReply({
          content: 'Пока никто не набрал опыта. Он идёт за сообщения и за время в голосовых каналах.',
        });
        return;
      }

      const medals = ['🥇', '🥈', '🥉'];
      await interaction.editReply({
        content: [
          `## ${season.name}`,
          ...rows.map(
            (row, index) =>
              `${medals[index] ?? `\`${String(index + 1).padStart(2)}\``} <@${row.userId}> — уровень ${row.level}, ${row.xp} опыта`,
          ),
        ].join('\n'),
        allowedMentions: { parse: [] },
      });
    },
  };
}

function shopCommand(progression: ProgressionService): CommandDefinition {
  return {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('shop')
      .setDescription('Магазин: на что потратить монеты')
      .addIntegerOption((option) => option.setName('buy').setDescription('Номер товара для покупки').setMinValue(1)),

    async execute(interaction): Promise<void> {
      if (!interaction.inGuild()) throw new UserError('Эта команда работает только на сервере.');
      const items = await progression.listShop(interaction.guildId);
      const buy = interaction.options.getInteger('buy');

      if (items.length === 0) {
        await interaction.editReply({
          content: 'Магазин пуст. Администратор наполняет его командой `/progression shop-add`.',
        });
        return;
      }

      if (buy === null) {
        const profile = await progression.profile(interaction.guildId, interaction.user.id);
        await interaction.editReply({
          content: [
            `**Монет у тебя: ${profile.coins}**`,
            '',
            ...items.map(
              (item, index) =>
                `\`${index + 1}\` **${item.title}** — ${item.price}${item.durationHours ? ` (на ${item.durationHours} ч)` : ''}`,
            ),
            '',
            'Купить: `/shop buy:<номер>`',
          ].join('\n'),
        });
        return;
      }

      const item = items[buy - 1];
      if (!item) throw new UserError(`Нет товара с номером ${buy}.`);

      const result = await progression.buy(interaction.guildId, interaction.user.id, item.id);

      const member = interaction.member;
      if (member !== null && 'roles' in member && typeof member.roles !== 'string') {
        await (member as GuildMember).roles.add(item.payload, 'Покупка в магазине').catch(() => null);
      }

      await interaction.editReply({
        content: `Куплено: **${result.item.title}**. Осталось монет: ${result.profile.coins}.${
          result.expiresAt ? ` Снимется <t:${Math.floor(result.expiresAt.getTime() / 1_000)}:R>.` : ''
        }`,
      });
    },
  };
}

function adminCommand(progression: ProgressionService): CommandDefinition {
  return {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('progression')
      .setDescription('Настройка прогрессии')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('level-role')
          .setDescription('Выдавать роль за уровень')
          .addIntegerOption((option) =>
            option.setName('level').setDescription('Уровень').setRequired(true).setMinValue(1).setMaxValue(100),
          )
          .addRoleOption((option) => option.setName('role').setDescription('Роль').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('shop-add')
          .setDescription('Добавить роль в магазин')
          .addRoleOption((option) => option.setName('role').setDescription('Роль').setRequired(true))
          .addIntegerOption((option) =>
            option.setName('price').setDescription('Цена в монетах').setRequired(true).setMinValue(1),
          )
          .addStringOption((option) => option.setName('title').setDescription('Как назвать в магазине'))
          .addIntegerOption((option) =>
            option.setName('hours').setDescription('На сколько часов, если товар временный').setMinValue(1),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('season')
          .setDescription('Начать новый сезон: зачёт с нуля, история и достижения остаются')
          .addStringOption((option) => option.setName('name').setDescription('Название сезона').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('give')
          .setDescription('Начислить или снять опыт вручную')
          .addUserOption((option) => option.setName('user').setDescription('Кому').setRequired(true))
          .addIntegerOption((option) =>
            option.setName('xp').setDescription('Сколько (можно отрицательное)').setRequired(true),
          ),
      ),

    async execute(interaction): Promise<void> {
      if (!interaction.inGuild()) throw new UserError('Эта команда работает только на сервере.');
      const guildId = interaction.guildId;

      switch (interaction.options.getSubcommand()) {
        case 'level-role': {
          const level = interaction.options.getInteger('level', true);
          const role = interaction.options.getRole('role', true);
          await progression.setLevelReward(guildId, level, role.id);
          await interaction.editReply({
            content: `За уровень ${level} теперь выдаётся <@&${role.id}>. Роль бота должна стоять выше неё, иначе Discord не даст её выдать.`,
          });
          return;
        }
        case 'shop-add': {
          const role = interaction.options.getRole('role', true);
          const price = interaction.options.getInteger('price', true);
          const hours = interaction.options.getInteger('hours');
          const title = interaction.options.getString('title') ?? role.name;
          await progression.addShopItem({
            guildId,
            payload: role.id,
            title,
            price,
            ...(hours ? { durationHours: hours } : {}),
          });
          await interaction.editReply({
            content: `В магазин добавлено: **${title}** за ${price} монет${hours ? ` на ${hours} ч` : ''}.`,
          });
          return;
        }
        case 'season': {
          const name = interaction.options.getString('name', true);
          const season = await progression.startSeason(guildId, name);
          await interaction.editReply({
            content: `Начался сезон «${season.name}». Зачёт с нуля, достижения и история остались.`,
          });
          return;
        }
        case 'give': {
          const user = interaction.options.getUser('user', true);
          const xp = interaction.options.getInteger('xp', true);
          const result = await progression.award(guildId, user.id, xp, 'admin', { by: interaction.user.id });
          await interaction.editReply({
            content: `<@${user.id}>: ${xp > 0 ? '+' : ''}${xp} опыта. Теперь ${result.profile.xp}, уровень ${result.profile.level}.`,
          });
          return;
        }
        default:
          throw new UserError('Неизвестная подкоманда.');
      }
    },
  };
}
