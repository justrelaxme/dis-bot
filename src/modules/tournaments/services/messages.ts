import { and, eq } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import { tournamentMessages } from '../schema.js';

/**
 * Учёт сообщений, которые бот отправил по поводу турнира, — чтобы за собой убрать.
 *
 * Пометка «сор или запись» ставится на отправке, а не при уборке: тот, кто отправляет,
 * знает, что именно он отправил, а уборщик про это только догадывался бы. Сор — панель
 * регистрации с живыми кнопками, напоминание неотметившимся, голосование по дисциплине.
 * Запись — пары первого круга и итог турнира: это летопись, и стирать её значило бы стирать
 * то, ради чего турнир проводили.
 *
 * Запись сообщения никогда не должна ронять отправку. Сообщение уже ушло к людям, и падать
 * из-за того, что мы не смогли о нём запомнить, было бы обменом полезного на аккуратное.
 */

export interface RememberedMessage {
  channelId: string;
  messageId: string;
}

export function createMessagesService(deps: { db: Database }) {
  const { db } = deps;

  return {
    /** Запоминает отправленное. Повторный вызов с тем же сообщением ничего не меняет. */
    async remember(
      tournamentId: number,
      message: RememberedMessage,
      options: { transient: boolean },
    ): Promise<void> {
      await db
        .insert(tournamentMessages)
        .values({
          tournamentId,
          channelId: message.channelId,
          messageId: message.messageId,
          transient: options.transient,
        })
        .onConflictDoNothing();
    },

    /** Что подлежит уборке у этого турнира. */
    async sweepable(tournamentId: number): Promise<RememberedMessage[]> {
      const rows = await db
        .select({ channelId: tournamentMessages.channelId, messageId: tournamentMessages.messageId })
        .from(tournamentMessages)
        .where(
          and(eq(tournamentMessages.tournamentId, tournamentId), eq(tournamentMessages.transient, true)),
        );
      return rows;
    },

    /**
     * Забывает сообщение после уборки. Вызывается и когда удаление не удалось: сообщение,
     * которое не получилось удалить дважды, не получится и в третий раз, а строка о нём
     * осталась бы в базе навсегда.
     */
    async forget(message: RememberedMessage): Promise<void> {
      await db
        .delete(tournamentMessages)
        .where(
          and(
            eq(tournamentMessages.channelId, message.channelId),
            eq(tournamentMessages.messageId, message.messageId),
          ),
        );
    },
  };
}

export type MessagesService = ReturnType<typeof createMessagesService>;
