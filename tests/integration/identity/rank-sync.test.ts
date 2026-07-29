import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Cache } from '../../../src/core/cache.js';
import type { Config } from '../../../src/core/config.js';
import { guilds } from '../../../src/core/db/schema/core.js';
import { EventBus } from '../../../src/core/events/bus.js';
import { ProviderError } from '../../../src/core/errors.js';
import { createLogger } from '../../../src/core/logger.js';
import type { GameProvider, RankInfo } from '../../../src/modules/identity/providers/provider.js';
import { withCache } from '../../../src/modules/identity/providers/with-cache.js';
import { gameAccounts, type ProviderId } from '../../../src/modules/identity/schema.js';
import { createLinkingService } from '../../../src/modules/identity/services/linking.js';
import { createRankSyncService } from '../../../src/modules/identity/services/rank-sync.js';
import { withPostgres } from '../../helpers/postgres.js';
import { withRedis } from '../../helpers/redis.js';

const pg = withPostgres();
const redis = withRedis();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

/** Настоящий Cache на живом тестовом Redis — нужен, чтобы тест на проброс сбоя мог
 * взять провайдера, обёрнутого настоящим withCache, а не сымитировать SWR вручную. */
function makeRealCache(): Cache {
  const config = { REDIS_URL: redis.url, LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config;
  return new Cache(config, createLogger(config));
}

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

  // Регресс (раунд исправлений 1): ранний выход syncAccount для аккаунта без fetchRank
  // (ручной ранг или провайдер не в реестре) не двигал updatedAt — такой аккаунт навсегда
  // оставался в голове очереди syncBatch и монополизировал каждую следующую пачку, тихо
  // не пуская к синхронизации остальные аккаунты (synced рос, failed — нет, ошибки в
  // логе тоже нет). Тест ловит именно голодание очереди, а не сам факт обновления поля:
  // проверяем, что ВТОРОЙ вызов syncBatch(1) берёт другой аккаунт, а не тот же самый.
  it('не морит очередь голодом: аккаунт без fetchRank не занимает пачку навсегда', async () => {
    const manual: GameProvider = {
      id: 'riot-valorant',
      capabilities: { verification: 'none', rank: 'manual' },
      fetchProfile: async () => ({ externalId: 'x', displayName: 'x' }),
    };
    const fetchRankSpy = vi.fn(async () => [rank('SILVER', 'I')]);
    const apiProvider: GameProvider = {
      id: 'riot-lol',
      capabilities: { verification: 'riot-third-party-code', rank: 'api' },
      fetchProfile: async () => ({ externalId: 'x', displayName: 'x' }),
      fetchRank: fetchRankSpy,
    };

    const linking = createLinkingService({ db: pg.db });
    const sync = createRankSyncService({
      db: pg.db,
      linking,
      providers: new Map([
        ['riot-valorant', manual],
        ['riot-lol', apiProvider],
      ]),
      bus: new EventBus(logger),
      logger,
    });

    await linking.ensureUser('600000000000000030');
    const manualId = await linking.linkAccount(
      '600000000000000030',
      'riot-valorant',
      { externalId: 'Manual#EUW', displayName: 'Manual#EUW', verificationMethod: 'manual' },
      false,
    );

    await linking.ensureUser('600000000000000031');
    const apiId = await linking.linkAccount(
      '600000000000000031',
      'riot-lol',
      { externalId: 'PUUID-31', displayName: 'a#b', region: 'euw1', verificationMethod: 'riot-third-party-code' },
      true,
    );

    // Форсируем порядок очереди явными метками времени: ручной аккаунт заведомо
    // старше API-аккаунта, чтобы первая пачка гарантированно взяла именно его.
    await pg.db
      .update(gameAccounts)
      .set({ updatedAt: new Date(Date.now() - 120_000) })
      .where(eq(gameAccounts.id, manualId));
    await pg.db
      .update(gameAccounts)
      .set({ updatedAt: new Date(Date.now() - 60_000) })
      .where(eq(gameAccounts.id, apiId));

    const first = await sync.syncBatch(1);
    expect(first.synced + first.failed).toBe(1);
    // Первая пачка обязана взять именно ручной аккаунт (он старше) — fetchRank ещё не звали.
    expect(fetchRankSpy).not.toHaveBeenCalled();

    const second = await sync.syncBatch(1);
    expect(second.synced + second.failed).toBe(1);
    // Если бы updatedAt ручного аккаунта не сдвинулся на первом вызове, вторая пачка
    // снова взяла бы его же — и fetchRank так и не был бы вызван ни разу.
    expect(fetchRankSpy).toHaveBeenCalledTimes(1);
  });

  it('берёт в пачку аккаунты с самым старым updatedAt и не больше лимита', async () => {
    const { linking, sync } = servicesWith(providerReturning([rank('SILVER', 'I')]));
    for (const suffix of ['11', '12', '13']) {
      await linkedAccount(linking, `6000000000000000${suffix}`);
    }

    const result = await sync.syncBatch(2);

    expect(result.synced + result.failed).toBe(2);
  });

  // Находка 3 итогового ревью: пустой список от провайдера — это штатное «ранга
  // больше нет» (сброс сезона, деранк ниже отслеживаемого порога, приватный профиль),
  // а не повод молчать. Без явного снимка tier: null latestRanks вечно возвращал бы
  // последний ненулевой ранг, и applyRoles никогда не увидел бы повода снять роль.
  describe('утрата ранга: успешный пустой ответ записывает снимок с tier: null', () => {
    it('провайдер успешно вернул пустой список для мода, где раньше был ранг → записывает снимок с tier: null и публикует rank.changed', async () => {
      const responses: RankInfo[][] = [[rank('DIAMOND', 'II')], []];
      let call = 0;
      const provider: GameProvider = {
        id: 'riot-lol',
        capabilities: { verification: 'riot-third-party-code', rank: 'api' },
        fetchProfile: async () => ({ externalId: 'x', displayName: 'x' }),
        fetchRank: async () => responses[call++] ?? [],
      };
      const { linking, bus, sync } = servicesWith(provider);
      const account = await linkedAccount(linking, '600000000000000040');

      await sync.syncAccount(account); // первый прогон: Diamond записан

      const handler = vi.fn();
      bus.on('rank.changed', handler);
      const result = await sync.syncAccount(account); // второй прогон: успех, но пусто

      expect(result).toEqual([]);
      const latest = await linking.latestRanks(account.id);
      expect(latest).toHaveLength(1);
      expect(latest[0]).toMatchObject({ mode: 'solo-duo', tier: null, division: null });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'riot-lol',
          mode: 'solo-duo',
          previous: { tier: 'DIAMOND', division: 'II' },
          current: { tier: null, division: null },
        }),
      );
    });

    it('не пишет повторный снимок и не публикует событие, если ранга и так уже не было (идемпотентность)', async () => {
      const responses: RankInfo[][] = [[rank('DIAMOND', 'II')], [], []];
      let call = 0;
      const provider: GameProvider = {
        id: 'riot-lol',
        capabilities: { verification: 'riot-third-party-code', rank: 'api' },
        fetchProfile: async () => ({ externalId: 'x', displayName: 'x' }),
        fetchRank: async () => responses[call++] ?? [],
      };
      const { linking, bus, sync } = servicesWith(provider);
      const account = await linkedAccount(linking, '600000000000000041');

      await sync.syncAccount(account); // Diamond
      await sync.syncAccount(account); // -> tier: null, снимок записан, событие опубликовано
      const afterFirstLoss = await linking.latestRanks(account.id);

      const handler = vi.fn();
      bus.on('rank.changed', handler);
      await sync.syncAccount(account); // снова пусто: снимок и так уже tier: null

      expect(handler).not.toHaveBeenCalled();
      const afterSecondLoss = await linking.latestRanks(account.id);
      expect(afterSecondLoss).toEqual(afterFirstLoss);
    });

    // Парная проверка к находке 1: сбой отличается от честного пустого ответа и не
    // должен запускать эту ветку вовсе — иначе временный сбой Riot снимал бы роли
    // ровно так же, как описано в находке 1 (её и чинит этот файл отдельно).
    it('сбой провайдера НЕ создаёт снимок с пустым тиром и не трогает предыдущий ранг', async () => {
      let mode: 'ok' | 'fail' = 'ok';
      const provider: GameProvider = {
        id: 'riot-lol',
        capabilities: { verification: 'riot-third-party-code', rank: 'api' },
        fetchProfile: async () => ({ externalId: 'x', displayName: 'x' }),
        fetchRank: async () => {
          if (mode === 'fail') throw new ProviderError('Riot API недоступен', 'riot-lol');
          return [rank('DIAMOND', 'II')];
        },
      };
      const { linking, bus, sync } = servicesWith(provider);
      const account = await linkedAccount(linking, '600000000000000042');

      await sync.syncAccount(account); // Diamond записан

      mode = 'fail';
      const handler = vi.fn();
      bus.on('rank.changed', handler);
      await expect(sync.syncAccount(account)).rejects.toThrow('Riot API недоступен');

      expect(handler).not.toHaveBeenCalled();
      const latest = await linking.latestRanks(account.id);
      expect(latest).toHaveLength(1);
      expect(latest[0]).toMatchObject({ tier: 'DIAMOND', division: 'II' });
    });
  });

  // Находки 1 и 2 итогового ревью, и их ключевой тест: раньше инвариант «syncAccount
  // при сбое провайдера пробрасывает ошибку» проверялся на голом объекте-провайдере,
  // а в проде createIdentityModule всегда оборачивал провайдеры withCache — Cache.swr
  // при сбое загрузчика отдаёт просроченное значение вместо ошибки, если в кэше уже
  // есть непросроченная копия. Тест на голой заглушке этот класс дефекта в принципе
  // не мог заметить: обмануть его больше нельзя — ниже настоящий withCache и настоящий
  // Cache на живом Redis, а не голая заглушка.
  //
  // Сценарий воспроизводит ровно то, что описано в находке 1: где-то (в проде — это
  // командный, кэширующий реестр providers, который читает /link) провайдер уже был
  // успешно опрошен и Redis хранит свежий ответ. Синхронизация обязана получать RAW
  // (необёрнутый) провайдер — и тогда сбой виден ей всегда, независимо от того, что
  // лежит в кэше по соседству. Если бы синхронизации по ошибке отдали ТОТ ЖЕ обёрнутый
  // провайдер, второй вызов получил бы просроченное (а на самом деле — ещё свежее,
  // «горячее») значение из Redis вместо ошибки, и не заметил бы сбоя вовсе.
  it('пробрасывает сбой даже когда провайдер того же id уже обёрнут кэшем в Redis (инвариант держится не только на голой заглушке)', async () => {
    const cache = makeRealCache();
    let mode: 'ok' | 'fail' = 'ok';
    const rawProvider: GameProvider = {
      id: 'riot-lol',
      capabilities: { verification: 'riot-third-party-code', rank: 'api' },
      fetchProfile: async () => ({ externalId: 'X-CACHE-INVARIANT', displayName: 'a#b' }),
      fetchRank: async () => {
        if (mode === 'fail') throw new ProviderError('Riot API недоступен', 'riot-lol');
        return [rank('DIAMOND', 'II')];
      },
    };
    // Обёрнутая версия ТОГО ЖЕ провайдера (тот же id → тот же ключ кэша) — симулирует
    // командный реестр, который в проде читает через withCache. Дёргаем её один раз
    // успешно, чтобы в Redis реально появилась «горячая» запись — совсем как если бы
    // игрок перед этим воспользовался /link или /profile.
    const wrapped = withCache(rawProvider, cache);
    await wrapped.fetchRank!('X-CACHE-INVARIANT', 'euw1');

    mode = 'fail';

    // Синхронизация получает RAW-провайдер напрямую (как и требуют находки 1/2) —
    // соседняя «горячая» запись в Redis для того же id её не касается вовсе.
    const { linking, sync } = servicesWith(rawProvider);
    const account = await linkedAccount(linking, '600000000000000050');

    await expect(sync.syncAccount(account)).rejects.toThrow('Riot API недоступен');
    // И «пустого» снимка сбой тоже не оставляет — см. находку 3 выше.
    expect(await linking.latestRanks(account.id)).toEqual([]);

    await cache.close();
  });
});
