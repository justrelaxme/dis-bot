import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../core/db/client.js';
import { UserError } from '../../core/errors.js';
import { tournamentEntrantMembers, tournamentEntrants, tournamentMatches } from '../tournaments/schema.js';
import { matchPredictions, type PredictionRow } from './schema.js';
import { predictionPayout } from './payout.js';

/**
 * Прогнозы на матчи. Монеты берутся те же, что и у прогрессии: вторая валюта на одном сервере
 * означала бы два кошелька, между которыми человек не понимает разницы.
 *
 * Начисление идёт джобой, а не в момент закрытия матча. Причина та же, по которой уборка
 * комнат переехала в джобу: матч закрывается двумя путями — кнопкой и молчанием, — и
 * начисление, живущее в одном из них, во втором не сработает. Джоба смотрит на результат, а
 * не на то, каким путём он получен.
 */

export interface PredictionsDeps {
  db: Database;
  /** Начисление монет. Кошелёк живёт в прогрессии, и лезть в её таблицы напрямую нельзя. */
  grantCoins(guildId: string, userId: string, coins: number, reason: string): Promise<void>;
}

export interface PredictionStanding {
  userId: string;
  total: number;
  correct: number;
  coins: number;
}

export function createPredictionsService(deps: PredictionsDeps) {
  const { db } = deps;

  return {
    /**
     * Записывает прогноз. Отказывает в трёх случаях, и каждый из них — не придирка.
     *
     * Матч должен быть готов к игре: прогноз на матч, где соперники ещё не известны, не про
     * этот матч, а на уже заявленный результат — угадывание задним числом.
     *
     * Участник матча прогноз не даёт: он не угадывает исход, а решает его.
     */
    async predict(matchId: number, guildId: string, userId: string, entrantId: number): Promise<PredictionRow> {
      const [match] = await db.select().from(tournamentMatches).where(eq(tournamentMatches.id, matchId));
      if (!match) throw new UserError('Такого матча нет.');
      if (match.entrantAId === null || match.entrantBId === null) {
        throw new UserError('В этом матче ещё не известны оба соперника — прогнозировать нечего.');
      }
      if (match.state !== 'ready') {
        throw new UserError(
          match.state === 'pending'
            ? 'Матч ещё не начался.'
            : 'По этому матчу результат уже заявлен — прогноз поздно.',
        );
      }
      if (entrantId !== match.entrantAId && entrantId !== match.entrantBId) {
        throw new UserError('Выбирать надо одного из соперников этого матча.');
      }

      const [own] = await db
        .select({ entrantId: tournamentEntrantMembers.entrantId })
        .from(tournamentEntrantMembers)
        .where(
          and(
            eq(tournamentEntrantMembers.tournamentId, match.tournamentId),
            eq(tournamentEntrantMembers.userId, userId),
          ),
        );
      if (own && (own.entrantId === match.entrantAId || own.entrantId === match.entrantBId)) {
        throw new UserError('Ты играешь в этом матче — его исход ты решаешь, а не угадываешь.');
      }

      const [row] = await db
        .insert(matchPredictions)
        .values({ matchId, guildId, userId, entrantId })
        .onConflictDoNothing()
        .returning();
      if (!row) {
        // Прогноз не меняется: возможность передумать это возможность передумать, увидев
        // заявленный результат.
        throw new UserError('Прогноз на этот матч ты уже дал — поменять его нельзя.');
      }
      return row;
    },

    /** Сколько человек и за кого прогнозируют этот матч. Показывается до игры. */
    async tally(matchId: number): Promise<{ entrantId: number; votes: number }[]> {
      const rows = await db
        .select({ entrantId: matchPredictions.entrantId, votes: sql<number>`count(*)::int` })
        .from(matchPredictions)
        .where(eq(matchPredictions.matchId, matchId))
        .groupBy(matchPredictions.entrantId);
      return rows;
    },

    /**
     * Выдаёт награды по закрытым матчам. Идемпотентна: отметка о выдаче ставится тем же
     * обновлением, которое проверяет её отсутствие, поэтому повторный тик не заплатит дважды.
     */
    async settleDue(limit: number): Promise<{ matches: number; paid: number }> {
      const due = await db
        .select({
          matchId: matchPredictions.matchId,
          winnerEntrantId: tournamentMatches.winnerEntrantId,
        })
        .from(matchPredictions)
        .innerJoin(tournamentMatches, eq(tournamentMatches.id, matchPredictions.matchId))
        .where(
          and(
            isNull(matchPredictions.settledAt),
            sql`${tournamentMatches.winnerEntrantId} is not null`,
          ),
        )
        .groupBy(matchPredictions.matchId, tournamentMatches.winnerEntrantId)
        .limit(limit);

      let paid = 0;
      for (const match of due) {
        const winner = match.winnerEntrantId;
        if (winner === null) continue;

        const votes = await this.tally(match.matchId);
        const total = votes.reduce((sum, row) => sum + row.votes, 0);
        const forWinner = votes.find((row) => row.entrantId === winner)?.votes ?? 0;

        const rows = await db
          .select()
          .from(matchPredictions)
          .where(and(eq(matchPredictions.matchId, match.matchId), isNull(matchPredictions.settledAt)));

        for (const row of rows) {
          const coins = predictionPayout({
            correct: row.entrantId === winner,
            votesForPick: forWinner,
            votesTotal: total,
          });

          // Отметка ставится под условием её отсутствия: если тик наложился на предыдущий,
          // обновление не вернёт строку, и монеты не уйдут повторно.
          const [marked] = await db
            .update(matchPredictions)
            .set({ settledAt: new Date(), coinsAwarded: coins })
            .where(and(eq(matchPredictions.id, row.id), isNull(matchPredictions.settledAt)))
            .returning();
          if (!marked) continue;

          if (coins > 0) {
            await deps.grantCoins(row.guildId, row.userId, coins, `прогноз на матч №${row.matchId}`);
            paid += 1;
          }
        }
      }

      return { matches: due.length, paid };
    },

    /** Кто угадывает лучше всех. Только закрытые прогнозы: незакрытые ещё ничего не значат. */
    async standings(guildId: string, limit: number): Promise<PredictionStanding[]> {
      const rows = await db
        .select({
          userId: matchPredictions.userId,
          total: sql<number>`count(*)::int`,
          correct: sql<number>`count(*) filter (where ${matchPredictions.coinsAwarded} > 0)::int`,
          coins: sql<number>`coalesce(sum(${matchPredictions.coinsAwarded}), 0)::int`,
        })
        .from(matchPredictions)
        .where(and(eq(matchPredictions.guildId, guildId), sql`${matchPredictions.settledAt} is not null`))
        .groupBy(matchPredictions.userId)
        .orderBy(sql`coalesce(sum(${matchPredictions.coinsAwarded}), 0) desc`)
        .limit(limit);
      return rows;
    },

    /** Прогнозы человека по идущему турниру — чтобы он видел, что уже назвал. */
    async mine(tournamentId: number, userId: string): Promise<{ matchId: number; team: string }[]> {
      const rows = await db
        .select({ matchId: matchPredictions.matchId, team: tournamentEntrants.displayName })
        .from(matchPredictions)
        .innerJoin(tournamentMatches, eq(tournamentMatches.id, matchPredictions.matchId))
        .innerJoin(tournamentEntrants, eq(tournamentEntrants.id, matchPredictions.entrantId))
        .where(and(eq(tournamentMatches.tournamentId, tournamentId), eq(matchPredictions.userId, userId)));
      return rows;
    },
  };
}

export type PredictionsService = ReturnType<typeof createPredictionsService>;
