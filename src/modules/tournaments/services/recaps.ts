import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import { matchPredictions } from '../../predictions/schema.js';
import type { WeekData } from '../recap.js';
import {
  draftChoices,
  matchDrafts,
  tournamentEntrantMembers,
  tournamentEntrants,
  tournamentMatches,
  tournaments,
  weeklyRecaps,
  type TournamentGame,
} from '../schema.js';
import { standingsOf } from '../standings.js';
import type { CircuitService } from './circuit.js';

/**
 * Данные для итога недели: всё уже лежит в базе — сетки, драфты, прогнозы, серия. Итог их
 * только собирает; текст строит `recap.ts`.
 */
export function createRecapsService(deps: { db: Database; circuit: Pick<CircuitService, 'open' | 'standings'> }) {
  const { db } = deps;

  return {
    /** Серверы, у которых за окно доигран хоть один турнир: остальным итог не нужен. */
    async guildsWithFinished(since: Date, until: Date): Promise<string[]> {
      const rows = await db
        .selectDistinct({ guildId: tournaments.guildId })
        .from(tournaments)
        .where(and(eq(tournaments.state, 'finished'), gte(tournaments.finishedAt, since), lt(tournaments.finishedAt, until)));
      return rows.map((row) => row.guildId);
    },

    /** Занять неделю. `false` — итог за неё уже выходил (или выходит прямо сейчас). */
    async claim(guildId: string, weekOf: string): Promise<boolean> {
      const [row] = await db.insert(weeklyRecaps).values({ guildId, weekOf }).onConflictDoNothing().returning();
      return row !== undefined;
    },

    async posted(guildId: string, weekOf: string, messageId: string): Promise<void> {
      await db
        .update(weeklyRecaps)
        .set({ messageId })
        .where(and(eq(weeklyRecaps.guildId, guildId), eq(weeklyRecaps.weekOf, weekOf)));
    },

    /** Отправить не вышло — отдать неделю обратно, чтобы следующий тик попробовал снова. */
    async release(guildId: string, weekOf: string): Promise<void> {
      await db.delete(weeklyRecaps).where(and(eq(weeklyRecaps.guildId, guildId), eq(weeklyRecaps.weekOf, weekOf)));
    },

    /** Куда писать: канал объявлений последнего турнира сервера. */
    async channelOf(guildId: string): Promise<string | null> {
      const [row] = await db
        .select({ channelId: tournaments.announceChannelId })
        .from(tournaments)
        .where(and(eq(tournaments.guildId, guildId), sql`${tournaments.announceChannelId} is not null`))
        .orderBy(desc(tournaments.id))
        .limit(1);
      return row?.channelId ?? null;
    },

    async gather(guildId: string, since: Date, until: Date): Promise<WeekData> {
      const finished = await db
        .select()
        .from(tournaments)
        .where(
          and(
            eq(tournaments.guildId, guildId),
            eq(tournaments.state, 'finished'),
            gte(tournaments.finishedAt, since),
            lt(tournaments.finishedAt, until),
          ),
        )
        .orderBy(tournaments.finishedAt);
      const ids = finished.map((row) => row.id);
      if (ids.length === 0) {
        return { tournaments: [], streaks: [], drafts: [], predictor: null, upset: null, season: null };
      }

      const [matches, entrants, members] = await Promise.all([
        db.select().from(tournamentMatches).where(inArray(tournamentMatches.tournamentId, ids)),
        db.select().from(tournamentEntrants).where(inArray(tournamentEntrants.tournamentId, ids)),
        db.select().from(tournamentEntrantMembers).where(inArray(tournamentEntrantMembers.tournamentId, ids)),
      ]);
      const nameOf = (id: number | null): string | null => entrants.find((row) => row.id === id)?.displayName ?? null;

      const titles = new Map<string, number>();
      const list = finished.map((tournament) => {
        const own = matches.filter((match) => match.tournamentId === tournament.id);
        const championId = standingsOf(own).championId;
        for (const member of members.filter((row) => row.entrantId === championId)) {
          titles.set(member.userId, (titles.get(member.userId) ?? 0) + 1);
        }
        return {
          name: tournament.name,
          game: tournament.game,
          champion: nameOf(championId),
          entrants: entrants.filter((row) => row.tournamentId === tournament.id && row.seed !== null).length,
        };
      });

      // Апсет — победа того, кто был посеян ниже, с самым большим разрывом в посеве. Проход без
      // игры не в счёт: неявка соперника — не подвиг.
      let upset: WeekData['upset'] = null;
      for (const match of matches) {
        if (match.state !== 'confirmed' || match.winnerEntrantId === null) continue;
        const loserId = match.winnerEntrantId === match.entrantAId ? match.entrantBId : match.entrantAId;
        const winner = entrants.find((row) => row.id === match.winnerEntrantId);
        const loser = entrants.find((row) => row.id === loserId);
        if (!winner?.seed || !loser?.seed || winner.seed <= loser.seed) continue;
        if (upset && winner.seed - loser.seed <= upset.winnerSeed - upset.loserSeed) continue;
        upset = {
          winner: winner.displayName,
          loser: loser.displayName,
          winnerSeed: winner.seed,
          loserSeed: loser.seed,
          tournament: finished.find((row) => row.id === match.tournamentId)?.name ?? '',
        };
      }

      // Драфт: самое частое по дисциплине. Название берём из пула самого драфта — снимка на
      // момент матча, а не из сегодняшнего справочника.
      const drafts = await db.select().from(matchDrafts).where(inArray(matchDrafts.tournamentId, ids));
      const choices = drafts.length
        ? await db.select().from(draftChoices).where(inArray(draftChoices.draftId, drafts.map((row) => row.id)))
        : [];
      const counts = new Map<string, { game: TournamentGame; kind: string; label: string; count: number }>();
      for (const choice of choices) {
        if (!choice.optionId) continue;
        const draft = drafts.find((row) => row.id === choice.draftId);
        const game = finished.find((row) => row.id === draft?.tournamentId)?.game;
        const label = draft?.pool.find((option) => option.id === choice.optionId)?.label;
        if (!draft || !game || !label) continue;
        const key = `${game}:${choice.kind}:${choice.optionId}`;
        const entry = counts.get(key) ?? { game, kind: choice.kind, label, count: 0 };
        entry.count += 1;
        counts.set(key, entry);
      }
      const top = (game: TournamentGame, kind: string) =>
        [...counts.values()]
          .filter((row) => row.game === game && row.kind === kind && row.count > 1)
          .sort((a, b) => b.count - a.count)[0] ?? null;
      const games = [...new Set(finished.map((row) => row.game))];
      const draftTops = games.map((game) => {
        const pick = top(game, 'pick');
        const ban = top(game, 'ban');
        return {
          game,
          pick: pick ? { label: pick.label, count: pick.count } : null,
          ban: ban ? { label: ban.label, count: ban.count } : null,
        };
      });

      const [predictor] = await db
        .select({
          userId: matchPredictions.userId,
          coins: sql<number>`coalesce(sum(${matchPredictions.coinsAwarded}), 0)::int`,
          correct: sql<number>`count(*) filter (where ${matchPredictions.coinsAwarded} > 0)::int`,
          total: sql<number>`count(*)::int`,
        })
        .from(matchPredictions)
        .where(
          and(
            eq(matchPredictions.guildId, guildId),
            gte(matchPredictions.settledAt, since),
            lt(matchPredictions.settledAt, until),
            sql`${matchPredictions.voidedAt} is null`,
          ),
        )
        .groupBy(matchPredictions.userId)
        .orderBy(desc(sql`sum(${matchPredictions.coinsAwarded})`))
        .limit(1);

      const season = await deps.circuit.open(guildId);
      const leaders = season ? await deps.circuit.standings(season.id, 3) : [];

      return {
        tournaments: list,
        streaks: [...titles.entries()].filter(([, count]) => count > 1).map(([userId, count]) => ({ userId, titles: count })),
        drafts: draftTops,
        predictor: predictor ?? null,
        upset,
        season: season ? { name: season.name, leaders: leaders.map((row) => ({ userId: row.userId, points: row.points })) } : null,
      };
    },
  };
}

export type RecapsService = ReturnType<typeof createRecapsService>;
