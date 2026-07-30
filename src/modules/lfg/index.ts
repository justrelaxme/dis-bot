import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
  type Guild,
  type Interaction,
  type TextChannel,
} from 'discord.js';
import type { Database } from '../../core/db/client.js';
import { UserError, describeForUser } from '../../core/errors.js';
import type { BotModule, CommandDefinition, EventHandler, ModuleContext } from '../../core/module.js';
import { MAX_SLOTS, MAX_TTL_MINUTES, MIN_SLOTS, createLfgService, type LfgService } from './service.js';
import type { LfgGame, LfgPostRow } from './schema.js';

/** Закрытие просроченных сборов — раз в минуту: срок здесь и есть главная величина. */
const EXPIRY_CRON = '* * * * *';
const EXPIRY_BATCH = 30;
const POSTS_PER_DAY = 5;

const BTN_JOIN = 'lj';
const BTN_LEAVE = 'll';
const BTN_CLOSE = 'lc';

const GAME_LABELS: Record<LfgGame, string> = {
  dota2: 'Dota 2',
  lol: 'League of Legends',
  tft: 'Teamfight Tactics',
  valorant: 'Valorant',
  other: 'Другое',
};

export interface LfgModuleDeps {
  db: Database;
}

/** Карточка сбора: состав, места и кнопки. Обновляется на месте при каждом изменении. */
function postCard(
  post: LfgPostRow,
  members: string[],
): { content: string; components: ActionRowBuilder<ButtonBuilder>[] } {
  const free = post.slots - members.length;
  const closed = post.state === 'closed' || post.state === 'expired';

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BTN_JOIN}:${post.id}`)
      .setLabel(free > 0 ? `Иду (${members.length}/${post.slots})` : 'Мест нет')
      .setStyle(free > 0 ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(closed || free <= 0),
    new ButtonBuilder()
      .setCustomId(`${BTN_LEAVE}:${post.id}`)
      .setLabel('Передумал')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(closed),
    new ButtonBuilder()
      .setCustomId(`${BTN_CLOSE}:${post.id}`)
      .setLabel('Закрыть сбор')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(closed),
  );

  const status = closed
    ? post.state === 'expired'
      ? '_Сбор истёк._'
      : '_Сбор закрыт._'
    : free > 0
      ? `Нужно ещё **${free}**`
      : '**Набрали!**';

  return {
    content: [
      `## ${GAME_LABELS[post.game]} · ${post.mode}`,
      `Собирает <@${post.hostUserId}> · ${status}`,
      post.note ? `_${post.note}_` : '',
      '',
      members.map((id) => `• <@${id}>`).join('\n'),
      '',
      closed ? '' : `Истекает <t:${Math.floor(post.expiresAt.getTime() / 1_000)}:R>.`,
    ]
      .filter((line) => line !== '')
      .join('\n'),
    components: [row],
  };
}

/**
 * Поиск тиммейтов.
 *
 * Отличие от турниров в одном: здесь не соревнование, а сведение людей **прямо сейчас**, и
 * потому главная величина — время. Сбор, висящий сутки, хуже отсутствия сбора: человек
 * приходит на зов, а зовущий уже спит. Поэтому у каждого сбора есть срок, а закрывает его
 * джоба, а не перезапуск бота.
 */
