import { bigserial, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Модерация. Главное решение всей модели: **любое действие модератора — строка в журнале, и
 * только потом действие в Discord.** Discord не хранит историю: снятый мут не отличить от
 * никогда не выданного, а причину знает только тот, кто выдал. Без своего журнала
 * «предупреждали ли его раньше» — вопрос к памяти модератора, а это худший источник правды
 * при разборе спорной блокировки.
 *
 * Отсюда же следует, что журнал пишется, даже если действие в Discord не удалось: расхождение
 * «в журнале есть, в Discord нет» разбирается, а обратное — нет.
 */

export type InfractionKind = 'note' | 'warn' | 'mute' | 'kick' | 'ban' | 'unmute' | 'unban';

/** Кто выдал: человек или сам бот по правилу антиспама. */
export type InfractionSource = 'moderator' | 'automod';

export const infractions = pgTable(
  'moderation_infractions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    /** NULL — выдал бот. */
    moderatorId: text('moderator_id'),
    kind: text('kind').$type<InfractionKind>().notNull(),
    source: text('source').$type<InfractionSource>().notNull().default('moderator'),
    reason: text('reason').notNull(),
    /** Для мутов и банов со сроком: когда истекает. NULL — навсегда. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Снято досрочно: кем и когда. История не удаляется никогда. */
    liftedAt: timestamp('lifted_at', { withTimezone: true }),
    liftedBy: text('lifted_by'),
    /** Что именно сработало: правило антиспама, текст сообщения, канал. */
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('moderation_infractions_user_idx').on(table.guildId, table.userId, table.createdAt),
    // Джоба снятия истёкших наказаний выбирает по этой паре.
    index('moderation_infractions_expiry_idx').on(table.liftedAt, table.expiresAt),
  ],
);

/**
 * Настройки защиты. Пороги в базе, а не в коде: сервер на 200 человек и сервер на 5000
 * живут с разной нормальной скоростью сообщений, и подобрать её можно только на месте.
 */
export const guardSettings = pgTable('moderation_settings', {
  guildId: text('guild_id').primaryKey(),
  /** Канал, куда писать о срабатываниях. Без него модераторы не узнают о работе бота. */
  logChannelId: text('log_channel_id'),
  /** Роль мута. Discord умеет таймауты сам, но роль нужна для серверов со своей настройкой. */
  muteRoleId: text('mute_role_id'),

  antispamEnabled: text('antispam_enabled').$type<'yes' | 'no'>().notNull().default('yes'),
  /** Сколько сообщений за окно считается флудом. */
  spamMessages: integer('spam_messages').notNull().default(6),
  spamWindowSeconds: integer('spam_window_seconds').notNull().default(8),
  /** Сколько одинаковых сообщений подряд считается копипастой. */
  spamDuplicates: integer('spam_duplicates').notNull().default(4),
  /** Сколько упоминаний в одном сообщении считается массовой рассылкой. */
  spamMentions: integer('spam_mentions').notNull().default(6),
  /** На сколько минут мутить за флуд. */
  spamMuteMinutes: integer('spam_mute_minutes').notNull().default(10),

  antiraidEnabled: text('antiraid_enabled').$type<'yes' | 'no'>().notNull().default('yes'),
  /** Сколько заходов за окно считается рейдом. */
  raidJoins: integer('raid_joins').notNull().default(8),
  raidWindowSeconds: integer('raid_window_seconds').notNull().default(30),
  /** Сколько варнов до автоматического мута. */
  warnsToMute: integer('warns_to_mute').notNull().default(3),
  warnMuteMinutes: integer('warn_mute_minutes').notNull().default(60),

  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Тикеты: приватная ветка между человеком и модераторами. Ветка, а не канал — она
 * архивируется и не оставляет после себя мусор в списке каналов.
 */
export const tickets = pgTable(
  'moderation_tickets',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    threadId: text('thread_id').notNull(),
    topic: text('topic').notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: text('closed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('moderation_tickets_user_idx').on(table.guildId, table.userId, table.closedAt)],
);

export type InfractionRow = typeof infractions.$inferSelect;
export type GuardSettingsRow = typeof guardSettings.$inferSelect;
export type TicketRow = typeof tickets.$inferSelect;
