import { sql } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import type { BracketFormat } from '../bracket.js';
import type { TournamentGame } from '../schema.js';

/**
 * Турнирная летопись: что накопилось за все прошедшие события.
 *
 * Ради этого файла турниры и стоит проводить не по одному. Пока ничего не накапливается,
 * турнир — это вечер, который прошёл; накопленное превращает вечера в историю, и
 * возвращаются люди именно за ней, а не за самим фактом матча. Ранг из игры человек и так
 * видит, а «три титула на этом сервере» не увидит больше нигде.
 *
 * Запросы живут отдельно от сервиса турниров, потому что их два потребителя — команда в
 * Discord и витрина, — и одна агрегация в двух местах однажды разошлась бы в цифрах.
 * Матчем считается только `confirmed`: проход без игры и техническая победа при неявке в
 * «сыграно» не попадают, иначе статистика мерила бы явку соперников, а не игру.
 */

/**
 * `db.execute` возвращает строки драйвера без преобразований drizzle: timestamptz
 * приходит текстом, а не Date, и вызов `toLocaleDateString` на нём падает уже в рантайме.
 * Поэтому дата нормализуется здесь, один раз, а типы сырых строк честно объявлены как
 * unknown — иначе аннотация обещала бы Date, которого нет.
 *
 * Счётчики от этого не страдают: все они приведены `::int`, а int4 драйвер разбирает в
 * число сам. Без каста `count(*)` вернул бы bigint, то есть тоже строку.
 */
function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface PlayerRecord {
  /** Завершённых турниров, где человек был в составе. */
  tournaments: number;
  /** Из них выигранных. */
  titles: number;
  matchesPlayed: number;
  matchesWon: number;
  recent: {
    tournamentName: string;
    teamName: string;
    game: TournamentGame;
    finishedAt: Date | null;
    champion: boolean;
    matchesWon: number;
  }[];
}

export async function playerRecord(
  db: Database,
  guildId: string,
  userId: string,
): Promise<PlayerRecord> {
  const totals = await db.execute<{ tournaments: number; titles: number }>(sql`
    select
      count(distinct t.id)::int as tournaments,
      count(distinct case when t.winner_entrant_id = e.id then t.id end)::int as titles
    from tournament_entrant_members m
    join tournament_entrants e on e.id = m.entrant_id
    join tournaments t on t.id = e.tournament_id
    where m.user_id = ${userId} and t.guild_id = ${guildId} and t.state = 'finished'
  `);

  const matches = await db.execute<{ played: number; won: number }>(sql`
    select
      count(*)::int as played,
      count(case when mt.winner_entrant_id = e.id then 1 end)::int as won
    from tournament_entrant_members m
    join tournament_entrants e on e.id = m.entrant_id
    join tournaments t on t.id = e.tournament_id
    join tournament_matches mt
      on mt.tournament_id = t.id and (mt.entrant_a_id = e.id or mt.entrant_b_id = e.id)
    where m.user_id = ${userId} and t.guild_id = ${guildId} and mt.state = 'confirmed'
  `);

  const recent = await db.execute<{
    tournament_name: string;
    team_name: string;
    game: TournamentGame;
    finished_at: unknown;
    champion: boolean;
    matches_won: number;
  }>(sql`
    select
      t.name as tournament_name,
      e.display_name as team_name,
      t.game,
      t.finished_at,
      (t.winner_entrant_id = e.id) as champion,
      count(case when mt.winner_entrant_id = e.id and mt.state = 'confirmed' then 1 end)::int
        as matches_won
    from tournament_entrant_members m
    join tournament_entrants e on e.id = m.entrant_id
    join tournaments t on t.id = e.tournament_id
    left join tournament_matches mt
      on mt.tournament_id = t.id and (mt.entrant_a_id = e.id or mt.entrant_b_id = e.id)
    where m.user_id = ${userId} and t.guild_id = ${guildId} and t.state = 'finished'
    group by t.id, e.id
    order by t.finished_at desc nulls last
    limit 5
  `);

  return {
    tournaments: totals.rows[0]?.tournaments ?? 0,
    titles: totals.rows[0]?.titles ?? 0,
    matchesPlayed: matches.rows[0]?.played ?? 0,
    matchesWon: matches.rows[0]?.won ?? 0,
    recent: recent.rows.map((row) => ({
      tournamentName: row.tournament_name,
      teamName: row.team_name,
      game: row.game,
      finishedAt: asDate(row.finished_at),
      champion: row.champion,
      matchesWon: row.matches_won,
    })),
  };
}

export interface FinishedTournament {
  id: number;
  name: string;
  game: TournamentGame;
  format: BracketFormat;
  finishedAt: Date | null;
  champion: string | null;
  entrants: number;
  matches: number;
}

/** Завершённые турниры с чемпионом, новые сверху. Это и есть летопись сервера. */
export async function finishedTournaments(
  db: Database,
  guildId: string,
  limit: number,
): Promise<FinishedTournament[]> {
  const result = await db.execute<{
    id: number;
    name: string;
    game: TournamentGame;
    format: BracketFormat;
    finished_at: unknown;
    champion: string | null;
    entrants: number;
    matches: number;
  }>(sql`
    select
      t.id, t.name, t.game, t.format, t.finished_at,
      w.display_name as champion,
      (
        select count(*)::int from tournament_entrants x
        where x.tournament_id = t.id and x.seed is not null
      ) as entrants,
      (
        select count(*)::int from tournament_matches x
        where x.tournament_id = t.id and x.state = 'confirmed'
      ) as matches
    from tournaments t
    left join tournament_entrants w on w.id = t.winner_entrant_id
    where t.guild_id = ${guildId} and t.state = 'finished'
    order by t.finished_at desc nulls last
    limit ${limit}
  `);

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    game: row.game,
    format: row.format,
    finishedAt: asDate(row.finished_at),
    champion: row.champion,
    entrants: row.entrants,
    matches: row.matches,
  }));
}

export interface TeamTitles {
  name: string;
  titles: number;
  lastAt: Date | null;
}

/**
 * Титулы по названию команды. Считается по названию, а не по составу, и это осознанное
 * упрощение: состав собирается заново на каждый турнир, а название люди переносят из
 * недели в неделю — оно и есть то, чем команда себя называет. Два разных состава под одним
 * названием сложатся в одну строку, поэтому таблица подписана как «по названию».
 */
export async function titlesByTeam(
  db: Database,
  guildId: string,
  limit: number,
): Promise<TeamTitles[]> {
  const result = await db.execute<{ name: string; titles: number; last_at: unknown }>(sql`
    select w.display_name as name, count(*)::int as titles, max(t.finished_at) as last_at
    from tournaments t
    join tournament_entrants w on w.id = t.winner_entrant_id
    where t.guild_id = ${guildId} and t.state = 'finished'
    group by w.display_name
    order by titles desc, max(t.finished_at) desc nulls last
    limit ${limit}
  `);

  return result.rows.map((row) => ({
    name: row.name,
    titles: row.titles,
    lastAt: asDate(row.last_at),
  }));
}
