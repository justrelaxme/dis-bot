import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { UserError } from '../../../core/errors.js';
import type { FetchClient } from '../../../core/http/fetch-client.js';
import type { Limit, RateLimiter } from '../../../core/rate-limit.js';
import { normalizeRiotEntry } from '../ranks/riot.js';
import type { GameProfile, GameProvider, RankInfo, VerificationChallenge } from './provider.js';

/**
 * Единственное место с путями Riot API. Riot переводит всё на PUUID и убирает
 * encryptedSummonerId — если пути сдвинутся, правится только этот объект.
 *
 * Сверено с публичным перечнем API на developer.riotgames.com/apis и с независимым
 * OpenAPI-зеркалом схемы Riot (см. отчёт задачи, там же — источники и даты сверки):
 *  - account-v1 (by-riot-id, by-puuid) и league-v4 entries by-puuid — подтверждены дословно;
 *  - tft-league-v1: путь по факту БЕЗ сегмента "entries" (не как у LoL) — исправлено
 *    относительно примера из брифа, отклонение описано в отчёте;
 *  - third-party-code: на момент сверки не числится в публичном перечне API Riot вообще
 *    (ни на странице портала, ни в OpenAPI-зеркале). Путь ниже — предположение по
 *    аналогии с остальным platform-v4, единственное место правки, если API вернётся
 *    или сдвинется. Это не мешает сдаче задачи: этап спроектирован без прод-ключа.
 */
const ENDPOINTS = {
  accountByRiotId: (route: string, gameName: string, tagLine: string) =>
    `https://${route}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
  accountByPuuid: (route: string, puuid: string) =>
    `https://${route}.api.riotgames.com/riot/account/v1/accounts/by-puuid/${puuid}`,
  lolEntries: (platform: string, puuid: string) =>
    `https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`,
  tftEntries: (platform: string, puuid: string) =>
    `https://${platform}.api.riotgames.com/tft/league/v1/by-puuid/${puuid}`,
  thirdPartyCode: (platform: string, puuid: string) =>
    `https://${platform}.api.riotgames.com/lol/platform/v4/third-party-code/by-puuid/${puuid}`,
} as const;

const PLATFORM_TO_ROUTE: Record<string, string> = {
  br1: 'americas',
  la1: 'americas',
  la2: 'americas',
  na1: 'americas',
  eun1: 'europe',
  euw1: 'europe',
  me1: 'europe',
  ru: 'europe',
  tr1: 'europe',
  jp1: 'asia',
  kr: 'asia',
  oc1: 'sea',
  ph2: 'sea',
  sg2: 'sea',
  th2: 'sea',
  tw2: 'sea',
  vn2: 'sea',
};

export const RIOT_PLATFORMS = Object.keys(PLATFORM_TO_ROUTE) as readonly string[];

/** Лимиты dev-ключа. С production-ключом их можно поднять. */
const RIOT_LIMITS: Limit[] = [
  { tokens: 20, windowMs: 1_000 },
  { tokens: 100, windowMs: 120_000 },
];

const VERIFICATION_TTL_MS = 15 * 60 * 1_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Долг из Task 2: normalizeRiotEntry ждёт уже правильную форму и на битом JSON бросит
 * TypeError (entry.tier.toUpperCase() и т.п.), а не ProviderError. Валидировать форму
 * ответа Riot — задача этого файла, поэтому каждый вызов client.json ниже получает
 * schema: FetchClient сам вызывает schema.parse и превращает несовпадение в ProviderError
 * с сообщением «неожиданный формат ответа: …» — своих try/catch не нужно.
 *
 * Схемы проверяют только то, что реально разыменовывается кодом ниже (или уходит в
 * normalizeRiotEntry) — остальные поля настоящих Riot DTO нам не нужны, и zod их не
 * запрещает, просто отбрасывает.
 */
const riotAccountSchema = z.object({
  puuid: z.string().min(1),
  gameName: z.string(),
  tagLine: z.string(),
});

type RiotAccount = z.infer<typeof riotAccountSchema>;

/** Ответ third-party-code — голая JSON-строка с кодом, вписанным в клиент игры. */
const thirdPartyCodeSchema = z.string();

/** Массив LeagueEntryDTO — ровно те поля, что использует normalizeRiotEntry. */
const riotLeagueEntriesSchema = z.array(
  z.object({
    queueType: z.string(),
    tier: z.string(),
    rank: z.string(),
    leaguePoints: z.number(),
  }),
);

