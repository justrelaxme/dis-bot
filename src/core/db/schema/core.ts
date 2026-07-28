import { bigserial, index, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/** Настройки сервера. Схема внутри jsonb принадлежит модулям, не ядру. */
export type GuildSettings = Record<string, unknown>;

export const guilds = pgTable('guilds', {
  id: text('id').primaryKey(),
  settings: jsonb('settings').$type<GuildSettings>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const members = pgTable(
  'members',
  {
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    guildId: text('guild_id').notNull(),
    /** NULL означает действие самого бота, а не человека. */
    actorId: text('actor_id'),
    action: text('action').notNull(),
    targetId: text('target_id'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('audit_log_guild_created_idx').on(table.guildId, table.createdAt.desc())],
);
