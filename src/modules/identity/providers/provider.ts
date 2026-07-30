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

/**
 * Провайдеры, у которых подтверждение владения невозможно **в принципе** — не «пока не
 * сделано», а нечем и не будет: у Valorant нет ни публичного API, ни способа доказать,
 * что аккаунт твой.
 *
 * Список нужен там, где до объекта провайдера не достать: в SQL-запросах по game_accounts.
 * Он обязан совпадать с `capabilities.verification === 'none'` у самих провайдеров —
 * рассинхрон здесь означает, что игрок либо получит роль по заявленному рангу, либо
 * навсегда останется «непривязанным».
 *
 * Зачем вообще: решение «Valorant подтвердить нечем» было верным, а вот следствие из него
 * разъехалось. Условие «подтверждено» стояло в четырёх местах — в подсказках новичку, в
 * жеребьёвке, в лидерборде и в разборе «что мне делать», — и игрок Valorant оказывался
 * второсортным всюду: привязка сохранена, а бот бесконечно просит привязать аккаунт, на
 * сайте ничего не появляется, в сетке он идёт нулевой силой. Требовать подтверждения там,
 * где его не бывает, — значит требовать невозможного.
 *
 * Единственное место, где подтверждение по-прежнему обязательно, — выдача роли за ранг.
 * Там это защита от «я Radiant, дайте роль», и она остаётся.
 */
export const UNVERIFIABLE_PROVIDERS: readonly ProviderId[] = ['riot-valorant'];

/** Подтверждение владения у этой игры возможно вообще? */
export function verificationPossible(provider: ProviderId): boolean {
  return !UNVERIFIABLE_PROVIDERS.includes(provider);
}