export function createLfgModule(deps: LfgModuleDeps): BotModule {
  const lfg = createLfgService({ db: deps.db });

  /** Перерисовывает карточку в канале. Отказ Discord не отменяет состав в базе. */
  async function refreshCard(ctx: ModuleContext, post: LfgPostRow, members: string[]): Promise<void> {
    if (!post.messageId) return;
    try {
      const channel = await ctx.client.channels.fetch(post.channelId);
      if (!channel || channel.type !== ChannelType.GuildText) return;
      const message = await (channel as TextChannel).messages.fetch(post.messageId);
      const card = postCard(post, members);
      await message.edit({ content: card.content, components: card.components });
    } catch (error) {
      ctx.logger.warn({ err: error, postId: post.id }, 'не удалось обновить карточку сбора');
    }
  }

  /**
   * Голосовой канал под сбор — создаётся, когда состав набран, а не заранее: канал под
   * недособранный сбор либо стоит пустым, либо в него заходят посторонние.
   */
  async function createVoice(ctx: ModuleContext, guild: Guild, post: LfgPostRow, members: string[]): Promise<void> {
    if (post.voiceChannelId) return;
    const settings = await lfg.settings(guild.id);

    try {
      const channel = await guild.channels.create({
        name: `🎮 ${GAME_LABELS[post.game]} · ${post.mode}`.slice(0, 90),
        type: ChannelType.GuildVoice,
        ...(settings.voiceCategoryId ? { parent: settings.voiceCategoryId } : {}),
        userLimit: post.slots,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.Connect] },
          ...members.map((id) => ({
            id,
            allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.ViewChannel],
          })),
        ],
        reason: `Сбор ${post.id}: состав набран`,
      });
      await lfg.attachVoice(post.id, channel.id);

      const text = await ctx.client.channels.fetch(post.channelId);
      if (text && text.type === ChannelType.GuildText) {
        await (text as TextChannel).send(
          `${members.map((id) => `<@${id}>`).join(' ')} — состав набран, заходите: <#${channel.id}>`,
        );
      }
    } catch (error) {
      // Нет прав или исчерпан лимит каналов — состав всё равно набран, договорятся сами.
      ctx.logger.warn({ err: error, postId: post.id }, 'не удалось создать голосовой канал сбора');
    }
  }

  function buttonHandler(): EventHandler<'interactionCreate'> {
    return {
      event: 'interactionCreate',
      async handle(ctx, interaction: Interaction): Promise<void> {
        if (!interaction.isButton()) return;
        const [prefix, rawId] = interaction.customId.split(':');
        if (prefix !== BTN_JOIN && prefix !== BTN_LEAVE && prefix !== BTN_CLOSE) return;
        const postId = Number.parseInt(rawId ?? '', 10);
        if (!Number.isInteger(postId)) return;

        try {
          await handleButton(ctx, interaction, prefix, postId);
        } catch (error) {
          const described = describeForUser(error);
          if (described.incidentId) {
            ctx.logger.error({ err: error, incidentId: described.incidentId }, 'кнопка сбора упала');
          }
          const payload = { content: described.text, flags: MessageFlags.Ephemeral } as const;
          if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
          else await interaction.reply(payload);
        }
      },
    };
  }

  async function handleButton(
    ctx: ModuleContext,
    interaction: ButtonInteraction,
    prefix: string,
    postId: number,
  ): Promise<void> {
    const guild = interaction.guild;
    if (!guild) throw new UserError('Это работает только на сервере.');

    if (prefix === BTN_JOIN) {
      const { post, members } = await lfg.join(postId, interaction.user.id);
      const card = postCard(post, members);
      await interaction.update({ content: card.content, components: card.components });
      if (post.state === 'full') await createVoice(ctx, guild, post, members);
      return;
    }

    if (prefix === BTN_LEAVE) {
      const { post, members } = await lfg.leave(postId, interaction.user.id);
      const card = postCard(post, members);
      await interaction.update({ content: card.content, components: card.components });
      return;
    }

    const member = interaction.member;
    const isAdmin =
      member !== null && 'permissions' in member && typeof member.permissions !== 'string'
        ? member.permissions.has(PermissionFlagsBits.ManageGuild)
        : false;

    const closed = await lfg.close(postId, interaction.user.id, isAdmin);
    const members = await lfg.roster(postId);
    const card = postCard(closed, members);
    await interaction.update({ content: card.content, components: card.components });

    if (closed.voiceChannelId) {
      await guild.channels
        .delete(closed.voiceChannelId, 'Сбор закрыт')
        .catch((error: unknown) => ctx.logger.warn({ err: error }, 'не удалось убрать канал сбора'));
    }
  }

  return {
    name: 'lfg',

    commands: [lfgCommand(lfg, postCard, refreshCard), lfgAdminCommand(lfg)],

    events: [buttonHandler()],

    jobs: [
      {
        name: 'lfg:expire',
        cron: EXPIRY_CRON,
        async run(ctx): Promise<void> {
          for (const post of await lfg.expired(new Date(), EXPIRY_BATCH)) {
            await lfg.markExpired(post.id);
            const members = await lfg.roster(post.id);
            await refreshCard(ctx, { ...post, state: 'expired' }, members);

            if (post.voiceChannelId) {
              const guild = await ctx.client.guilds.fetch(post.guildId).catch(() => null);
              await guild?.channels
                .delete(post.voiceChannelId, 'Сбор истёк')
                .catch((error: unknown) => ctx.logger.warn({ err: error }, 'не удалось убрать канал истёкшего сбора'));
            }
          }
        },
      },
    ],
  };
}

