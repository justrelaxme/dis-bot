import type { RankScale, RankSource } from '../schema.js';

/** Ранг в общем виде: выше этого типа код не знает специфики игр. */
export interface RankInfo {
  mode: string;
  scale: RankScale;
  tier: string | null;
  division: string | null;
  points: number | null;
  source: RankSource;
  raw: unknown;
}

export interface GameProfile {
  externalId: string;
  displayName: string;
  avatarUrl?: string;
  region?: string;
}
