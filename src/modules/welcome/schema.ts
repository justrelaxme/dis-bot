import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Встреча новичка. До этого модуля человек заходил на сервер, и не происходило ничего:
 * `guildMemberAdd` слушал только антирейд, чтобы считать заходы. Между «зашёл» и
 * «участвует» стоял барьер из вещей, о которых он не знает — что аккаунт надо привязать,
 * что турнир бывает каждый день, что команда собирается кнопкой.
 *
 * `enabled` по умолчанию false — по той же причине, что и у ежедневного автомата: бот,
 * начинающий писать в канал сразу после миграции, поздоровался бы в первом попавшемся
 * канале на сервере, который его об этом не просил.
 */
export const welcomeSettings = pgTable('welcome_settings', {
  guildId: text('guild_id').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  /** Канал приветствия. Без него встречать негде, поэтому включение всегда задаёт и его. */
  channelId: text('channel_id'),
  /**
   * Писать ли в личные сообщения. Публичное приветствие видят все и оно создаёт
   * ощущение живого сервера, а разбор «что делать именно тебе» уместнее в личке: он
   * длинный и нужен одному человеку.
   */
  dmEnabled: boolean('dm_enabled').notNull().default(true),
  /** Роль, которая выдаётся каждому зашедшему. Обычно это «Участник». */
  autoRoleId: text('auto_role_id'),
  /** Куда показать: правила и канал турниров. Оба необязательны. */
  rulesChannelId: text('rules_channel_id'),
  tournamentChannelId: text('tournament_channel_id'),
  /** Своя первая строка вместо стандартной. */
  greeting: text('greeting'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type WelcomeSettingsRow = typeof welcomeSettings.$inferSelect;
