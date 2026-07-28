import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/core/config.js';
import { createFetchClient } from '../../src/core/http/fetch-client.js';
import { createLogger } from '../../src/core/logger.js';
import { normalizeDotaRank } from '../../src/modules/identity/ranks/dota.js';
import { normalizeRiotEntry } from '../../src/modules/identity/ranks/riot.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

const steamKey = process.env['STEAM_API_KEY'];
const riotKey = process.env['RIOT_API_KEY'];

/** Публичные аккаунты для проверки формата. Заменить на любые живые с открытым профилем. */
const STEAM_ID = process.env['CONTRACT_STEAM_ID'] ?? '76561197960435530';
const RIOT_ID = process.env['CONTRACT_RIOT_ID'] ?? 'Faker#KR1';
const RIOT_PLATFORM = process.env['CONTRACT_RIOT_PLATFORM'] ?? 'kr';

describe.skipIf(!steamKey)('контракт Steam Web API', () => {
  it('отдаёт players с persona в GetPlayerSummaries', async () => {
    const client = createFetchClient({ provider: 'steam-contract', logger });
    const data = await client.json<{ response: { players: Array<{ steamid: string; personaname: string }> } }>(
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${steamKey}&steamids=${STEAM_ID}`,
    );

    expect(data.response.players[0]).toMatchObject({
      steamid: expect.any(String),
      personaname: expect.any(String),
    });
  });
});

describe('контракт OpenDota', () => {
  it('отдаёт rank_tier, который понимает наш нормализатор', async () => {
    const client = createFetchClient({ provider: 'opendota-contract', logger });
    const accountId = (BigInt(STEAM_ID) - 76561197960265728n).toString();
    const player = await client.json<{ rank_tier: number | null }>(
      `https://api.opendota.com/api/players/${accountId}`,
    );

    // Формат важнее значения: null допустим, а строка или объект — нет.
    expect(player.rank_tier === null || typeof player.rank_tier === 'number').toBe(true);
    if (typeof player.rank_tier === 'number') {
      expect(normalizeDotaRank(player)).not.toBeNull();
    }
  });
});

describe.skipIf(!riotKey)('контракт Riot API', () => {
  it('account-v1 отдаёт puuid по Riot ID', async () => {
    const client = createFetchClient({ provider: 'riot-contract', logger });
    const [gameName, tagLine] = RIOT_ID.split('#');
    const account = await client.json<{ puuid: string; gameName: string; tagLine: string }>(
      `https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName!)}/${encodeURIComponent(tagLine!)}`,
      { headers: { 'X-Riot-Token': riotKey! } },
    );

    expect(account.puuid).toBeTypeOf('string');
  });

  it('league-v4 by-puuid отдаёт записи, которые понимает наш нормализатор', async () => {
    const client = createFetchClient({ provider: 'riot-contract', logger });
    const [gameName, tagLine] = RIOT_ID.split('#');
    const account = await client.json<{ puuid: string }>(
      `https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName!)}/${encodeURIComponent(tagLine!)}`,
      { headers: { 'X-Riot-Token': riotKey! } },
    );

    const entries = await client.json<Array<{ queueType: string; tier: string; rank: string; leaguePoints: number }>>(
      `https://${RIOT_PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-puuid/${account.puuid}`,
      { headers: { 'X-Riot-Token': riotKey! } },
    );

    expect(Array.isArray(entries)).toBe(true);
    const ranked = entries.find((entry) => entry.queueType === 'RANKED_SOLO_5x5');
    if (ranked) {
      // Если это упало — Riot поменял тиры или очереди, и нормализатор надо обновить.
      expect(normalizeRiotEntry(ranked)).not.toBeNull();
    }
  });
});
