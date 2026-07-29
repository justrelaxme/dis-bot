import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import { tournamentPolls, type TournamentGame } from '../schema.js';

export type TournamentPollRow = typeof tournamentPolls.$inferSelect;

export interface CreatePollInput {
  guildId: string;
  channelId: string;
  messageId: string;
  options: readonly TournamentGame[];
  closesAt: Date;
  createdBy: string;
}

export interface PollsService {
  createPoll(input: CreatePollInput): Promise<TournamentPollRow>;
  /** Голосования с истёкшим сроком, итог которых ещё не зафиксирован. */
  findDue(now: Date, limit: number): Promise<TournamentPollRow[]>;
  /**
   * Единственное место, которое пишет итог. Это CAS (compare-and-set): строка
   * обновляется, только если finalizedAt ещё NULL — условие идёт в WHERE того же
   * UPDATE, а не в отдельном select до него, иначе между чтением и записью встал
   * бы конкурентный вызов (вторая реплика, перезапуск, наложение прогонов джобы).
   * Пустой .returning() — это и есть «итог уже застолблён кем-то другим», не ошибка.
   */
  claimOutcome(pollId: number, winnerGame: TournamentGame | null): Promise<TournamentPollRow | null>;
  /**
   * Откатывает claimOutcome обратно к NULL. Нужен ровно для одного случая: итог
   * застолблён, но объявить его в Discord не удалось — тогда финализация должна
   * вернуться назад, чтобы следующий прогон джобы подобрал это голосование снова
   * (findDue ищет finalizedAt IS NULL), а не потерял его навсегда.
   */
  revertClaim(pollId: number): Promise<void>;
}

function required<T>(row: T | undefined): T {
  if (row === undefined) throw new Error('вставка/обновление tournament_polls не вернула строку');
  return row;
}

export function createPollsService(deps: { db: Database }): PollsService {
  const { db } = deps;

  return {
    async createPoll(input): Promise<TournamentPollRow> {
      const [row] = await db
        .insert(tournamentPolls)
        .values({
          guildId: input.guildId,
          channelId: input.channelId,
          messageId: input.messageId,
          options: [...input.options],
          closesAt: input.closesAt,
          createdBy: input.createdBy,
        })
        .returning();
      return required(row);
    },

    async findDue(now, limit): Promise<TournamentPollRow[]> {
      return db
        .select()
        .from(tournamentPolls)
        .where(and(isNull(tournamentPolls.finalizedAt), lte(tournamentPolls.closesAt, now)))
        .orderBy(asc(tournamentPolls.closesAt))
        .limit(limit);
    },

    async claimOutcome(pollId, winnerGame): Promise<TournamentPollRow | null> {
      const now = new Date();
      const [row] = await db
        .update(tournamentPolls)
        .set({ winnerGame, finalizedAt: now, updatedAt: now })
        .where(and(eq(tournamentPolls.id, pollId), isNull(tournamentPolls.finalizedAt)))
        .returning();
      return row ?? null;
    },

    async revertClaim(pollId): Promise<void> {
      await db
        .update(tournamentPolls)
        .set({ winnerGame: null, finalizedAt: null, updatedAt: new Date() })
        .where(eq(tournamentPolls.id, pollId));
    },
  };
}
