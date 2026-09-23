import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import { UserError } from '../../../core/errors.js';
import { circuitPoints as pointsFor, placementsOf } from '../placements.js';
import {
  circuitPoints,
  circuitSeasons,
  tournamentEntrantMembers,
  tournamentEntrants,
  tournamentMatches,
  tournaments,
  type CircuitSeasonRow,
} from '../schema.js';

/**
 * Сезонная серия: еженедельные турниры складываются в одну таблицу.
 *
 * При шестнадцати игроках и турнире раз в неделю отдельный вечер забывается через день. Серия
 * даёт ему продолжение: каждый доигранный турнир начисляет очки всем, кто в нём играл, и в
 * конце сезона у сервера есть чемпион — не одного вечера, а всего сезона.
 *
 * Серия включается руками (`/season start`): без открытого сезона очки не начисляются, и
 * сервер, которому это не нужно, ничего не замечает.
 */

export interface CircuitStanding {
  userId: string;
  name: string | null;
  points: number;
  tournaments: number;
  titles: number;
  best: number;
}

export function createCircuitService(deps: { db: Database }) {
  const { db } = deps;

  async function open(guildId: string): Promise<CircuitSeasonRow | null> {
    const [row] = await db
      .select()
      .from(circuitSeasons)
      .where(and(eq(circuitSeasons.guildId, guildId), isNull(circuitSeasons.closedAt)));
    return row ?? null;
  }

  async function standings(seasonId: number, limit = 50): Promise<CircuitStanding[]> {
    const rows = await db
      .select({
        userId: circuitPoints.userId,
        // Последнее известное имя: у игрока могло смениться отображаемое имя за сезон.
        name: sql<string | null>`(array_agg(${circuitPoints.displayName} order by ${circuitPoints.createdAt} desc) filter (where ${circuitPoints.displayName} is not null))[1]`,
        points: sql<number>`sum(${circuitPoints.points})::int`,
        tournaments: sql<number>`count(*)::int`,
        titles: sql<number>`count(*) filter (where ${circuitPoints.place} = 1)::int`,
        best: sql<number>`min(${circuitPoints.place})::int`,
      })
      .from(circuitPoints)
      .where(eq(circuitPoints.seasonId, seasonId))
      .groupBy(circuitPoints.userId)
      // При равенстве очков выше тот, у кого больше титулов, затем — лучшее место.
      .orderBy(
        desc(sql`sum(${circuitPoints.points})`),
        desc(sql`count(*) filter (where ${circuitPoints.place} = 1)`),
        asc(sql`min(${circuitPoints.place})`),
      )
      .limit(limit);
    return rows;
  }

  return {
    open,
    standings,

    async start(guildId: string, name: string): Promise<CircuitSeasonRow> {
      const title = name.trim().slice(0, 60);
      if (!title) throw new UserError('Назови сезон — например, «Осень 2026».');
      const [row] = await db.insert(circuitSeasons).values({ guildId, name: title }).onConflictDoNothing().returning();
      if (!row) {
        const current = await open(guildId);
        throw new UserError(`Сезон «${current?.name ?? '?'}» ещё идёт — сначала закрой его: \`/season close\`.`);
      }
      return row;
    },

    /** Закрыть сезон: лидер таблицы становится чемпионом. */
    async close(guildId: string): Promise<{ season: CircuitSeasonRow; table: CircuitStanding[] }> {
      const current = await open(guildId);
      if (!current) throw new UserError('Открытого сезона нет — начать: `/season start`.');
      const table = await standings(current.id, 50);
      const champion = table[0] ?? null;
      const [closed] = await db
        .update(circuitSeasons)
        .set({ closedAt: new Date(), championUserId: champion?.userId ?? null, championName: champion?.name ?? null })
        .where(and(eq(circuitSeasons.id, current.id), isNull(circuitSeasons.closedAt)))
        .returning();
      if (!closed) throw new UserError('Сезон уже закрыт.');
      return { season: closed, table };
    },

    /**
     * Начислить очки за доигранный турнир. Идемпотентно: строка на человека за турнир
     * уникальна, и повторное событие о конце турнира ничего не добавит.
     *
     * Отдаёт тех, у кого имени нет (игроки команд), — имя подтянет вызывающий из Discord.
     */
    async award(tournamentId: number): Promise<{ awarded: number; unnamed: string[] }> {
      const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, tournamentId));
      if (!tournament || tournament.state !== 'finished') return { awarded: 0, unnamed: [] };
      const season = await open(tournament.guildId);
      if (!season) return { awarded: 0, unnamed: [] };

      const matches = await db.select().from(tournamentMatches).where(eq(tournamentMatches.tournamentId, tournamentId));
      const placements = placementsOf(matches);
      if (placements.length === 0) return { awarded: 0, unnamed: [] };

      const entrants = await db.select().from(tournamentEntrants).where(eq(tournamentEntrants.tournamentId, tournamentId));
      const members = await db
        .select()
        .from(tournamentEntrantMembers)
        .where(eq(tournamentEntrantMembers.tournamentId, tournamentId));
      // Размер поля — те, кто попал в сетку: не записавшиеся и не отметившиеся не в счёт.
      const fieldSize = entrants.filter((entrant) => entrant.seed !== null).length;

      let awarded = 0;
      const unnamed: string[] = [];
      for (const placement of placements) {
        const entrant = entrants.find((row) => row.id === placement.entrantId);
        if (!entrant) continue;
        const points = pointsFor(placement, fieldSize);
        const solo = tournament.entryMode === 'solo';
        for (const member of members.filter((row) => row.entrantId === entrant.id)) {
          const [row] = await db
            .insert(circuitPoints)
            .values({
              seasonId: season.id,
              tournamentId,
              guildId: tournament.guildId,
              userId: member.userId,
              displayName: solo ? entrant.displayName : null,
              game: tournament.game,
              place: placement.place,
              placeTo: placement.placeTo,
              fieldSize,
              points,
            })
            .onConflictDoNothing()
            .returning({ id: circuitPoints.id });
          if (!row) continue;
          awarded += 1;
          if (!solo) unnamed.push(member.userId);
        }
      }
      return { awarded, unnamed };
    },

    /** Имя игрока для таблицы на сайте — подтянутое из Discord после начисления. */
    async nameUnnamed(tournamentId: number, userId: string, displayName: string): Promise<void> {
      await db
        .update(circuitPoints)
        .set({ displayName: displayName.slice(0, 80) })
        .where(
          and(
            eq(circuitPoints.tournamentId, tournamentId),
            eq(circuitPoints.userId, userId),
            isNull(circuitPoints.displayName),
          ),
        );
    },

    /** Очки человека за этот турнир — для строки в итоге турнира. */
    async pointsOf(tournamentId: number): Promise<{ userId: string; points: number; place: number; placeTo: number }[]> {
      return db
        .select({
          userId: circuitPoints.userId,
          points: circuitPoints.points,
          place: circuitPoints.place,
          placeTo: circuitPoints.placeTo,
        })
        .from(circuitPoints)
        .where(eq(circuitPoints.tournamentId, tournamentId));
    },

    /** Закрытые сезоны — для зала славы. */
    async champions(guildId: string, limit = 20): Promise<CircuitSeasonRow[]> {
      return db
        .select()
        .from(circuitSeasons)
        .where(and(eq(circuitSeasons.guildId, guildId), sql`${circuitSeasons.closedAt} is not null`))
        .orderBy(desc(circuitSeasons.closedAt))
        .limit(limit);
    },
  };
}

export type CircuitService = ReturnType<typeof createCircuitService>;