export function platformToRegionalRoute(platform: string): string {
  const route = PLATFORM_TO_ROUTE[platform];
  if (!route) {
    throw new UserError(`Неизвестная платформа Riot: «${platform}». Допустимые: ${RIOT_PLATFORMS.join(', ')}.`);
  }
  return route;
}

export function parseRiotId(input: string): { gameName: string; tagLine: string } | null {
  const [rawName, rawTag, ...rest] = input.split('#');
  if (rest.length > 0) return null;
  const gameName = rawName?.trim() ?? '';
  const tagLine = rawTag?.trim() ?? '';
  if (!gameName || !tagLine) return null;
  return { gameName, tagLine };
}

export interface RiotProviderDeps {
  game: 'lol' | 'tft';
  apiKey?: string;
  client: FetchClient;
  rateLimiter: RateLimiter;
}

export function createRiotProvider(deps: RiotProviderDeps): GameProvider {
  function headers(): Record<string, string> {
    if (!deps.apiKey) {
      throw new UserError('Интеграция с Riot не настроена: в окружении нет RIOT_API_KEY.');
    }
    return { 'X-Riot-Token': deps.apiKey };
  }

  /** Каждый вызов обязан передать schema — это гарантирует, что битый ответ Riot даст
   * ProviderError, а не необработанный TypeError где-то в normalizeRiotEntry. */
  async function call<T>(url: string, schema: { parse(input: unknown): T }): Promise<T> {
    await deps.rateLimiter.acquire('riot', RIOT_LIMITS);
    return deps.client.json<T>(url, { headers: headers(), schema });
  }

  function requirePlatform(region?: string): string {
    if (!region) {
      throw new UserError('Для запроса к Riot нужен регион (платформа), например euw1 или ru.');
    }
    return region;
  }

  return {
    id: deps.game === 'lol' ? 'riot-lol' : 'riot-tft',
    capabilities: { verification: 'riot-third-party-code', rank: 'api' },

    async startVerification(): Promise<VerificationChallenge> {
      const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      return {
        challenge: code,
        expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
        payload: {},
        instruction:
          `Открой клиент League of Legends → Настройки → Проверка → и вставь этот код:\n\`${code}\`\n\n` +
          `Потом вернись сюда и повтори команду с тем же Riot ID. Код действует 15 минут.`,
      };
    },

    async completeVerification(challenge, riotId) {
      const parsed = parseRiotId(riotId);
      if (!parsed) {
        throw new UserError('Riot ID пишется как Имя#Тег, например Игрок#EUW.');
      }
      const platform = requirePlatform(challenge.payload['platform'] as string | undefined);
      const route = platformToRegionalRoute(platform);

      const account = await call<RiotAccount>(
        ENDPOINTS.accountByRiotId(route, parsed.gameName, parsed.tagLine),
        riotAccountSchema,
      );
      const codeInClient = await call(ENDPOINTS.thirdPartyCode(platform, account.puuid), thirdPartyCodeSchema);

      if (codeInClient.trim().toUpperCase() !== challenge.challenge.toUpperCase()) {
        throw new UserError(
          'Код в клиенте не совпал с выданным. Проверь, что вставил его в настройках проверки и нажал сохранить.',
        );
      }

      return {
        externalId: account.puuid,
        displayName: `${account.gameName}#${account.tagLine}`,
        region: platform,
        verificationMethod: 'riot-third-party-code',
      };
    },

    async fetchProfile(puuid: string, region?: string): Promise<GameProfile> {
      const platform = requirePlatform(region);
      const account = await call<RiotAccount>(
        ENDPOINTS.accountByPuuid(platformToRegionalRoute(platform), puuid),
        riotAccountSchema,
      );
      return {
        externalId: account.puuid,
        displayName: `${account.gameName}#${account.tagLine}`,
        region: platform,
      };
    },

    async fetchRank(puuid: string, region?: string): Promise<RankInfo[]> {
      const platform = requirePlatform(region);
      const url =
        deps.game === 'lol' ? ENDPOINTS.lolEntries(platform, puuid) : ENDPOINTS.tftEntries(platform, puuid);

      const entries = await call(url, riotLeagueEntriesSchema);
      // Неизвестные очереди отбрасываются: Riot добавляет режимы чаще, чем мы обновляем код.
      return entries.map(normalizeRiotEntry).filter((rank): rank is RankInfo => rank !== null);
    },
  };
}