function lfgCommand(
  lfg: LfgService,
  card: typeof postCard,
  refresh: (ctx: ModuleContext, post: LfgPostRow, members: string[]) => Promise<void>,
): CommandDefinition {
  return {
    defer: { ephemeral: false },
    builder: new SlashCommandBuilder()
      .setName('lfg')
      .setDescription('Собрать людей на игру')
      .addSubcommand((sub) =>
        sub
          .setName('post')
          .setDescription('Объявить сбор')
          .addStringOption((option) =>
            option
              .setName('game')
              .setDescription('Игра')
              .setRequired(true)
              .addChoices(
                ...(Object.keys(GAME_LABELS) as LfgGame[]).map((game) => ({
                  name: GAME_LABELS[game],
                  value: game,
                })),
              ),
          )
          .addIntegerOption((option) =>
            option
              .setName('slots')
              .setDescription('Сколько всего нужно людей, включая тебя')
              .setRequired(true)
              .setMinValue(MIN_SLOTS)
              .setMaxValue(MAX_SLOTS),
          )
          .addStringOption((option) =>
            option.setName('mode').setDescription('Режим: рейтинг, турбо, чиллово').setMaxLength(40),
          )
          .addStringOption((option) => option.setName('note').setDescription('Заметка: нужен саппорт, без микро не берём').setMaxLength(120))
          .addIntegerOption((option) =>
            option
              .setName('minutes')
              .setDescription('Сколько минут висит сбор')
              .setMinValue(5)
              .setMaxValue(MAX_TTL_MINUTES),
          ),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('Кто сейчас собирает'))
      .addSubcommand((sub) => sub.setName('close').setDescription('Закрыть свой сбор'))
      .addSubcommand((sub) =>
        sub
          .setName('roles')
          .setDescription('Подписки на игры: о каких сборах тебя упоминать')
          .addStringOption((option) =>
            option
              .setName('game')
              .setDescription('Игра — включает подписку или снимает, если она уже есть')
              .addChoices(
                ...(Object.keys(GAME_LABELS) as LfgGame[]).map((game) => ({
                  name: GAME_LABELS[game],
                  value: game,
                })),
              ),
          ),
      ),

    async execute(interaction, ctx): Promise<void> {
      if (!interaction.inGuild()) throw new UserError('Эта команда работает только на сервере.');
      const guildId = interaction.guildId;
      const userId = interaction.user.id;

      switch (interaction.options.getSubcommand()) {
        case 'post': {
          // Ограничение на сутки: без него канал сборов превращается в поток объявлений от
          // одного человека, и остальные перестают его читать.
          if ((await lfg.postsToday(guildId, userId)) >= POSTS_PER_DAY) {
            throw new UserError(`Не больше ${POSTS_PER_DAY} сборов в сутки — иначе канал читать перестанут.`);
          }

          const settings = await lfg.settings(guildId);
          const game = interaction.options.getString('game', true) as LfgGame;
          const slots = interaction.options.getInteger('slots', true);
          const mode = interaction.options.getString('mode') ?? 'обычные катки';
          const note = interaction.options.getString('note');
          const minutes = interaction.options.getInteger('minutes') ?? settings.defaultTtlMinutes;

          const { post, members } = await lfg.open({
            guildId,
            hostUserId: userId,
            game,
            mode,
            slots,
            channelId: settings.channelId ?? interaction.channelId,
            ttlMinutes: minutes,
            ...(note ? { note } : {}),
          });

          const pingRole = await lfg.pingRole(guildId, game);
          const rendered = card(post, members);
          const message = await interaction.editReply({
            content: pingRole ? `<@&${pingRole}>\n${rendered.content}` : rendered.content,
            components: rendered.components,
            allowedMentions: pingRole ? { roles: [pingRole] } : { parse: [] },
          });
          await lfg.attachMessage(post.id, message.id);
          return;
        }

        /**
         * Самообслуживание подписок. Роль человек снимает и надевает сам — администратор
         * не должен раздавать их вручную, а новичку нужен способ не пропускать сборы по
         * своей игре, не читая канал круглые сутки.
         */
        case 'roles': {
          const configured = await lfg.pingRoles(guildId);
          if (configured.length === 0) {
            throw new UserError(
              'Подписки на этом сервере не настроены. Администратору: `/lfg-setup game`.',
            );
          }

          const member = await interaction.guild?.members.fetch(userId).catch(() => null);
          if (!member) throw new UserError('Не удалось прочитать твои роли на сервере.');

          const chosen = interaction.options.getString('game') as LfgGame | null;
          if (chosen === null) {
            await interaction.editReply({
              content: [
                '## Подписки на сборы',
                ...configured.map(
                  (row) =>
                    `${member.roles.cache.has(row.roleId) ? '✅' : '▫️'} **${GAME_LABELS[row.game]}** — <@&${row.roleId}>`,
                ),
                '',
                'Включить или снять: `/lfg roles game:…`. Подписка — это упоминание, когда кто-то собирает по этой игре.',
              ].join('\n'),
              allowedMentions: { parse: [] },
            });
            return;
          }

          const target = configured.find((row) => row.game === chosen);
          if (!target) {
            throw new UserError(`Для ${GAME_LABELS[chosen]} подписка не настроена.`);
          }

          const had = member.roles.cache.has(target.roleId);
          try {
            if (had) await member.roles.remove(target.roleId);
            else await member.roles.add(target.roleId);
          } catch (error) {
            // Почти всегда это иерархия: роль бота стоит ниже выдаваемой.
            ctx.logger.warn({ err: error, roleId: target.roleId }, 'подписка не переключилась');
            throw new UserError(
              'Не смог изменить роль. Похоже, роль бота стоит ниже этой — администратору нужно поднять её выше в настройках сервера.',
            );
          }

          await interaction.editReply({
            content: had
              ? `Снял подписку на ${GAME_LABELS[chosen]} — упоминать не буду.`
              : `Подписал на ${GAME_LABELS[chosen]}: упомяну, когда кто-то соберёт компанию.`,
          });
          return;
        }

        case 'list': {
          const posts = await lfg.openPosts(guildId, 10);
          if (posts.length === 0) {
            await interaction.editReply({
              content: 'Сейчас никто не собирает. Объяви свой сбор: `/lfg post`.',
            });
            return;
          }
          await interaction.editReply({
            content: [
              '## Сейчас собирают',
              ...posts.map(
                ({ post, members }) =>
                  `• **${GAME_LABELS[post.game]}** · ${post.mode} — ${members.length}/${post.slots}, у <@${post.hostUserId}>, до <t:${Math.floor(post.expiresAt.getTime() / 1_000)}:t>`,
              ),
            ].join('\n'),
            allowedMentions: { parse: [] },
          });
          return;
        }

        case 'close': {
          const own = await lfg.ownPost(guildId, userId);
          if (!own) throw new UserError('У тебя нет открытого сбора.');
          const closed = await lfg.close(own.id, userId, false);
          const members = await lfg.roster(own.id);
          await refresh(ctx, closed, members);

          if (closed.voiceChannelId) {
            await interaction.guild?.channels
              .delete(closed.voiceChannelId, 'Сбор закрыт')
              .catch(() => null);
          }
          await interaction.editReply({ content: 'Сбор закрыт.' });
          return;
        }

        default:
          throw new UserError('Неизвестная подкоманда.');
      }
    },
  };
}

