import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { Cache } from '../../../src/core/cache.js';
import type { Config } from '../../../src/core/config.js';
import { guilds } from '../../../src/core/db/schema/core.js';
import { EventBus } from '../../../src/core/events/bus.js';
import { ProviderError } from '../../../src/core/errors.js';
import type { FetchClient } from '../../../src/core/http/fetch-client.js';
import { createLogger } from '../../../src/core/logger.js';
import type { ModuleContext } from '../../../src/core/module.js';
import { buildRegistry } from '../../../src/core/registry.js';
import { createIdentityModule } from '../../../src/modules/identity/index.js';
import { gameAccounts } from '../../../src/modules/identity/schema.js';
import { createLinkingService } from '../../../src/modules/identity/services/linking.js';
import { createRoleMappingService } from '../../../src/modules/identity/services/role-mapping.js';
import { withPostgres } from '../../helpers/postgres.js';
import { withRedis } from '../../helpers/redis.js';

const pg = withPostgres();
const redis = withRedis();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

function moduleWith() {
  const bus = new EventBus(logger);
  const module = createIdentityModule({
    db: pg.db,
    bus,
    logger,
    config: {
      PUBLIC_BASE_URL: 'https://bot.example.com',
      REDIS_URL: 'redis://localhost:6379',
    } as Config,
    cooldown: { hit: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })), close: vi.fn(async () => {}) },
    rateLimiter: { acquire: vi.fn(async () => {}), close: vi.fn(async () => {}) },
    // Тесты этого файла не дёргают providers registry (fetchProfile/fetchRank) —
    // только имя модуля, список команд, cron джобы и обработчик rank.changed,
    // который читает linking/roles, а не providers. Поэтому cache.swr здесь
    // никогда не вызывается, и пустая заглушка безопасна.
    cache: {} as unknown as Cache,
    fetchClientFor: () => ({ json: vi.fn() }),
    fetchMember: vi.fn(async () => null),
  });
  return { module, bus };
}

describe('модуль identity', () => {
  it('называется identity', () => {
    expect(moduleWith().module.name).toBe('identity');
  });

  it('объявляет все пять команд', () => {
    const names = moduleWith().module.commands?.map((c) => c.builder.name).sort();
    expect(names).toEqual(['link', 'profile', 'ranksync', 'rolemap', 'unlink']);
  });

  it('регистрируется в реестре ядра без конфликтов имён', () => {
    const registry = buildRegistry([moduleWith().module]);
    expect(registry.commands.size).toBe(5);
  });

  it('объявляет джобу синхронизации на каждые 30 минут', () => {
    const jobs = moduleWith().module.jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs?.[0]?.name).toBe('identity:rank-sync');
    expect(jobs?.[0]?.cron).toBe('*/30 * * * *');
  });

  it('подписывается на rank.changed при setup', async () => {
    const { module, bus } = moduleWith();
    await module.setup?.({ logger } as unknown as ModuleContext);

    // Событие обрабатывается без исключения даже когда участника не удалось найти.
    await expect(
      bus.emit('rank.changed', {
        userId: '222222222222222222',
        provider: 'riot-lol',
        mode: 'solo-duo',
        previous: null,
        current: { tier: 'GOLD', division: 'II' },
      }),
    ).resolves.toBeUndefined();
  });

  it('закрывает свои соединения при teardown', async () => {
    const { module } = moduleWith();
    await expect(module.teardown?.()).resolves.toBeUndefined();
  });
});

