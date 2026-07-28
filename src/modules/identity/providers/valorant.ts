import { UserError } from '../../../core/errors.js';
import { VALORANT_TIERS, parseRiotTier } from '../ranks/riot.js';
import type { GameProfile, GameProvider, RankInfo } from './provider.js';
import { parseRiotId } from './riot.js';

export const VALORANT_MODE = 'val-competitive';

/**
 * У Valorant нет ни публичного API, ни способа подтвердить владение аккаунтом.
 * Провайдер объявляет это честно через capabilities, а не имитирует работу.
 */
export function createValorantProvider(): GameProvider {
  return {
    id: 'riot-valorant',
    capabilities: { verification: 'none', rank: 'manual' },

    async fetchProfile(riotId: string): Promise<GameProfile> {
      if (!parseRiotId(riotId)) {
        throw new UserError('Riot ID пишется как Имя#Тег, например Игрок#EUW.');
      }
      return { externalId: riotId, displayName: riotId };
    },
  };
}

export function manualValorantRank(input: string): RankInfo {
  const parsed = parseRiotTier(input);
  // parseRiotTier проверяет тир по объединению RIOT_TIERS ∪ VALORANT_TIERS (он общий
  // для обеих игр), поэтому здесь нужна вторая, самостоятельная проверка именно по
  // VALORANT_TIERS: тир вроде EMERALD или CHALLENGER пройдёт parseRiotTier, но в
  // Valorant его не существует.
  if (!parsed || !VALORANT_TIERS.includes(parsed.tier as (typeof VALORANT_TIERS)[number])) {
    throw new UserError(
      `Не понял ранг «${input}». Допустимые тиры: ${VALORANT_TIERS.join(', ')}; дивизион — 1, 2 или 3.`,
    );
  }

  return {
    mode: VALORANT_MODE,
    // КРИТИЧНО (закрытый дефект Task 3): именно 'valorant-tier', а не 'riot-tier'.
    // В Valorant нет тира Emerald, а в LoL есть — при общей шкале валорантовый DIAMOND
    // получал бы индекс, который в шкале LoL принадлежит ASCENDANT, и Diamond оказывался
    // бы выше Ascendant в rankScore, хотя в Valorant всё наоборот. tierIndex в
    // src/modules/identity/ranks/compare.ts выбирает список тиров по scale однозначно —
    // без этой пометки выбор шкалы там был бы неверным.
    scale: 'valorant-tier',
    tier: parsed.tier,
    division: parsed.division,
    points: null,
    source: 'manual',
    raw: { input },
  };
}
