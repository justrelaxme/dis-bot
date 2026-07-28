import type { ProviderId, RankScale, RankSource, VerificationMethod } from '../schema.js';

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

export interface ProviderCapabilities {
  verification: VerificationMethod | 'none';
  /** 'manual' означает, что ранг вводит пользователь, а не отдаёт API. */
  rank: 'api' | 'manual';
}

export interface VerificationChallenge {
  /** Код для игрока или nonce для OpenID. Уникален. */
  challenge: string;
  expiresAt: Date;
  payload: Record<string, unknown>;
  /** Показывается пользователю: ссылка или инструкция. */
  instruction?: string;
}

export interface VerifiedAccount {
  externalId: string;
  displayName: string;
  region?: string;
  verificationMethod: VerificationMethod;
}

export interface GameProvider {
  id: ProviderId;
  capabilities: ProviderCapabilities;
  startVerification?(userId: string): Promise<VerificationChallenge>;
  completeVerification?(challenge: VerificationChallenge, input: string): Promise<VerifiedAccount>;
  /** region обязателен для Riot (платформа) и игнорируется Steam. */
  fetchProfile(externalId: string, region?: string): Promise<GameProfile>;
  fetchRank?(externalId: string, region?: string): Promise<RankInfo[]>;
}

/**
 * Проверяет и объявление, и наличие реализации. Одного объявления мало:
 * рассинхрон между capabilities и методами — это баг, который иначе всплывёт
 * у пользователя как «cannot read property of undefined».
 */
export function canVerify(provider: GameProvider): boolean {
  return (
    provider.capabilities.verification !== 'none' &&
    typeof provider.startVerification === 'function' &&
    typeof provider.completeVerification === 'function'
  );
}

export function canFetchRank(provider: GameProvider): boolean {
  return provider.capabilities.rank === 'api' && typeof provider.fetchRank === 'function';
}
