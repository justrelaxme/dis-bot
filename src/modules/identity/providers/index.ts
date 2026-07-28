import type { Cache } from '../../../core/cache.js';
import { UserError } from '../../../core/errors.js';
import type { FetchClient } from '../../../core/http/fetch-client.js';
import type { RateLimiter } from '../../../core/rate-limit.js';
import type { ProviderId } from '../schema.js';
import type { GameProvider } from './provider.js';
import { createRiotProvider } from './riot.js';
import { createSteamProvider } from './steam.js';
import { createValorantProvider } from './valorant.js';
import { withCache } from './with-cache.js';

export interface ProviderRegistryDeps {
  publicBaseUrl: string;
  steamApiKey?: string;
  riotApiKey?: string;
  steamClient: FetchClient;
  openDotaClient: FetchClient;
  riotClient: FetchClient;
  rateLimiter: RateLimiter;
  cache: Cache;
}

/**
 * Здесь и только здесь четыре разных провайдера становятся одной таблицей по id.
 * Дальше весь код бота обращается к ним через реестр, не зная, кто из них что умеет —
 * это выясняется через capabilities и canVerify/canFetchRank (Task 6), а не по имени.
 *
 * Отсутствие ключей Steam/Riot в окружении — законное состояние: createSteamProvider
 * и createRiotProvider проверяют ключ только внутри своих методов, а не при создании,
 * поэтому сборка реестра не падает, даже если ни один ключ не задан.
 *
 * Каждый провайдер оборачивается withCache (Task 18) перед попаданием в реестр:
 * весь код бота получает уже кэширующую версию и не должен знать о Cache вообще.
 */
export function createProviderRegistry(deps: ProviderRegistryDeps): Map<ProviderId, GameProvider> {
  const providers: GameProvider[] = [
    createSteamProvider({
      ...(deps.steamApiKey ? { apiKey: deps.steamApiKey } : {}),
      publicBaseUrl: deps.publicBaseUrl,
      client: deps.steamClient,
      openDotaClient: deps.openDotaClient,
      rateLimiter: deps.rateLimiter,
    }),
    createRiotProvider({
      game: 'lol',
      ...(deps.riotApiKey ? { apiKey: deps.riotApiKey } : {}),
      client: deps.riotClient,
      rateLimiter: deps.rateLimiter,
    }),
    createRiotProvider({
      game: 'tft',
      ...(deps.riotApiKey ? { apiKey: deps.riotApiKey } : {}),
      client: deps.riotClient,
      rateLimiter: deps.rateLimiter,
    }),
    createValorantProvider(),
  ];

  return new Map(providers.map((provider) => [provider.id, withCache(provider, deps.cache)]));
}

/**
 * Единственная точка доступа к провайдеру по id. Намеренно бросает UserError на
 * неизвестном id, а не возвращает undefined и не подделывает провайдер: реестр
 * отвечает за набор возможностей, а не просто хранит строки — вызывающий код
 * должен получить либо настоящий GameProvider, либо явную ошибку, но никогда
 * не «пустой» объект, на котором позже упадёт canVerify/fetchProfile.
 */
export function getProvider(registry: Map<ProviderId, GameProvider>, id: ProviderId): GameProvider {
  const provider = registry.get(id);
  if (!provider) {
    throw new UserError(`Провайдер «${id}» не подключён.`);
  }
  return provider;
}