/**
 * Долг с Task 1, закрываемый именно здесь (см. progress.md, разбор Task 12,
 * «Решение контроллера 2»): «verified_at IS NULL → авто-роль не выдаётся».
 * role-mapping.ts проверить это не может — он принимает уже готовый
 * `ranks: RankInfo[]`, признака подтверждённости в нём нет. Реальная проверка
 * живёт только в обработчике rank.changed ниже (`if (!account?.verifiedAt) continue`
 * до вызова roles.applyRoles).
 *
 * Тест выше «подписывается на rank.changed при setup» до этой ветки не доходит:
 * там `ctx` — это `{ logger }`, то есть `ctx.client` не задан, и цикл
 * `for (const guildId of ctx.client.guilds.cache.keys())` бросает исключение,
 * даже не добравшись до вызова fetchMember. EventBus.emit гасит это исключение
 * через Promise.allSettled (и только логирует), поэтому тест остаётся зелёным,
 * ничего не проверив по существу веток внутри обработчика. Без теста ниже это
 * оставалось бы единственным местом в проекте, где данное поведение вообще
 * могло бы быть проверено — и осталось бы непроверенным.
 *
 * Поэтому здесь — сквозной тест на настоящем обработчике: fetchMember возвращает
 * настоящую заглушку участника (не null, как в тесте выше), а подтверждённость
 * проверяется на настоящей записи game_accounts (withPostgres, как и везде в
 * этом этапе). Второй (парный) тест обязателен: без него первый прошёл бы и на
 * коде, который вообще никогда не выдаёт роль.
 */
describe('обработчик rank.changed уважает verified_at (закрытие долга Task 1/12)', () => {
  const RANK_GUILD = '555555555555555555';
  const RANK_USER = '666666666666666666';
  const RANK_ROLE = '700000000000000001';

  let accountId: number;

  beforeAll(async () => {
    await pg.db.insert(guilds).values({ id: RANK_GUILD }).onConflictDoNothing();

    const linking = createLinkingService({ db: pg.db });
    const roles = createRoleMappingService({ db: pg.db, logger });

    await linking.ensureUser(RANK_USER);
    accountId = await linking.linkAccount(
      RANK_USER,
      'riot-lol',
      { externalId: `PUUID-${RANK_USER}`, displayName: 'долг#EUW', region: 'euw1', verificationMethod: 'manual' },
      // Аккаунт заведомо не подтверждён — это и есть проверяемое условие.
      false,
    );
    await linking.saveRank(accountId, {
      mode: 'solo-duo',
      scale: 'riot-tier',
      tier: 'GOLD',
      division: 'II',
      points: 10,
      source: 'api',
      raw: {},
    });
    await roles.setMapping(RANK_GUILD, 'riot-lol', 'solo-duo', 'GOLD', RANK_ROLE);
  });

  /** Настоящая заглушка участника (не null) — обработчик должен дойти до проверки verifiedAt. */
  function fakeMember() {
    const add = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    const member = {
      id: RANK_USER,
      roles: { cache: new Map<string, unknown>(), add, remove },
    } as unknown as GuildMember;
    return { member, add, remove };
  }

  function moduleForHandler(member: GuildMember) {
    const bus = new EventBus(logger);
    const module = createIdentityModule({
      db: pg.db,
      bus,
      logger,
      config: {
        PUBLIC_BASE_URL: 'https://bot.example.com',
        REDIS_URL: 'redis://localhost:6379',
      } as Config,
      cooldown: { hit: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })), close: vi.fn(async () => {}) },
      rateLimiter: { acquire: vi.fn(async () => {}), close: vi.fn(async () => {}) },
      // См. пояснение в moduleWith() выше — providers registry здесь не используется.
      cache: {} as unknown as Cache,
      fetchClientFor: () => ({ json: vi.fn() }),
      fetchMember: vi.fn(async () => member),
    });
    // Обработчику от client нужен только перебор гильдий — этого достаточно.
    const ctx = {
      client: { guilds: { cache: new Map([[RANK_GUILD, {}]]) } },
      logger,
    } as unknown as ModuleContext;
    return { module, bus, ctx };
  }

  async function emitRankChanged(bus: EventBus): Promise<void> {
    await bus.emit('rank.changed', {
      userId: RANK_USER,
      provider: 'riot-lol',
      mode: 'solo-duo',
      previous: null,
      current: { tier: 'GOLD', division: 'II' },
    });
  }

  it('не выдаёт роль по рангу, пока аккаунт не подтверждён (verified_at IS NULL)', async () => {
    const stub = fakeMember();
    const { module, bus, ctx } = moduleForHandler(stub.member);
    await module.setup?.(ctx);

    await emitRankChanged(bus);

    expect(stub.add).not.toHaveBeenCalled();
  });

  it('парная проверка: тот же аккаунт с подтверждённым verified_at роль получает', async () => {
    await pg.db.update(gameAccounts).set({ verifiedAt: new Date() }).where(eq(gameAccounts.id, accountId));

    const stub = fakeMember();
    const { module, bus, ctx } = moduleForHandler(stub.member);
    await module.setup?.(ctx);

    await emitRankChanged(bus);

    expect(stub.add).toHaveBeenCalledWith(RANK_ROLE, expect.any(String));
  });
});

