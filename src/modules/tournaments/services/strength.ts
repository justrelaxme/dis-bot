import { sql } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import { rankScore } from '../../identity/ranks/compare.js';
import { verificationPossible } from '../../identity/providers/provider.js';
import type { ProviderId, RankScale, RankSource } from '../../identity/schema.js';
import type { TournamentGame } from '../schema.js';

/**
 * Мост от турниров к рангам этапа 1. Здесь и только здесь дисциплина турнира
 * сопоставляется с провайдером данных: это разные оси, и связывать их в одном месте
 * дешевле, чем растаскивать сопоставление по коду.
 *
 * Для `other` провайдера нет вовсе — жеребьёвка по рангу для такой дисциплины
 * невозможна, и это законное состояние, а не поломка: все получают нулевую силу,
 * и сетка раскладывается по порядку записи.
 */
const GAME_TO_PROVIDER: Record<TournamentGame, ProviderId | null> = {
  dota2: 'steam',
  lol: 'riot-lol',
  tft: 'riot-tft',
  valorant: 'riot-valorant',
};

interface StrengthRow extends Record<string, unknown> {
  entrant_id: number;
  user_id: string;
  scale: RankScale;
  tier: string | null;
  division: string | null;
  points: number | null;
  source: RankSource;
  mode: string;
}

/**
 * Есть ли у человека годная привязка под эту дисциплину. Нужно проводнику:
 * новичок, которому просто сказали «нужна привязка», не понимает, есть она у него или нет,
 * и упирается в отказ уже на регистрации. Бот должен уметь ответить за него.
 *
 * Для `other` провайдера нет — привязка не требуется, и это законное состояние.
 */
export async function hasUsableLink(db: Database, userId: string, game: TournamentGame): Promise<boolean> {
  const provider = GAME_TO_PROVIDER[game];
  if (provider === null) return true;

  // Подтверждение требуется только там, где оно вообще возможно. У Valorant его нет и не
  // будет, и требовать его значило бы навсегда считать игрока Valorant непривязанным —
  // бот просил бы привязать аккаунт человеку, который всё уже сделал.
  const result = await db.execute<{ ok: number }>(sql`
    select 1 as ok
    from game_accounts
    where user_id = ${userId} and provider = ${provider}
      ${verificationPossible(provider) ? sql`and verified_at is not null` : sql``}
    limit 1
  `);
  return result.rows.length > 0;
}

/** Как называется команда привязки для этой дисциплины — чтобы подсказка была точной. */
export function linkCommandFor(game: TournamentGame): string {
  switch (game) {
    case 'dota2':
      return '/link steam';
    case 'lol':
    case 'tft':
      return '/link riot';
    case 'valorant':
      return '/link valorant';
    default:
      return '/link';
  }
}

/**
 * Сила каждого участника: для команды — **средний** ранг состава, для одиночки — его
 * собственный. Средний, а не максимальный: команда из одного Immortal и четырёх Herald
 * играет не как Immortal, и сеять её первой значило бы отдать ей пропуск, которого она
 * не заслужила.
 *
 * Игроки без подтверждённой привязки или без ранга считаются нулём. Это делает порог
 * «выше unranked» рабочим сам собой и не требует отдельной ветки.
 */
export async function entrantStrengths(
  db: Database,
  tournamentId: number,
  game: TournamentGame,
): Promise<Map<number, number>> {
  const provider = GAME_TO_PROVIDER[game];
  const strengths = new Map<number, number>();
  if (provider === null) return strengths;

  // Последний снимок по каждой паре (аккаунт, режим) для подтверждённых привязок игроков
  // этого турнира. DISTINCT ON — ровно тот инструмент, который для этого есть в Postgres.
  const result = await db.execute<StrengthRow>(sql`
    select distinct on (m.entrant_id, m.user_id, s.mode)
      m.entrant_id, m.user_id, s.scale, s.tier, s.division, s.points, s.source, s.mode
    from tournament_entrant_members m
    join game_accounts a
      on a.user_id = m.user_id and a.provider = ${provider}
      ${verificationPossible(provider) ? sql`and a.verified_at is not null` : sql``}
    join rank_snapshots s on s.account_id = a.id
    where m.tournament_id = ${tournamentId}
    order by m.entrant_id, m.user_id, s.mode, s.captured_at desc
  `);

  // Сначала лучший режим каждого **игрока**: у LoL это solo-duo против flex, и складывать
  // оба значило бы считать одного человека дважды.
  const perPlayer = new Map<string, { entrantId: number; score: number }>();

  for (const row of result.rows) {
    const score = rankScore({
      mode: row.mode,
      scale: row.scale,
      tier: row.tier,
      division: row.division,
      points: row.points,
      source: row.source,
      raw: {},
    });
    const key = `${row.entrant_id}:${row.user_id}`;
    const previous = perPlayer.get(key);
    if (!previous || score > previous.score) {
      perPlayer.set(key, { entrantId: row.entrant_id, score });
    }
  }

  // Затем среднее по игрокам участника.
  const byEntrant = new Map<number, number[]>();
  for (const { entrantId, score } of perPlayer.values()) {
    const list = byEntrant.get(entrantId) ?? [];
    list.push(score);
    byEntrant.set(entrantId, list);
  }

  for (const [entrantId, scores] of byEntrant) {
    const total = scores.reduce((sum, score) => sum + score, 0);
    strengths.set(entrantId, Math.round(total / scores.length));
  }

  return strengths;
}
