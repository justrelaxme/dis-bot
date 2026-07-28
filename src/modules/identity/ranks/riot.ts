import type { RankInfo } from '../providers/provider.js';

/** Порядок значим: индекс используется как числовая шкала в compare.ts. */
export const RIOT_TIERS = [
  'IRON',
  'BRONZE',
  'SILVER',
  'GOLD',
  'PLATINUM',
  'EMERALD',
  'DIAMOND',
  'MASTER',
  'GRANDMASTER',
  'CHALLENGER',
] as const;

/** Тиры Valorant. Вводятся вручную, поэтому список нужен только для разбора. */
export const VALORANT_TIERS = [
  'IRON',
  'BRONZE',
  'SILVER',
  'GOLD',
  'PLATINUM',
  'DIAMOND',
  'ASCENDANT',
  'IMMORTAL',
  'RADIANT',
] as const;

/** У Master и выше дивизионов нет, хотя API всё равно присылает rank: 'I'. */
const TIERS_WITHOUT_DIVISION = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER', 'RADIANT']);

const DIVISIONS = ['I', 'II', 'III', 'IV'] as const;
const ARABIC_TO_ROMAN: Record<string, string> = { '1': 'I', '2': 'II', '3': 'III', '4': 'IV' };

const QUEUE_TO_MODE: Record<string, string> = {
  RANKED_SOLO_5x5: 'solo-duo',
  RANKED_FLEX_SR: 'flex',
  RANKED_TFT: 'tft-ranked',
  RANKED_TFT_DOUBLE_UP: 'tft-double-up',
};

export interface RiotLeagueEntry {
  queueType: string;
  tier: string;
  rank: string;
  leaguePoints: number;
}

export function normalizeRiotEntry(entry: RiotLeagueEntry): RankInfo | null {
  const mode = QUEUE_TO_MODE[entry.queueType];
  if (!mode) return null;

  const tier = entry.tier.toUpperCase();
  if (!RIOT_TIERS.includes(tier as (typeof RIOT_TIERS)[number])) return null;

  return {
    mode,
    scale: 'riot-tier',
    tier,
    division: TIERS_WITHOUT_DIVISION.has(tier) ? null : entry.rank.toUpperCase(),
    points: entry.leaguePoints,
    source: 'api',
    raw: entry,
  };
}

const KNOWN_TIERS = new Set<string>([...RIOT_TIERS, ...VALORANT_TIERS]);

/** Разбирает ввод человека: «platinum ii», «Immortal 2», «RADIANT». */
export function parseRiotTier(input: string): { tier: string; division: string | null } | null {
  const parts = input.trim().toUpperCase().split(/\s+/).filter(Boolean);
  const [tierPart, divisionPart] = parts;
  if (!tierPart || !KNOWN_TIERS.has(tierPart)) return null;

  if (TIERS_WITHOUT_DIVISION.has(tierPart) || divisionPart === undefined) {
    return { tier: tierPart, division: null };
  }

  const division = ARABIC_TO_ROMAN[divisionPart] ?? divisionPart;
  if (!DIVISIONS.includes(division as (typeof DIVISIONS)[number])) return null;

  return { tier: tierPart, division };
}
