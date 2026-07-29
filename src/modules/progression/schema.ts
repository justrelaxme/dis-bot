import { bigserial, index, integer, jsonb, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';

/**
 * Прогрессия: опыт за активность, уровни, валюта, достижения, сезоны.
 *
 * Ключевое решение модели — **опыт хранится событиями, а не одним счётчиком**. Счётчик
 * дешевле читать, но с ним невозможно ответить на вопросы, которые возникают в первый же
 * месяц: за что человеку начислили, почему у него столько, не накрутил ли он, и что делать
 * при откате сезона. По журналу это всё видно, а текущая сумма кэшируется отдельно.
 */

export type XpReason =
  | 'message'
  | 'voice'
  | 'tournament-win'
  | 'tournament-play'
  | 'rank-up'
  | 'achievement'
  | 'admin';

export const xpEvents = pgTable(
  'xp_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    /** Может быть отрицательным: снятие начисленного за нарушение — тоже событие. */
    amount: integer('amount').notNull(),
    reason: text('reason').$type<XpReason>().notNull(),
    /** Сезон, к которому относится начисление: смена сезона обнуляет зачёт, но не историю. */
    seasonId: integer('season_id').notNull(),
    /** Подробности для разбора: id сообщения, канала, турнира. */
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('xp_events_user_season_idx').on(table.guildId, table.userId, table.seasonId),
    index('xp_events_created_idx').on(table.createdAt),
  ],
);

/**
 * Текущее состояние игрока: сумма опыта, уровень, валюта. Это кэш поверх `xp_events`,
 * который можно пересобрать заново — и именно поэтому начисление пишет и туда, и сюда в
 * одной транзакции.
 */
export const profiles = pgTable(
  'progression_profiles',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    seasonId: integer('season_id').notNull(),
    xp: integer('xp').notNull().default(0),
    level: integer('level').notNull().default(0),
    /** Валюта сервера: тратится на роли, цвета, ставки в турнирах. */
    coins: integer('coins').notNull().default(0),
    messages: integer('messages').notNull().default(0),
    voiceMinutes: integer('voice_minutes').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('progression_profiles_uq').on(table.guildId, table.userId, table.seasonId),
    // Лидерборд читает по этому индексу: сезон плюс сортировка по опыту.
    index('progression_profiles_board_idx').on(table.guildId, table.seasonId, table.xp),
  ],
);

/**
 * Сезоны. Обнуление раз в N месяцев — единственный способ дать новичкам шанс попасть в
 * таблицу: без сезонов лидерборд навсегда занимают те, кто пришёл первым.
 */
export const seasons = pgTable(
  'progression_seasons',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    guildId: text('guild_id').notNull(),
    name: text('name').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [index('progression_seasons_guild_idx').on(table.guildId, table.endedAt)],
);

/** Достижения объявляются кодом, а выданные — хранятся здесь. */
export const achievements = pgTable(
  'progression_achievements',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    /** Код из каталога в коде: `first-blood`, `night-owl`, `champion`. */
    code: text('code').notNull(),
    /** Сезон выдачи. Достижения не сгорают со сменой сезона — они про человека, не про зачёт. */
    seasonId: integer('season_id').notNull(),
    earnedAt: timestamp('earned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('progression_achievements_uq').on(table.guildId, table.userId, table.code)],
);

/**
 * Награды за уровень: какой уровень даёт какую роль. Настраивается администратором, как и
 * роли за ранг в модуле identity, — и по той же причине хранится в базе, а не в коде.
 */
export const levelRewards = pgTable(
  'progression_level_rewards',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    guildId: text('guild_id').notNull(),
    level: integer('level').notNull(),
    roleId: text('role_id').notNull(),
  },
  (table) => [unique('progression_level_rewards_uq').on(table.guildId, table.level)],
);

/**
 * Магазин: за что можно отдать валюту. Без него монеты — просто число, которое некуда
 * потратить, и вся экономика сводится к ещё одному счётчику рядом с опытом.
 *
 * Пока один вид товара — роль. Расходник (цвет на неделю, право на кастомный ник) добавится
 * значением в `kind`, без миграции типа.
 */
export const shopItems = pgTable(
  'progression_shop_items',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    guildId: text('guild_id').notNull(),
    kind: text('kind').$type<'role'>().notNull().default('role'),
    /** Что выдаём: id роли. */
    payload: text('payload').notNull(),
    title: text('title').notNull(),
    price: integer('price').notNull(),
    /** NULL — товар бессрочный; иначе снимается через столько часов. */
    durationHours: integer('duration_hours'),
    enabled: text('enabled').$type<'yes' | 'no'>().notNull().default('yes'),
  },
  (table) => [unique('progression_shop_items_uq').on(table.guildId, table.payload)],
);

/** Покупки — чтобы знать, что и когда выдали, и уметь снять по сроку. */
export const purchases = pgTable(
  'progression_purchases',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    itemId: integer('item_id').notNull(),
    paid: integer('paid').notNull(),
    /** NULL — бессрочно; иначе джоба снимает роль по истечении. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('progression_purchases_expiry_idx').on(table.revokedAt, table.expiresAt)],
);

/**
 * Голосовые сессии: кто когда зашёл. Опыт за голос начисляется по выходу, потому что
 * начислять по входу значит платить за то, что человек молча висит в канале сутки.
 */
export const voiceSessions = pgTable(
  'progression_voice_sessions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    channelId: text('channel_id').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('progression_voice_sessions_uq').on(table.guildId, table.userId)],
);

export type XpEventRow = typeof xpEvents.$inferSelect;
export type ProfileRow = typeof profiles.$inferSelect;
export type SeasonRow = typeof seasons.$inferSelect;
export type AchievementRow = typeof achievements.$inferSelect;
export type LevelRewardRow = typeof levelRewards.$inferSelect;
