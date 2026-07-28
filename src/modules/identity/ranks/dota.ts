import type { RankInfo } from '../providers/provider.js';

/** Порядок значим: индекс используется как числовая шкала в compare.ts. */
export const DOTA_MEDALS = [
  'HERALD',
  'GUARDIAN',
  'CRUSADER',
  'ARCHON',
  'LEGEND',
  'ANCIENT',
  'DIVINE',
  'IMMORTAL',
] as const;

const IMMORTAL_INDEX = DOTA_MEDALS.indexOf('IMMORTAL');

export interface OpenDotaPlayer {
  /** Двузначный код: медаль * 10 + звезда. У Immortal звёзд нет — код 80. */
  rank_tier: number | null;
  leaderboard_rank?: number | null;
}

export function normalizeDotaRank(player: OpenDotaPlayer): RankInfo | null {
  const code = player.rank_tier;
  if (code === null || code === undefined) return null;

  const medalIndex = Math.floor(code / 10) - 1;
  const star = code % 10;
  const medal = DOTA_MEDALS[medalIndex];
  if (!medal) return null;

  const isImmortal = medalIndex === IMMORTAL_INDEX;
  if (!isImmortal && (star < 1 || star > 5)) return null;

  return {
    mode: 'dota-mmr',
    scale: 'dota-mmr',
    tier: medal,
    division: isImmortal ? null : String(star),
    points: isImmortal ? (player.leaderboard_rank ?? null) : null,
    source: 'api',
    raw: player,
  };
}
