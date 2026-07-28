import { describe, expect, it, vi } from 'vitest';
import { ProviderError, UserError } from '../../../../src/core/errors.js';
import type { FetchClient } from '../../../../src/core/http/fetch-client.js';
import type { RateLimiter } from '../../../../src/core/rate-limit.js';
import {
  createRiotProvider,
  parseRiotId,
  platformToRegionalRoute,
} from '../../../../src/modules/identity/providers/riot.js';

const noopLimiter: RateLimiter = { acquire: async () => {}, close: async () => {} };

function clientSequence(...payloads: unknown[]): FetchClient {
  const json = vi.fn();
  for (const payload of payloads) json.mockResolvedValueOnce(payload);
  return { json: json as FetchClient['json'] };
}

/**
 * В отличие от clientSequence (голый мок без схемы), этот фейк воспроизводит ту часть
 * поведения настоящего FetchClient, которая важна для проверки «долга Task 2»: если
 * вызову передана schema, он реально гоняет через неё payload и превращает несовпадение
 * в ProviderError — ровно так, как это делает createFetchClient. Нужен, чтобы отличить
 * «схема передана и работает» от «схема просто присутствует в коде, но ничего не проверяет».
 */
function clientWithRawPayload(payload: unknown): FetchClient {
  return {
    json: (async (_url: string, init?: RequestInit & { schema?: { parse(input: unknown): unknown } }) => {
      if (init?.schema) {
        try {
          return init.schema.parse(payload);
        } catch (error) {
          throw new ProviderError(`неожиданный формат ответа: ${(error as Error).message}`, 'riot-lol', error);
        }
      }
      return payload;
    }) as FetchClient['json'],
  };
}

const account = { puuid: 'PUUID-1', gameName: 'Игрок', tagLine: 'EUW' };

describe('parseRiotId', () => {
  it('разбирает Riot ID с решёткой', () => {
    expect(parseRiotId('Игрок#EUW')).toEqual({ gameName: 'Игрок', tagLine: 'EUW' });
  });

  it('обрезает пробелы вокруг частей', () => {
    expect(parseRiotId('  Игрок  #  EUW ')).toEqual({ gameName: 'Игрок', tagLine: 'EUW' });
  });

  it('возвращает null без решётки или с пустой частью', () => {
    expect(parseRiotId('Игрок')).toBeNull();
    expect(parseRiotId('#EUW')).toBeNull();
    expect(parseRiotId('Игрок#')).toBeNull();
  });
});

describe('platformToRegionalRoute', () => {
  it('сопоставляет платформы регионам', () => {
    expect(platformToRegionalRoute('euw1')).toBe('europe');
    expect(platformToRegionalRoute('ru')).toBe('europe');
    expect(platformToRegionalRoute('na1')).toBe('americas');
    expect(platformToRegionalRoute('kr')).toBe('asia');
  });

  it('падает на неизвестной платформе, а не угадывает регион', () => {
    expect(() => platformToRegionalRoute('марс1')).toThrow(/марс1/);
  });
});

