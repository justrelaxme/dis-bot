import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { GuildMember } from 'discord.js';
import type { Config } from '../../../src/core/config.js';
import { guilds } from '../../../src/core/db/schema/core.js';
import { EventBus } from '../../../src/core/events/bus.js';
import { createLogger } from '../../../src/core/logger.js';
import type { ModuleContext } from '../../../src/core/module.js';
import { buildRegistry } from '../../../src/core/registry.js';
import { createIdentityModule } from '../../../src/modules/identity/index.js';
import { gameAccounts } from '../../../src/modules/identity/schema.js';
import { createLinkingService } from '../../../src/modules/identity/services/linking.js';
import { createRoleMappingService } from '../../../src/modules/identity/services/role-mapping.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
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
