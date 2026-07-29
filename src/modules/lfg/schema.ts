import { bigserial, index, integer, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';

/**
 * Поиск тиммейтов. Ключевое отличие от турниров: здесь не соревнование, а **сведение людей
 * прямо сейчас**, и потому главная величина — время. Объявление, которое висит сутки, хуже
 * отсутствия объявления: человек приходит на зов, а зовущий уже спит.
 *
 * Отсюда два решения модели: у каждого сбора есть срок, и просроченные закрываются джобой,
 * а не остаются висеть до перезапуска.
 */

export type LfgGame = 'dota2' | 'lol' | 'tft' | 'valorant' | 'other';

export type LfgState = 'open' | 'full' | 'closed' | 'expired';

export const lfgPosts = pgTable(
  'lfg_posts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    guildId: text('guild_id').notNull(),
    /** Кто собирает. Он же владелец: только он может закрыть сбор досрочно. */
    hostUserId: text('host_user_id').notNull(),
    game: text('game').$type<LfgGame>().notNull(),
    /** Режим свободным текстом: «рейтинг», «турбо», «архонт+», «чиллово катки». */
    mode: text('mode').notNull(),
    /** Сколько всего нужно людей, включая собирающего. */
    slots: integer('slots').notNull(),
    /** Заметка от собирающего: «нужен саппорт», «без микро не берём». */
    note: text('note'),
    state: text('state').$type<LfgState>().notNull().default('open'),
    /** Сообщение с карточкой сбора: по нему обновляется счётчик и снимаются кнопки. */
    channelId: text('channel_id').notNull(),
    messageId: text('message_id'),
    /** Голосовой канал сбора. Создаётся при заполнении, удаляется при закрытии. */
    voiceChannelId: text('voice_channel_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Джоба закрытия ищет по этой паре: открытые и просроченные.
    index('lfg_posts_due_idx').on(table.state, table.expiresAt),
    index('lfg_posts_guild_state_idx').on(table.guildId, table.state),
  ],
);

/**
 * Кто записался. Уникальность `(postId, userId)` — гарантия «один человек занимает одно
 * место»: без неё двойное нажатие кнопки заполняло бы сбор одним и тем же человеком.
 */
export const lfgMembers = pgTable(
  'lfg_members',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    postId: integer('post_id')
      .notNull()
      .references(() => lfgPosts.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('lfg_members_uq').on(table.postId, table.userId)],
);

/**
 * Подписки на игру: кого пинговать, когда собирают. Роль, а не список идентификаторов —
 * упоминание роли Discord доставляет всем сразу, не превращая объявление в простыню
 * упоминаний, и человек отписывается сам, снимая роль.
 */
export const lfgPings = pgTable(
  'lfg_pings',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    guildId: text('guild_id').notNull(),
    game: text('game').$type<LfgGame>().notNull(),
    roleId: text('role_id').notNull(),
  },
  (table) => [unique('lfg_pings_uq').on(table.guildId, table.game)],
);

/** Куда постить сборы и где создавать голосовые каналы. */
export const lfgSettings = pgTable('lfg_settings', {
  guildId: text('guild_id').primaryKey(),
  channelId: text('channel_id'),
  voiceCategoryId: text('voice_category_id'),
  /** Сколько минут живёт сбор по умолчанию. */
  defaultTtlMinutes: integer('default_ttl_minutes').notNull().default(120),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type LfgPostRow = typeof lfgPosts.$inferSelect;
export type LfgMemberRow = typeof lfgMembers.$inferSelect;
export type LfgSettingsRow = typeof lfgSettings.$inferSelect;
