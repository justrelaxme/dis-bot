import type { Cache } from '../../../core/cache.js';
import type { GameProfile, GameProvider, RankInfo } from './provider.js';

/** Значения из спеки. Первое число — пока данные свежие, второе — пока их ещё можно отдать. */
export const CACHE_TTL = {
  profile: { ttlMs: 24 * 60 * 60 * 1_000, staleMs: 7 * 24 * 60 * 60 * 1_000 },
  rank: { ttlMs: 20 * 60 * 1_000, staleMs: 24 * 60 * 60 * 1_000 },
} as const;

/**
 * Свежесть последнего закэшированного ранга — без самого значения (оно и так есть
 * у вызывающего, например, из БД). true у stale означает: это не текущий ответ
 * сервиса игры, а копия старше обычного TTL, отданная потому, что сервис прямо
 * сейчас не отвечает (обновление в фоне уже запущено или уже провалилось).
 */
export interface RankFreshness {
  stale: boolean;
  storedAt: Date;
}

/**
 * GameProvider, обёрнутый withCache. Расширяет исходный интерфейс необязательной
 * rankFreshness — она нужна тем, кто (как карточка профиля) должен показать
 * пользователю честную отметку устаревания, а не гадать по посторонним меткам
 * времени вроде gameAccounts.updatedAt (её двигает синхронизация на любом исходе,
 * включая сбой, поэтому для устаревания она не источник).
 */
export interface CachedGameProvider extends GameProvider {
  /**
   * Undefined ровно тогда, когда fetchRank тоже undefined (ручной ранг): спрашивать
   * о свежести ответа сервиса игры, которого не существует, бессмысленно.
   */
  rankFreshness?(externalId: string, region?: string): Promise<RankFreshness | undefined>;
}

/**
 * Оборачивает провайдера кэшем: пользователь получает ответ из Redis, а обновление
 * идёт в фоне. Падение провайдера при наличии непросроченной копии превращается
 * в устаревший ответ, а не в ошибку.
 */
export function withCache(provider: GameProvider, cache: Cache): CachedGameProvider {
  // Ключ обязан включать провайдера, вид данных, внешний id и регион — иначе,
  // например, профиль игрока с euw1 отдастся игроку с na1 (тот же externalId,
  // другая платформа Riot).
  function key(kind: string, externalId: string, region?: string): string {
    return `provider:${provider.id}:${kind}:${externalId}:${region ?? '-'}`;
  }

  const wrapped: CachedGameProvider = {
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

  // Провайдер с ручным рангом не получает fetchRank (и rankFreshness): canFetchRank
  // должен остаться false. Присваивать их безусловно нельзя — иначе Valorant (ранг
  // только вручную) начнёт выглядеть как провайдер с API-рангом для canFetchRank,
  // хотя provider.fetchRank у него вообще не реализован.
  if (provider.fetchRank) {
    const fetchRank = provider.fetchRank;

    // Общий вызов для fetchRank и rankFreshness: один и тот же ключ кэша и один и
    // тот же загрузчик, поэтому блокировка обновления (см. Cache.swr) у обоих
    // методов общая и они не запускают повторную загрузку друг у друга за спиной.
    const cachedRank = (externalId: string, region?: string) =>
      cache.swr<RankInfo[]>(key('rank', externalId, region), {
        ...CACHE_TTL.rank,
        load: () => fetchRank(externalId, region),
      });

    wrapped.fetchRank = async (externalId: string, region?: string): Promise<RankInfo[]> =>
      (await cachedRank(externalId, region)).value;

    wrapped.rankFreshness = async (externalId: string, region?: string): Promise<RankFreshness | undefined> => {
      try {
        const { stale, storedAt } = await cachedRank(externalId, region);
        return { stale, storedAt };
      } catch {
        // Ни свежей, ни просроченной копии нет вовсе (например, сервис лёг больше
        // суток назад и запись в Redis истекла физически) — сказать о свежести
        // нечего, и это не повод рушить показ профиля: вызывающий просто не
        // покажет отметку устаревания.
        return undefined;
      }
    };
  }

  return wrapped;
}
