import { describe, expect, it, vi } from 'vitest';
import { UserError } from '../../../../src/core/errors.js';
import type { FetchClient } from '../../../../src/core/http/fetch-client.js';
import type { RateLimiter } from '../../../../src/core/rate-limit.js';
import { createSteamProvider, steamId64ToAccountId } from '../../../../src/modules/identity/providers/steam.js';

const noopLimiter: RateLimiter = { acquire: async () => {}, close: async () => {} };

function clientReturning(payload: unknown): FetchClient {
  return { json: vi.fn(async () => payload) as FetchClient['json'] };
}

const playerSummary = {
  response: {
    players: [
      {
        steamid: '76561198000000001',
        personaname: 'ЧувакИзДоты',
        avatarfull: 'https://avatars.steamstatic.com/abc_full.jpg',
        communityvisibilitystate: 3,
      },
    ],
  },
};

describe('steamId64ToAccountId', () => {
  it('переводит SteamID64 в account_id для OpenDota', () => {
    expect(steamId64ToAccountId('76561197960265729')).toBe('1');
    expect(steamId64ToAccountId('76561198000000001')).toBe('39734273');
  });
});

describe('createSteamProvider', () => {
  it('объявляет верификацию через OpenID и ранг из API', () => {
    const provider = createSteamProvider({
      apiKey: 'k',
      publicBaseUrl: 'https://bot.example.com',
      client: clientReturning(playerSummary),
      openDotaClient: clientReturning({}),
      rateLimiter: noopLimiter,
    });

    expect(provider.id).toBe('steam');
    expect(provider.capabilities).toEqual({ verification: 'steam-openid', rank: 'api' });
  });

  it('отдаёт профиль с персоной и аватаром', async () => {
    const provider = createSteamProvider({
      apiKey: 'k',
      publicBaseUrl: 'https://bot.example.com',
      client: clientReturning(playerSummary),
      openDotaClient: clientReturning({}),
      rateLimiter: noopLimiter,
    });

    await expect(provider.fetchProfile('76561198000000001')).resolves.toEqual({
      externalId: '76561198000000001',
      displayName: 'ЧувакИзДоты',
      avatarUrl: 'https://avatars.steamstatic.com/abc_full.jpg',
    });
  });

  it('бросает UserError, когда Steam не знает такой аккаунт', async () => {
    const provider = createSteamProvider({
      apiKey: 'k',
      publicBaseUrl: 'https://bot.example.com',
      client: clientReturning({ response: { players: [] } }),
      openDotaClient: clientReturning({}),
      rateLimiter: noopLimiter,
    });

    await expect(provider.fetchProfile('76561198000000009')).rejects.toThrow(UserError);
  });

  it('бросает UserError без ключа Steam вместо падения', async () => {
    const provider = createSteamProvider({
      publicBaseUrl: 'https://bot.example.com',
      client: clientReturning(playerSummary),
      openDotaClient: clientReturning({}),
      rateLimiter: noopLimiter,
    });

    await expect(provider.fetchProfile('76561198000000001')).rejects.toThrow(/STEAM_API_KEY/);
  });

  it('отдаёт нормализованный ранг Dota', async () => {
    const provider = createSteamProvider({
      apiKey: 'k',
      publicBaseUrl: 'https://bot.example.com',
      client: clientReturning(playerSummary),
      openDotaClient: clientReturning({ rank_tier: 53, leaderboard_rank: null }),
      rateLimiter: noopLimiter,
    });

    const ranks = await provider.fetchRank!('76561198000000001');
    expect(ranks).toHaveLength(1);
    expect(ranks[0]).toMatchObject({ mode: 'dota-mmr', tier: 'LEGEND', division: '3' });
  });

  it('отдаёт пустой список, когда игрок в Dota не откалиброван', async () => {
    const provider = createSteamProvider({
      apiKey: 'k',
      publicBaseUrl: 'https://bot.example.com',
      client: clientReturning(playerSummary),
      openDotaClient: clientReturning({ rank_tier: null }),
      rateLimiter: noopLimiter,
    });

    await expect(provider.fetchRank!('76561198000000001')).resolves.toEqual([]);
  });

  it('берёт квоту перед каждым внешним вызовом', async () => {
    const acquire = vi.fn(async () => {});
    const provider = createSteamProvider({
      apiKey: 'k',
      publicBaseUrl: 'https://bot.example.com',
      client: clientReturning(playerSummary),
      openDotaClient: clientReturning({ rank_tier: 11 }),
      rateLimiter: { acquire, close: async () => {} },
    });

    await provider.fetchProfile('76561198000000001');
    await provider.fetchRank!('76561198000000001');

    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('выдаёт челлендж со ссылкой на вход Steam', async () => {
    const provider = createSteamProvider({
      apiKey: 'k',
      publicBaseUrl: 'https://bot.example.com',
      client: clientReturning(playerSummary),
      openDotaClient: clientReturning({}),
      rateLimiter: noopLimiter,
    });

    const challenge = await provider.startVerification!('222222222222222222');

    expect(challenge.instruction).toContain('https://steamcommunity.com/openid/login');
    expect(challenge.instruction).toContain(encodeURIComponent(challenge.challenge));
    expect(challenge.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