function lfgAdminCommand(lfg: LfgService): CommandDefinition {
  return {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('lfg-setup')
      .setDescription('Настройка поиска тиммейтов')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('here')
          .setDescription('Объявлять сборы в этом канале, а голосовые создавать в этой категории'),
      )
      .addSubcommand((sub) =>
        sub
          .setName('ping')
          .setDescription('Роль для упоминания при сборе по игре')
          .addStringOption((option) =>
            option
              .setName('game')
              .setDescription('Игра')
              .setRequired(true)
              .addChoices(
                ...(Object.keys(GAME_LABELS) as LfgGame[]).map((game) => ({
                  name: GAME_LABELS[game],
                  value: game,
                })),
              ),
          )
          .addRoleOption((option) => option.setName('role').setDescription('Роль').setRequired(true)),
      ),

    async execute(interaction): Promise<void> {
      if (!interaction.inGuild()) throw new UserError('Эта команда работает только на сервере.');
      const guildId = interaction.guildId;

      if (interaction.options.getSubcommand() === 'here') {
        const channel = interaction.channel;
        const parentId = channel && 'parentId' in channel ? channel.parentId : null;
        await lfg.saveSettings(guildId, {
          channelId: interaction.channelId,
          ...(parentId ? { voiceCategoryId: parentId } : {}),
        });
        await interaction.editReply({
          content: `Сборы будут появляться здесь${parentId ? ', голосовые каналы — в этой же категории' : ''}. Игроки объявляют их командой \`/lfg post\`.`,
        });
        return;
      }

      const game = interaction.options.getString('game', true) as LfgGame;
      const role = interaction.options.getRole('role', true);
      await lfg.setPingRole(guildId, game, role.id);
      await interaction.editReply({
        content: `При сборе по ${GAME_LABELS[game]} бот упомянет <@&${role.id}>. Кто не хочет — снимает роль с себя.`,
      });
    },
  };
}