/**
 * Находка 3 итогового ревью: утрата ранга должна снимать роль, а не оставлять её
 * навсегда (сброс сезона — самый заметный случай). rank-sync.test.ts уже проверяет,
 * что syncAccount записывает снимок с tier: null и публикует rank.changed на честном
 * пустом ответе провайдера — здесь же сквозная проверка на реальном createIdentityModule:
 * от вызова /ranksync до факта снятия роли через тот же обработчик rank.changed,
 * что уже проверен на verified_at выше. Без парного теста «сбой не снимает роль»
 * первый тест прошёл бы и на коде, который путает сбой с честной пустотой (это и
 * есть находка 1 — починена отдельно в rank-sync.ts).
 */
describe('находка 3 итогового ревью: утраченный ранг снимает роль через реальный /ranksync', () => {
  const LOSS_GUILD = '555555555555555590';
  const LOSS_ROLE = '700000000000000090';

  type RiotMode = 'diamond' | 'empty' | 'fail';

  /** Управляемая заглушка HTTP-клиента Riot: настоящий RiotProvider поверх неё делает
   * настоящий разбор ответа (normalizeRiotEntry), поэтому «Diamond» и «пусто» — это
   * честные исходы синхронизации, а не подмена на уровне провайдера. */
  function riotRankStub() {
    let mode: RiotMode = 'diamond';
    const json = vi.fn(async (_url: string, init?: { schema?: { parse(input: unknown): unknown } }) => {
      if (mode === 'fail') throw new ProviderError('Riot API недоступен', 'riot-lol');
      const raw: unknown =
        mode === 'empty' ? [] : [{ queueType: 'RANKED_SOLO_5x5', tier: 'DIAMOND', rank: 'II', leaguePoints: 50 }];
      return init?.schema ? init.schema.parse(raw) : raw;
    });
    return { json, setMode: (next: RiotMode) => (mode = next) };
  }

  /** В отличие от fakeMember() выше, add/remove здесь реально меняют roles.cache —
   * иначе второй вызов applyRoles не увидел бы, что роль уже выдана, и не снял бы её. */
  function fakeMemberWithRoleState(userId: string) {
    const roleCache = new Map<string, unknown>();
    const add = vi.fn(async (roleId: string) => {
      roleCache.set(roleId, true);
    });
    const remove = vi.fn(async (roleId: string) => {
      roleCache.delete(roleId);
    });
    const member = { id: userId, roles: { cache: roleCache, add, remove } } as unknown as GuildMember;
    return { member, add, remove, roleCache };
  }

  function ranksyncInteraction(userId: string) {
    const followUp = vi.fn(async () => {});
    const interaction = { user: { id: userId }, followUp } as unknown as ChatInputCommandInteraction;
    return { interaction, followUp };
  }

  async function setupVerifiedAccount(userId: string, externalId: string): Promise<void> {
    const linking = createLinkingService({ db: pg.db });
    await linking.ensureUser(userId);
    await linking.linkAccount(
      userId,
      'riot-lol',
      { externalId, displayName: 'долг#EUW', region: 'euw1', verificationMethod: 'riot-third-party-code' },
      true, // verified — иначе авто-роль не выдастся даже на честный Diamond
    );
  }

  function moduleWithRiotStub(stub: ReturnType<typeof riotRankStub>, member: GuildMember) {
    const bus = new EventBus(logger);
    const module = createIdentityModule({
      db: pg.db,
      bus,
      logger,
      config: {
        PUBLIC_BASE_URL: 'https://bot.example.com',
        REDIS_URL: 'redis://localhost:6379',
        RIOT_API_KEY: 'test-riot-key',
      } as Config,
      cooldown: { hit: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })), close: vi.fn(async () => {}) },
      rateLimiter: { acquire: vi.fn(async () => {}), close: vi.fn(async () => {}) },
      // WRAPPED-реестр (для /link, /profile) в этом тесте не задействуется вовсе —
      // /ranksync работает через RAW-реестр синхронизации, поэтому пустая заглушка
      // кэша безопасна (см. общий комментарий moduleWith() выше).
      cache: {} as unknown as Cache,
      fetchClientFor: (provider: string) =>
        provider === 'riot' ? (stub as unknown as FetchClient) : ({ json: vi.fn() } as unknown as FetchClient),
      fetchMember: vi.fn(async () => member),
    });
    const ctx = {
      client: { guilds: { cache: new Map([[LOSS_GUILD, {}]]) } },
      logger,
    } as unknown as ModuleContext;
    return { module, bus, ctx };
  }

  beforeAll(async () => {
    await pg.db.insert(guilds).values({ id: LOSS_GUILD }).onConflictDoNothing();
    const roles = createRoleMappingService({ db: pg.db, logger });
    await roles.setMapping(LOSS_GUILD, 'riot-lol', 'solo-duo', 'DIAMOND', LOSS_ROLE);
  });

  it('провайдер сначала выдал Diamond (роль выдана), потом честно ответил пусто → снимок tier: null, rank.changed, роль снята', async () => {
    const userId = '666666666666666690';
    await setupVerifiedAccount(userId, 'PUUID-LOSS-A');
    const stub = riotRankStub();
    const { member, add, remove, roleCache } = fakeMemberWithRoleState(userId);
    const { module, ctx } = moduleWithRiotStub(stub, member);
    await module.setup?.(ctx);

    const ranksync = module.commands?.find((c) => c.builder.name === 'ranksync');
    if (!ranksync) throw new Error('команда ranksync не найдена в module.commands');

    // Первый прогон: Diamond → авто-роль выдана.
    await ranksync.execute(ranksyncInteraction(userId).interaction, ctx);
    expect(add).toHaveBeenCalledWith(LOSS_ROLE, expect.any(String));
    expect(roleCache.has(LOSS_ROLE)).toBe(true);

    // Второй прогон: провайдер отвечает успешно, но пусто → роль обязана сняться.
    stub.setMode('empty');
    await ranksync.execute(ranksyncInteraction(userId).interaction, ctx);

    expect(remove).toHaveBeenCalledWith(LOSS_ROLE, expect.any(String));
    expect(roleCache.has(LOSS_ROLE)).toBe(false);
  });

  it('парная проверка: сбой провайдера роль не снимает', async () => {
    const userId = '666666666666666691';
    await setupVerifiedAccount(userId, 'PUUID-LOSS-B');
    const stub = riotRankStub();
    const { member, add, remove, roleCache } = fakeMemberWithRoleState(userId);
    const { module, ctx } = moduleWithRiotStub(stub, member);
    await module.setup?.(ctx);

    const ranksync = module.commands?.find((c) => c.builder.name === 'ranksync');
    if (!ranksync) throw new Error('команда ranksync не найдена в module.commands');

    await ranksync.execute(ranksyncInteraction(userId).interaction, ctx);
    expect(add).toHaveBeenCalledWith(LOSS_ROLE, expect.any(String));
    expect(roleCache.has(LOSS_ROLE)).toBe(true);

    stub.setMode('fail');
    await ranksync.execute(ranksyncInteraction(userId).interaction, ctx);

    expect(remove).not.toHaveBeenCalled();
    expect(roleCache.has(LOSS_ROLE)).toBe(true);
  });
});

