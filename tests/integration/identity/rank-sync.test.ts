import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { guilds } from '../../../src/core/db/schema/core.js';
import { EventBus } from '../../../src/core/events/bus.js';
import { ProviderError } from '../../../src/core/errors.js';
import { createLogger } from '../../../src/core/logger.js';
import type { GameProvider, RankInfo } from '../../../src/modules/identity/providers/provider.js';
import type { ProviderId } from '../../../src/modules/identity/schema.js';
import { createLinkingService } from '../../../src/modules/identity/services/linking.js';
import { createRankSyncService } from '../../../src/modules/identity/services/rank-sync.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

function rank(tier: string, division: string | null, mode = 'solo-duo'): RankInfo {
  return { mode, scale: 'riot-tier', tier, division, points: 10, source: 'api', raw: {} };
}

function providerReturning(ranks: RankInfo[] | Error): GameProvider {
  return {
    id: 'riot-lol',
    capabilities: { verification: 'riot-third-party-code', rank: 'api' },
    fetchProfile: async () => ({ externalId: 'PUUID-1', displayName: 'a#b' }),
    fetchRank: async () => {
      if (ranks instanceof Error) throw ranks;
      return ranks;
    },
  };
}

function servicesWith(provider: GameProvider) {
  const linking = createLinkingService({ db: pg.db });
  const bus = new EventBus(logger);
  const registry = new Map<ProviderId, GameProvider>([['riot-lol', provider]]);
  const sync = createRankSyncService({ db: pg.db, linking, providers: registry, bus, logger });
  return { linking, bus, sync };
}

const USER = '600000000000000001';

beforeAll(async () => {
  await pg.db.insert(guilds).values({ id: '111111111111111111' }).onConflictDoNothing();
});

async function linkedAccount(linking: ReturnType<typeof createLinkingService>, userId: string) {
  await linking.ensureUser(userId);
  const id = await linking.linkAccount(
    userId,
    'riot-lol',
    { externalId: `PUUID-${userId}`, displayName: 'a#b', region: 'euw1', verificationMethod: 'riot-third-party-code' },
    true,
  );
  const accounts = await linking.listAccounts(userId);
  return accounts.find((a) => a.id === id)!;
}

describe('RankSyncService', () => {
  it('сохраняет полученный ранг снимком', async () => {
    const { linking, sync } = servicesWith(providerReturning([rank('GOLD', 'II')]));
    const account = await linkedAccount(linking, USER);

    const result = await sync.syncAccount(account);

    expect(result).toHaveLength(1);
    const latest = await linking.latestRanks(account.id);
    expect(latest[0]).toMatchObject({ tier: 'GOLD', division: 'II' });
  });

  it('публикует rank.changed при первом ранге', async () => {
    const { linking, bus, sync } = servicesWith(providerReturning([rank('GOLD', 'II')]));
    const handler = vi.fn();
    bus.on('rank.changed', handler);
    const account = await linkedAccount(linking, '600000000000000002');

    await sync.syncAccount(account);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'riot-lol', mode: 'solo-duo', previous: null }),
    );
  });

  it('НЕ публикует rank.changed, когда ранг не изменился', async () => {
    const { linking, bus, sync } = servicesWith(providerReturning([rank('GOLD', 'II')]));
    const account = await linkedAccount(linking, '600000000000000003');
    await sync.syncAccount(account);

    const handler = vi.fn();
    bus.on('rank.changed', handler);
    await sync.syncAccount(account);

    expect(handler).not.toHaveBeenCalled();
  });

  it('публикует rank.changed при смене дивизиона', async () => {
    const linking = createLinkingService({ db: pg.db });
    const bus = new EventBus(logger);
    let current = rank('GOLD', 'III');
    const provider: GameProvider = {
      id: 'riot-lol',
      capabilities: { verification: 'riot-third-party-code', rank: 'api' },
      fetchProfile: async () => ({ externalId: 'x', displayName: 'x' }),
      fetchRank: async () => [current],
    };
    const sync = createRankSyncService({
      db: pg.db,
      linking,
      providers: new Map([['riot-lol', provider]]),
      bus,
      logger,
    });
    const account = await linkedAccount(linking, '600000000000000004');

    await sync.syncAccount(account);
    const handler = vi.fn();
    bus.on('rank.changed', handler);
    current = rank('GOLD', 'II');
    await sync.syncAccount(account);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ previous: { tier: 'GOLD', division: 'III' }, current: { tier: 'GOLD', division: 'II' } }),
    );
  });

  it('пропускает аккаунт провайдера с ручным рангом', async () => {
    const linking = createLinkingService({ db: pg.db });
    const fetchRank = vi.fn();
    const manual: GameProvider = {
      id: 'riot-valorant',
      capabilities: { verification: 'none', rank: 'manual' },
      fetchProfile: async () => ({ externalId: 'x', displayName: 'x' }),
    };
    const sync = createRankSyncService({
      db: pg.db,
      linking,
      providers: new Map([['riot-valorant', manual]]),
      bus: new EventBus(logger),
      logger,
    });
    await linking.ensureUser('600000000000000005');
    const id = await linking.linkAccount(
      '600000000000000005',
      'riot-valorant',
      { externalId: 'Игрок#EUW', displayName: 'Игрок#EUW', verificationMethod: 'manual' },
      false,
    );
    const account = (await linking.listAccounts('600000000000000005')).find((a) => a.id === id)!;

    await expect(sync.syncAccount(account)).resolves.toEqual([]);
    expect(fetchRank).not.toHaveBeenCalled();
  });

  it('не роняет пачку из-за одного упавшего аккаунта', async () => {
    const { linking, sync } = servicesWith(providerReturning(new Error('Riot лёг')));
    await linkedAccount(linking, '600000000000000006');

    const result = await sync.syncBatch(10);

    expect(result.failed).toBeGreaterThanOrEqual(1);
  });

  // Мутационная проверка 2 (требование задачи): если бы syncAccount ловила ProviderError
  // и возвращала [], вызывающий код (пачка, а в будущем — выдача ролей) не отличил бы
  // «провайдер упал» от «рангов действительно нет» — и роли за ранг снялись бы из-за
  // временного сбоя провайдера. syncAccount обязана пробрасывать ошибку наружу.
  it('пробрасывает ProviderError из syncAccount вместо пустого списка рангов', async () => {
    const providerError = new ProviderError('Riot API недоступен', 'riot-lol');
    const { linking, sync } = servicesWith(providerReturning(providerError));
    const account = await linkedAccount(linking, '600000000000000007');

    await expect(sync.syncAccount(account)).rejects.toBe(providerError);

    // И сохранённого «пустого» ранга тоже нет — сбой не оставил после себя снимок.
    const latest = await linking.latestRanks(account.id);
    expect(latest).toEqual([]);
  });

  it('берёт в пачку аккаунты с самым старым updatedAt и не больше лимита', async () => {
    const { linking, sync } = servicesWith(providerReturning([rank('SILVER', 'I')]));
    for (const suffix of ['11', '12', '13']) {
      await linkedAccount(linking, `6000000000000000${suffix}`);
    }

    const result = await sync.syncBatch(2);

    expect(result.synced + result.failed).toBe(2);
  });
});
