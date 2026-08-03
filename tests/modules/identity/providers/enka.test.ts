import { describe, expect, it, vi } from 'vitest';
import { UserError } from '../../../../src/core/errors.js';
import type { FetchClient } from '../../../../src/core/http/fetch-client.js';
import type { RateLimiter } from '../../../../src/core/rate-limit.js';
import { createEnkaProvider } from '../../../../src/modules/identity/providers/enka.js';
import type { VerificationChallenge } from '../../../../src/modules/identity/providers/provider.js';

const rateLimiter: RateLimiter = {
  async acquire(): Promise<void> {},
  async close(): Promise<void> {},
};

function providerWith(playerInfo: Record<string, unknown>): {
  provider: ReturnType<typeof createEnkaProvider>;
  json: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn(async () => ({ uid: '700000001', playerInfo }));
  const client = { json } as unknown as FetchClient;
  return { provider: createEnkaProvider({ client, rateLimiter }), json };
}

function challengeOf(code: string): VerificationChallenge {
  return { challenge: code, expiresAt: new Date(Date.now() + 60_000), payload: {} };
}

describe('провайдер Genshin через Enka', () => {
  it('объявляет и подтверждение, и ранг из API — оба у него есть', () => {
    const { provider } = providerWith({});
    expect(provider.capabilities).toEqual({ verification: 'genshin-signature', rank: 'api' });
  });

  /**
   * UID проверяется до запроса. Иначе опечатка стоила бы обращения к чужому бесплатному API
   * и возвращалась бы как «игрок не найден» — а это неправда, такого игрока и не бывает.
   */
  it('непохожий на UID ввод не доходит до сети', async () => {
    const { provider, json } = providerWith({});

    await expect(provider.fetchProfile('Игрок#EUW')).rejects.toThrow(UserError);
    await expect(provider.fetchProfile('12345')).rejects.toThrow(UserError);
    expect(json).not.toHaveBeenCalled();
  });

  it('код в подписи подтверждает владение', async () => {
    const { provider } = providerWith({ nickname: 'Странник', signature: 'играю с 2020 · KJ4X7A' });

    const verified = await provider.completeVerification?.(challengeOf('KJ4X7A'), '700000001');

    expect(verified).toEqual({
      externalId: '700000001',
      displayName: 'Странник',
      verificationMethod: 'genshin-signature',
    });
  });

  /** Стирать свою подпись ради проверки никого заставлять не нужно: код ищется внутри. */
  it('код засчитывается и в середине подписи, и в другом регистре', async () => {
    const { provider } = providerWith({ nickname: 'Странник', signature: 'до kj4x7a после' });

    await expect(provider.completeVerification?.(challengeOf('KJ4X7A'), '700000001')).resolves.toMatchObject({
      externalId: '700000001',
    });
  });

  it('без кода в подписи владение не подтверждается', async () => {
    const { provider } = providerWith({ nickname: 'Странник', signature: 'просто подпись' });

    await expect(provider.completeVerification?.(challengeOf('KJ4X7A'), '700000001')).rejects.toThrow(UserError);
  });

  it('пустая подпись не подтверждает ничего', async () => {
    const { provider } = providerWith({ nickname: 'Странник' });

    await expect(provider.completeVerification?.(challengeOf('KJ4X7A'), '700000001')).rejects.toThrow(UserError);
  });

  it('выдаёт код, который можно вписать в игре: без похожих символов и на четверть часа', async () => {
    const { provider } = providerWith({});
    const challenge = await provider.startVerification?.('user-1');

    expect(challenge?.challenge).toMatch(/^[ACDEFGHJKLMNPQRTUVWXY34679]{6}$/);
    expect(challenge?.instruction).toContain(challenge?.challenge ?? '');
    const minutes = ((challenge?.expiresAt.getTime() ?? 0) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
  });

  it('ранг — это прогресс Бездны', async () => {
    const { provider } = providerWith({ nickname: 'Странник', towerFloorIndex: 12, towerLevelIndex: 3 });

    const ranks = await provider.fetchRank?.('700000001');

    expect(ranks).toHaveLength(1);
    expect(ranks?.[0]).toMatchObject({ scale: 'genshin-abyss', tier: '12', division: '3' });
  });

  it('не пройденная Бездна — пустой список, а не ошибка', async () => {
    const { provider } = providerWith({ nickname: 'Новичок' });

    await expect(provider.fetchRank?.('700000001')).resolves.toEqual([]);
  });

  /** У совсем новых аккаунтов ник в витрине пустует. Прочерк там был бы хуже UID. */
  it('без ника показывается UID', async () => {
    const { provider } = providerWith({ nickname: '   ' });

    await expect(provider.fetchProfile('700000001')).resolves.toEqual({
      externalId: '700000001',
      displayName: 'UID 700000001',
    });
  });

  it('представляется Enka в User-Agent: она просит это прямо', async () => {
    const { provider, json } = providerWith({ nickname: 'Странник' });

    await provider.fetchProfile('700000001');

    const init = json.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(init?.headers?.['User-Agent']).toContain('dis-bot');
  });
});