/**
 * Находки 1 и 2 итогового ревью: createIdentityModule обязан передавать синхронизации
 * (job'у и /ranksync) провайдеров БЕЗ обёртки withCache, а командам — с обёрткой.
 * rank-sync.test.ts проверяет это на уровне RankSyncService (провайдер того же id уже
 * обёрнут кэшем в Redis, а RAW-провайдер синхронизации всё равно видит сбой). Здесь —
 * тест на саму сборку зависимостей в identity/index.ts, чтобы регресс («кто-нибудь
 * снова обернёт») ловился именно там, где он может случиться.
 *
 * Вместо мок-HTTP-слоя используется естественный, детерминированный сбой: конфиг без
 * RIOT_API_KEY — настоящий RiotProvider бросает UserError изнутри headers() при любом
 * реальном обращении, до какого-либо сетевого вызова. Redis при этом настоящий и
 * заранее «горячий» — если бы синхронизация получила тот же кэширующий реестр, что
 * и команды, она бы тихо взяла успешную запись из кэша и не дошла бы до RiotProvider
 * вовсе, никакого UserError не увидев.
 */
describe('находки 1 и 2 итогового ревью: синхронизация не пользуется кэшем команд', () => {
  it('/ranksync реально идёт к провайдеру, даже когда в Redis уже лежит горячая запись для того же провайдера и аккаунта', async () => {
    const userId = '666666666666666680';
    const externalId = 'PUUID-CACHE-INVARIANT';
    const cache = new Cache({ REDIS_URL: redis.url, LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config, logger);

    // Симулирует, что кто-то до этого воспользовался /link или /profile: командный,
    // кэширующий путь для этого же provider+externalId+region уже успешно отвечал,
    // и Redis хранит совсем свежую запись.
    await cache.swr(`provider:riot-lol:rank:${externalId}:euw1`, {
      ttlMs: 20 * 60 * 1_000,
      staleMs: 24 * 60 * 60 * 1_000,
      load: async () => [
        { mode: 'solo-duo', scale: 'riot-tier', tier: 'DIAMOND', division: 'II', points: 50, source: 'api', raw: {} },
      ],
    });

    const linking = createLinkingService({ db: pg.db });
    await linking.ensureUser(userId);
    await linking.linkAccount(
      userId,
      'riot-lol',
      { externalId, displayName: 'a#b', region: 'euw1', verificationMethod: 'riot-third-party-code' },
      true,
    );

    const bus = new EventBus(logger);
    const module = createIdentityModule({
      db: pg.db,
      bus,
      logger,
      // Намеренно без RIOT_API_KEY — см. комментарий над describe.
      config: { PUBLIC_BASE_URL: 'https://bot.example.com', REDIS_URL: redis.url } as Config,
      cooldown: { hit: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })), close: vi.fn(async () => {}) },
      rateLimiter: { acquire: vi.fn(async () => {}), close: vi.fn(async () => {}) },
      cache,
      fetchClientFor: () => ({ json: vi.fn() }) as unknown as FetchClient,
      fetchMember: vi.fn(async () => null),
    });

    const ranksync = module.commands?.find((c) => c.builder.name === 'ranksync');
    if (!ranksync) throw new Error('команда ranksync не найдена в module.commands');

    // Типовой параметр обязателен: у vi.fn без него Parameters<T> — пустой кортеж, и
    // mock.calls.at(0)?.at(0) выводится как never, поэтому обращение к .content не
    // компилируется при noUncheckedIndexedAccess.
    const followUp = vi.fn<(payload: { content: string }) => Promise<void>>(async () => {});
    const interaction = { user: { id: userId }, followUp } as unknown as ChatInputCommandInteraction;
    await ranksync.execute(interaction, {} as ModuleContext);

    // Главный признак инварианта — «с рангом: 0»: в Redis лежит горячая запись с DIAMOND,
    // и если бы синхронизация ходила через кэширующий реестр, она бы её взяла и отчиталась
    // единицей. Ноль означает, что запрос ушёл к провайдеру и честно упал без ключа Riot.
    // Формат перечня отказов проверяем отдельными подстроками, а не одной склеенной:
    // текст ответа собирается многострочным списком, и жёсткая склейка ломалась бы от
    // любой правки вёрстки, не имеющей отношения к проверяемому поведению.
    const content = followUp.mock.calls.at(0)?.at(0)?.content as string | undefined;
    expect(content).toBeDefined();
    expect(content).toContain('с рангом: 0');
    expect(content).toContain('Не ответили');
    expect(content).toContain('riot-lol');

    await cache.close();
  });
});
