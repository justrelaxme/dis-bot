import type { Cache } from '../../../core/cache.js';
import type { GameProfile, GameProvider, RankInfo } from './provider.js';

/** Значения из спеки. Первое число — пока данные свежие, второе — пока их ещё можно отдать. */
export const CACHE_TTL = {
  profile: { ttlMs: 24 * 60 * 60 * 1_000, staleMs: 7 * 24 * 60 * 60 * 1_000 },
  rank: { ttlMs: 20 * 60 * 1_000, staleMs: 24 * 60 * 60 * 1_000 },
} as const;

/**
 * Оборачивает провайдера кэшем: пользователь получает ответ из Redis, а обновление
 * идёт в фоне. Падение провайдера при наличии непросроченной копии превращается
 * в устаревший ответ, а не в ошибку.
 */
export function withCache(provider: GameProvider, cache: Cache): GameProvider {
  // Ключ обязан включать провайдера, вид данных, внешний id и регион — иначе,
  // например, профиль игрока с euw1 отдастся игроку с na1 (тот же externalId,
  // другая платформа Riot).
  function key(kind: string, externalId: string, region?: string): string {
    return `provider:${provider.id}:${kind}:${externalId}:${region ?? '-'}`;
  }

  const wrapped: GameProvider = {
    id: provider.id,
    capabilities: provider.capabilities,

    async fetchProfile(externalId: string, region?: string): Promise<GameProfile> {
      const result = await cache.swr<GameProfile>(key('profile', externalId, region), {
        ...CACHE_TTL.profile,
        load: () => provider.fetchProfile(externalId, region),
      });
      return result.value;
    },
  };

  if (provider.startVerification) wrapped.startVerification = provider.startVerification;
  if (provider.completeVerification) wrapped.completeVerification = provider.completeVerification;

  // Провайдер с ручным рангом не получает fetchRank: canFetchRank должен остаться false.
  // Присваивать его безусловно нельзя — иначе Valorant (ранг только вручную) начнёт
  // выглядеть как провайдер с API-рангом для canFetchRank, хотя provider.fetchRank
  // у него вообще не реализован.
  if (provider.fetchRank) {
    wrapped.fetchRank = async (externalId: string, region?: string): Promise<RankInfo[]> => {
      const result = await cache.swr<RankInfo[]>(key('rank', externalId, region), {
        ...CACHE_TTL.rank,
        load: () => provider.fetchRank!(externalId, region),
      });
      return result.value;
    };
  }

  return wrapped;
}
