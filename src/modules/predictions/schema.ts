import { index, integer, pgTable, serial, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { tournamentMatches, tournaments } from '../tournaments/schema.js';

/**
 * Прогнозы на матчи: участник сервера называет победителя и получает монеты, если угадал.
 *
 * Один человек — один прогноз на матч, и это стоит на уникальности в базе, а не на проверке
 * перед записью: между проверкой и вставкой всегда может встать второй вызов, а два прогноза
 * одного человека на один матч означали бы, что он угадал наверняка.
 *
 * Прогноз не меняется после записи. Возможность передумать выглядит безобидной, но она же
 * означает возможность передумать, увидев заявленный результат, — то есть угадывать задним
 * числом. Поэтому запись одна и окончательная.
 */
export const matchPredictions = pgTable(
  'match_predictions',
  {
    id: serial('id').primaryKey(),
    matchId: integer('match_id')
      .notNull()
      .references(() => tournamentMatches.id, { onDelete: 'cascade' }),
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    /** На кого поставлен прогноз. Один из двух соперников матча. */
    entrantId: integer('entrant_id').notNull(),
    /**
     * Когда начислено. `null` — матч ещё не закрыт или награда ещё не выдана. Это же поле и
     * защищает от двойного начисления: джоба берёт только ненаграждённые и ставит отметку тем
     * же обновлением, в котором проверяет её отсутствие.
     */
    settledAt: timestamp('settled_at', { withTimezone: true }),
    /** Сколько монет получено. 0 — прогноз не угадал, и это законный итог. */
    coinsAwarded: integer('coins_awarded').notNull().default(0),
    /**
     * Турнир отменён — прогноз аннулирован. Раньше такие прогнозы висели нерасчитанными
     * навсегда: матч без победителя джоба не трогала, а в таблице прогнозистов они не
     * считались ни угаданными, ни нет.
     */
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('match_predictions_user_uq').on(table.matchId, table.userId),
    // Джоба выдачи ищет именно эту пару: ненаграждённые по матчу.
    index('match_predictions_settle_idx').on(table.settledAt, table.matchId),
    index('match_predictions_board_idx').on(table.guildId, table.userId),
  ],
);

export type PredictionRow = typeof matchPredictions.$inferSelect;

/**
 * Публичная ветка «Прогнозы» турнира. Ветки матчей закрытые — зрители их не видят, — поэтому у
 * прогнозов своё место под каналом объявлений, одно на турнир.
 */
export const predictionBoards = pgTable('prediction_boards', {
  tournamentId: integer('tournament_id')
    .primaryKey()
    .references(() => tournaments.id, { onDelete: 'cascade' }),
  threadId: text('thread_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Карточка матча в ветке прогнозов: кнопки «За A» / «За B» и живой расклад голосов. Строка
 * одна на матч — карточку перерисовывают на месте, а не шлют новую на каждый голос.
 */
export const predictionCards = pgTable('prediction_cards', {
  matchId: integer('match_id')
    .primaryKey()
    .references(() => tournamentMatches.id, { onDelete: 'cascade' }),
  channelId: text('channel_id').notNull(),
  messageId: text('message_id').notNull(),
  /** Когда закрыт приём: матч начался. */
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PredictionBoardRow = typeof predictionBoards.$inferSelect;
export type PredictionCardRow = typeof predictionCards.$inferSelect;
