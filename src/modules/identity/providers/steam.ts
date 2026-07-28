import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { UserError } from '../../../core/errors.js';
import type { FetchClient } from '../../../core/http/fetch-client.js';
import type { Limit, RateLimiter } from '../../../core/rate-limit.js';
import { normalizeDotaRank, type OpenDotaPlayer } from '../ranks/dota.js';
import type {
  GameProfile,
  GameProvider,
  RankInfo,
  VerificationChallenge,
  VerifiedAccount,
} from './provider.js';
import { buildSteamLoginUrl } from './steam-openid.js';

const STEAM_API = 'https://api.steampowered.com';
const OPENDOTA_API = 'https://api.opendota.com/api';

/** Смещение между SteamID64 и account_id, который ждёт OpenDota (у account_id=0 SteamID64 равен этой базе). */
const STEAM_ID64_BASE = 76561197960265728n;

const VERIFICATION_TTL_MS = 15 * 60 * 1_000;

/** Лимиты консервативны намеренно: превышение стоит дороже лишней секунды ожидания. */
const STEAM_LIMITS: Limit[] = [{ tokens: 20, windowMs: 1_000 }];
const OPENDOTA_LIMITS: Limit[] = [
  { tokens: 50, windowMs: 60_000 },
  { tokens: 1_800, windowMs: 24 * 60 * 60 * 1_000 },
];

/** SteamID64 → account_id: то, что понимают OpenDota и сам клиент Dota 2. */
export function steamId64ToAccountId(steamId64: string): string {
  return (BigInt(steamId64) - STEAM_ID64_BASE).toString();
}

/**
 * Ответ ISteamUser/GetPlayerSummaries — только поля, которые реально разыменовываются
 * ниже. FetchClient сам вызывает schema.parse и оборачивает несовпадение в ProviderError
 * («неожиданный формат ответа: …») — без этого битое тело 200-го ответа дало бы
 * необработанный TypeError на `data.response.players[0]`, а не ProviderError, и circuit
 * breaker никогда не увидел бы такой сбой (провайдер, стабильно отдающий мусор с кодом
 * 200, никогда бы не разомкнул цепь). Схема нарочно не строже необходимого: Steam
 * регулярно добавляет в ответ новые поля, лишние zod просто отбрасывает.
 */
const steamPlayerSummariesSchema = z.object({
  response: z.object({
    players: z.array(
      z.object({
        steamid: z.string(),
        personaname: z.string(),
        avatarfull: z.string().optional(),
        communityvisibilitystate: z.number().optional(),
      }),
    ),
  }),
});

type PlayerSummariesResponse = z.infer<typeof steamPlayerSummariesSchema>;

/**
 * Ровно те поля OpenDotaPlayer (ranks/dota.ts), что использует normalizeDotaRank. Тело
 * `null` (валидный JSON, которым вполне может ответить страница ошибки OpenDota) схема
 * тоже отвергает: object() не проходит на null, а normalizeDotaRank(null) иначе бросил бы
 * необработанный TypeError на player.rank_tier.
 *
 * leaderboard_rank — через .default(null), а не .optional(): OpenDota присылает этот ключ,
 * только если игрок в топ-лидерборде, поэтому ключа в ответе обычно вовсе нет и его нужно
 * доливать значением по умолчанию. У чистого .optional() тип поля после парсинга — это
 * `number | null | undefined`, а exactOptionalPropertyTypes не даёт присвоить такое
 * значение в OpenDotaPlayer.leaderboard_rank (там `number | null` без undefined) без ручной
 * подгонки; .default(null) убирает undefined из типа результата, оставляя обычное
 * необязательное-но-всегда-заполненное поле `number | null` — оно совместимо с
 * OpenDotaPlayer без дополнительного кода.
 */
const openDotaPlayerSchema = z.object({
  rank_tier: z.number().nullable(),
  leaderboard_rank: z.number().nullable().default(null),
});

export interface SteamProviderDeps {
  apiKey?: string;
  /** Публичный адрес бота: нужен как realm и основа return_to при входе через Steam OpenID. */
  publicBaseUrl: string;
  client: FetchClient;
  openDotaClient: FetchClient;
  rateLimiter: RateLimiter;
}

export function createSteamProvider(deps: SteamProviderDeps): GameProvider {
  /** Без ключа обращаться в Steam Web API бессмысленно — это ошибка настройки окружения, а не пользователя. */
  function requireApiKey(): string {
    if (!deps.apiKey) {
      throw new UserError('Интеграция со Steam не настроена: в окружении нет STEAM_API_KEY.');
    }
    return deps.apiKey;
  }

  async function fetchProfile(steamId64: string): Promise<GameProfile> {
    const apiKey = requireApiKey();
    await deps.rateLimiter.acquire('steam', STEAM_LIMITS);

    const url = `${STEAM_API}/ISteamUser/GetPlayerSummaries/v0002/?key=${apiKey}&steamids=${steamId64}`;
    const data = await deps.client.json<PlayerSummariesResponse>(url, { schema: steamPlayerSummariesSchema });
    const player = data.response.players[0];

    if (!player) {
      throw new UserError('Steam не знает такой аккаунт. Проверь, что профиль существует и открыт.');
    }

    return {
      externalId: player.steamid,
      displayName: player.personaname,
      // avatarUrl нельзя присваивать явным undefined (exactOptionalPropertyTypes) — поле либо есть, либо его нет.
      ...(player.avatarfull ? { avatarUrl: player.avatarfull } : {}),
    };
  }

  async function fetchRank(steamId64: string): Promise<RankInfo[]> {
    // Ранг Dota не отдаёт ни Steam Web API, ни сам клиент игры — только OpenDota,
    // поэтому у него отдельная квота и отдельная база, никак не связанные со Steam-лимитами.
    await deps.rateLimiter.acquire('opendota', OPENDOTA_LIMITS);

    const accountId = steamId64ToAccountId(steamId64);
    const player = await deps.openDotaClient.json<OpenDotaPlayer>(`${OPENDOTA_API}/players/${accountId}`, {
      schema: openDotaPlayerSchema,
    });
    const rank = normalizeDotaRank(player);

    return rank ? [rank] : [];
  }

  async function startVerification(): Promise<VerificationChallenge> {
    // nonce уходит в return_to: по нему колбэк найдёт, какой именно челлендж завершать.
    const nonce = randomUUID();
    const returnTo = `${deps.publicBaseUrl}/steam/callback?state=${encodeURIComponent(nonce)}`;
    const loginUrl = buildSteamLoginUrl({ returnTo, realm: deps.publicBaseUrl });

    return {
      challenge: nonce,
      expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
      payload: { returnTo },
      instruction:
        `Открой ссылку и войди через Steam — она действует 15 минут:\n${loginUrl}\n\n` +
        'Пароль вводится на сайте Steam, бот его не видит.',
    };
  }

  async function completeVerification(
    _challenge: VerificationChallenge,
    steamId64: string,
  ): Promise<VerifiedAccount> {
    // Подпись возврата проверяет HTTP-роут колбэка (verifySteamAssertion из Task 7)
    // ещё до вызова этого метода — сюда приходит уже доверенный SteamID64.
    const profile = await fetchProfile(steamId64);
    return {
      externalId: profile.externalId,
      displayName: profile.displayName,
      verificationMethod: 'steam-openid',
    };
  }

  return {
    id: 'steam',
    capabilities: { verification: 'steam-openid', rank: 'api' },
    startVerification,
    completeVerification,
    fetchProfile,
    fetchRank,
  };
}