describe('createRiotProvider', () => {
  it('объявляет верификацию через third-party-code и ранг из API', () => {
    const provider = createRiotProvider({ game: 'lol', apiKey: 'k', client: clientSequence(), rateLimiter: noopLimiter });
    expect(provider.id).toBe('riot-lol');
    expect(provider.capabilities).toEqual({ verification: 'riot-third-party-code', rank: 'api' });
  });

  it('использует id riot-tft для TFT', () => {
    const provider = createRiotProvider({ game: 'tft', apiKey: 'k', client: clientSequence(), rateLimiter: noopLimiter });
    expect(provider.id).toBe('riot-tft');
  });

  it('бросает UserError без ключа Riot вместо падения', async () => {
    const provider = createRiotProvider({ game: 'lol', client: clientSequence(), rateLimiter: noopLimiter });
    await expect(provider.fetchProfile('PUUID-1', 'euw1')).rejects.toThrow(/RIOT_API_KEY/);
  });

  it('отдаёт профиль как gameName#tagLine', async () => {
    const provider = createRiotProvider({
      game: 'lol',
      apiKey: 'k',
      client: clientSequence(account),
      rateLimiter: noopLimiter,
    });

    await expect(provider.fetchProfile('PUUID-1', 'euw1')).resolves.toEqual({
      externalId: 'PUUID-1',
      displayName: 'Игрок#EUW',
      region: 'euw1',
    });
  });

  it('нормализует обе очереди LoL', async () => {
    const provider = createRiotProvider({
      game: 'lol',
      apiKey: 'k',
      client: clientSequence([
        { queueType: 'RANKED_SOLO_5x5', tier: 'EMERALD', rank: 'II', leaguePoints: 33 },
        { queueType: 'RANKED_FLEX_SR', tier: 'GOLD', rank: 'I', leaguePoints: 78 },
      ]),
      rateLimiter: noopLimiter,
    });

    const ranks = await provider.fetchRank!('PUUID-1', 'euw1');
    expect(ranks.map((r) => r.mode).sort()).toEqual(['flex', 'solo-duo']);
  });

  it('отбрасывает записи неизвестных очередей, а не падает', async () => {
    const provider = createRiotProvider({
      game: 'lol',
      apiKey: 'k',
      client: clientSequence([
        { queueType: 'CHERRY', tier: 'GOLD', rank: 'I', leaguePoints: 0 },
        { queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'I', leaguePoints: 10 },
      ]),
      rateLimiter: noopLimiter,
    });

    await expect(provider.fetchRank!('PUUID-1', 'euw1')).resolves.toHaveLength(1);
  });

  it('отдаёт пустой список для неоткалиброванного игрока', async () => {
    const provider = createRiotProvider({
      game: 'lol',
      apiKey: 'k',
      client: clientSequence([]),
      rateLimiter: noopLimiter,
    });

    await expect(provider.fetchRank!('PUUID-1', 'euw1')).resolves.toEqual([]);
  });

  it('требует регион для запроса ранга', async () => {
    const provider = createRiotProvider({
      game: 'lol',
      apiKey: 'k',
      client: clientSequence([]),
      rateLimiter: noopLimiter,
    });

    await expect(provider.fetchRank!('PUUID-1')).rejects.toThrow(/регион/);
  });

  it('выдаёт челлендж с кодом для вставки в клиент', async () => {
    const provider = createRiotProvider({
      game: 'lol',
      apiKey: 'k',
      client: clientSequence(),
      rateLimiter: noopLimiter,
    });

    const challenge = await provider.startVerification!('222222222222222222');
    expect(challenge.challenge).toMatch(/^[A-Z0-9]{8}$/);
    expect(challenge.instruction).toContain(challenge.challenge);
  });

  it('подтверждает владение, когда код в клиенте совпал', async () => {
    const provider = createRiotProvider({
      game: 'lol',
      apiKey: 'k',
      client: clientSequence(account, 'КОД1234', account),
      rateLimiter: noopLimiter,
    });

    const result = await provider.completeVerification!(
      { challenge: 'КОД1234', expiresAt: new Date(Date.now() + 60_000), payload: { platform: 'euw1' } },
      'Игрок#EUW',
    );

    expect(result).toMatchObject({ externalId: 'PUUID-1', verificationMethod: 'riot-third-party-code' });
  });

  it('отказывает, когда код в клиенте не совпал', async () => {
    const provider = createRiotProvider({
      game: 'lol',
      apiKey: 'k',
      client: clientSequence(account, 'ДРУГОЙКОД'),
      rateLimiter: noopLimiter,
    });

    await expect(
      provider.completeVerification!(
        { challenge: 'КОД1234', expiresAt: new Date(Date.now() + 60_000), payload: { platform: 'euw1' } },
        'Игрок#EUW',
      ),
    ).rejects.toThrow(UserError);
  });

  it('бросает ProviderError, а не TypeError, на неожиданной форме ответа ранга', async () => {
    // Долг из Task 2: normalizeRiotEntry не валидирует форму входа сама и на битом JSON
    // бросит TypeError. Эту работу должна делать schema, переданная в client.json —
    // FetchClient сам вызывает schema.parse и оборачивает несовпадение в ProviderError.
    // queueType настоящий (иначе normalizeRiotEntry тихо вернёт null раньше, чем дойдёт
    // до tier), а tier: 42 (число вместо строки) — именно то, на чём падает
    // entry.tier.toUpperCase() внутри normalizeRiotEntry.
    const provider = createRiotProvider({
      game: 'lol',
      apiKey: 'k',
      client: clientWithRawPayload([{ queueType: 'RANKED_SOLO_5x5', tier: 42, rank: 'I', leaguePoints: 10 }]),
      rateLimiter: noopLimiter,
    });

    await expect(provider.fetchRank!('PUUID-1', 'euw1')).rejects.toThrow(ProviderError);
  });
});
