import { index, jsonb, pgTable, serial, text, timestamp, unique } from 'drizzle-orm/pg-core';

/**
 * Игра турнира — самостоятельный тип модуля, а не ProviderId из identity: турнир
 * проводится по игре, а ProviderId (src/modules/identity/schema.ts) — это источник
 * данных о ранге. Это разные оси: Dota 2 как турнирная дисциплина обслуживается
 * провайдером 'steam', но тащить сюда ProviderId и его остальные значения
 * (riot-lol/riot-tft/riot-valorant вперемешку с future 'other' и т.п.) means
 * привязывать голосование по дисциплине к устройству модуля identity, которое
 * может меняться по совсем другим причинам.
 */
export type TournamentGame = 'dota2' | 'lol' | 'tft' | 'valorant';

export const tournamentPolls = pgTable(
  'tournament_polls',
  {
    id: serial('id').primaryKey(),
    // Снежинки Discord хранятся как text — guildId намеренно без FK на guilds.id:
    // в проекте пока нет ни одного места, которое гарантированно создаёт строку в
    // guilds при появлении бота на сервере (см. отчёт), и голосование не должно
    // зависеть от этого пробела.
    guildId: text('guild_id').notNull(),
    channelId: text('channel_id').notNull(),
    messageId: text('message_id').notNull(),
    /** Дисциплины, предложенные на голосование, в том же порядке, что и ответы опроса Discord. */
    options: jsonb('options').$type<TournamentGame[]>().notNull(),
    closesAt: timestamp('closes_at', { withTimezone: true }).notNull(),
    /**
     * NULL, пока итог не зафиксирован. Остаётся NULL и после фиксации, если исход —
     * ничья между несколькими дисциплинами или ни одного голоса: в обоих случаях
     * нет одной выигравшей дисциплины, но голосование всё равно обработано
     * (см. finalizedAt).
     */
    winnerGame: text('winner_game').$type<TournamentGame>(),
    /**
     * Признак того, что итог уже объявлен в Discord — единственный источник истины
     * для джобы о том, нужно ли ещё что-то делать с этим голосованием. Именно эта
     * колонка, а не наличие winnerGame: у ничьей и нулевых голосов winnerGame тоже
     * NULL, но обрабатывать их повторно не нужно.
     */
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Джоба каждые несколько минут ищет именно эту пару условий — без индекса это
    // полное сканирование таблицы на каждый тик планировщика.
    index('tournament_polls_due_idx').on(table.finalizedAt, table.closesAt),
    // Один Discord-message — одно голосование.
    unique('tournament_polls_message_uq').on(table.messageId),
  ],
);
