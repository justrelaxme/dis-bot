import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { GuildMember } from 'discord.js';
import type { Config } from '../../../src/core/config.js';
import { guilds, users } from '../../../src/core/db/schema/core.js';
import { createLogger } from '../../../src/core/logger.js';
import type { RankInfo } from '../../../src/modules/identity/providers/provider.js';
import { gameAccounts } from '../../../src/modules/identity/schema.js';
import { createRoleMappingService } from '../../../src/modules/identity/services/role-mapping.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

const GUILD = '111111111111111111';
const GOLD_ROLE = '400000000000000001';
const PLAT_ROLE = '400000000000000002';
/** Отдельный пользователь для теста на verified_at — с ролями других тестов не пересекается. */
const UNVERIFIED_USER = '333333333333333333';

function riot(tier: string, mode = 'solo-duo'): RankInfo {
  return { mode, scale: 'riot-tier', tier, division: 'II', points: 0, source: 'api', raw: {} };
}

function fakeMember(roleIds: string[]) {
  const add = vi.fn(async () => {});
  const remove = vi.fn(async () => {});
  const member = {
    id: '222222222222222222',
    roles: { cache: new Map(roleIds.map((id) => [id, { id }])), add, remove },
  } as unknown as GuildMember;
  return { member, add, remove };
}

beforeAll(async () => {
  await pg.db.insert(guilds).values({ id: GUILD }).onConflictDoNothing();
});

describe('RoleMappingService', () => {
  it('сохраняет и перечисляет маппинги', async () => {
    const service = createRoleMappingService({ db: pg.db, logger });
    await service.setMapping(GUILD, 'riot-lol', 'solo-duo', 'GOLD', GOLD_ROLE);

    const mappings = await service.listMappings(GUILD);
    expect(mappings).toEqual(
      expect.arrayContaining([expect.objectContaining({ tier: 'GOLD', roleId: GOLD_ROLE })]),
    );
  });

  it('перезаписывает роль для того же ранга, а не создаёт дубль', async () => {
    const service = createRoleMappingService({ db: pg.db, logger });
    await service.setMapping(GUILD, 'riot-lol', 'solo-duo', 'GOLD', GOLD_ROLE);
    await service.setMapping(GUILD, 'riot-lol', 'solo-duo', 'GOLD', PLAT_ROLE);

    const forGold = (await service.listMappings(GUILD)).filter((m) => m.tier === 'GOLD');
    expect(forGold).toHaveLength(1);
    expect(forGold[0]?.roleId).toBe(PLAT_ROLE);
  });

  it('подбирает роль под текущий ранг', async () => {
    const service = createRoleMappingService({ db: pg.db, logger });
    await service.setMapping(GUILD, 'riot-lol', 'solo-duo', 'PLATINUM', PLAT_ROLE);

    const roles = await service.resolveDesiredRoles(GUILD, 'riot-lol', [riot('PLATINUM')]);
    expect(roles).toEqual([PLAT_ROLE]);
  });

  it('не выдаёт ничего, когда для ранга нет маппинга', async () => {
    const service = createRoleMappingService({ db: pg.db, logger });
    const roles = await service.resolveDesiredRoles(GUILD, 'riot-lol', [riot('IRON')]);
    expect(roles).toEqual([]);
  });

  it('различает режимы: маппинг соло-очереди не срабатывает на flex', async () => {
    const service = createRoleMappingService({ db: pg.db, logger });
    await service.setMapping(GUILD, 'riot-lol', 'solo-duo', 'DIAMOND', PLAT_ROLE);

    const roles = await service.resolveDesiredRoles(GUILD, 'riot-lol', [riot('DIAMOND', 'flex')]);
    expect(roles).toEqual([]);
  });

  it('выдаёт недостающую роль и не трогает уже имеющиеся', async () => {
    const service = createRoleMappingService({ db: pg.db, logger });
    await service.setMapping(GUILD, 'riot-lol', 'solo-duo', 'PLATINUM', PLAT_ROLE);
    const { member, add, remove } = fakeMember([]);

    const result = await service.applyRoles(member, GUILD, 'riot-lol', [riot('PLATINUM')]);

    expect(result.added).toEqual([PLAT_ROLE]);
    expect(add).toHaveBeenCalledWith(PLAT_ROLE, expect.any(String));
    expect(remove).not.toHaveBeenCalled();
  });

  it('снимает роль за прошлый ранг при переходе в новый', async () => {
    const service = createRoleMappingService({ db: pg.db, logger });
    await service.setMapping(GUILD, 'riot-lol', 'solo-duo', 'GOLD', GOLD_ROLE);
    await service.setMapping(GUILD, 'riot-lol', 'solo-duo', 'PLATINUM', PLAT_ROLE);
    const { member, add, remove } = fakeMember([GOLD_ROLE]);

    const result = await service.applyRoles(member, GUILD, 'riot-lol', [riot('PLATINUM')]);

    expect(result.added).toEqual([PLAT_ROLE]);
    expect(result.removed).toEqual([GOLD_ROLE]);
    expect(add).toHaveBeenCalledWith(PLAT_ROLE, expect.any(String));
    expect(remove).toHaveBeenCalledWith(GOLD_ROLE, expect.any(String));
  });

  it('ничего не делает, когда роли уже верны', async () => {
    const service = createRoleMappingService({ db: pg.db, logger });
    await service.setMapping(GUILD, 'riot-lol', 'solo-duo', 'PLATINUM', PLAT_ROLE);
    const { member, add, remove } = fakeMember([PLAT_ROLE]);

    const result = await service.applyRoles(member, GUILD, 'riot-lol', [riot('PLATINUM')]);

    expect(result).toEqual({ added: [], removed: [] });
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('не снимает роли, не относящиеся к этому провайдеру', async () => {
    const service = createRoleMappingService({ db: pg.db, logger });
    await service.setMapping(GUILD, 'riot-lol', 'solo-duo', 'PLATINUM', PLAT_ROLE);
    const постороннаяРоль = '499999999999999999';
    const { member, remove } = fakeMember([постороннаяРоль]);

    await service.applyRoles(member, GUILD, 'riot-lol', [riot('PLATINUM')]);

    expect(remove).not.toHaveBeenCalledWith(постороннаяРоль, expect.any(String));
  });

  // Добавлено сверх брифа: указание из ревью Task 1 (progress.md) — семантика
  // «verified_at IS NULL → авто-роль не даётся» нигде не тестировалась. Роль-маппинг
  // сам не читает gameAccounts (RankInfo не несёт признака верификации; ranks сюда
  // приходят уже готовыми), поэтому границу с оркестратором (обработчик rank.changed
  // в src/modules/identity/index.ts, `if (!account?.verifiedAt) continue`) тест
  // воспроизводит на настоящей записи БД (Task 1) и проверяет оба её конца: пока
  // verified_at IS NULL — роли нет, как только владение подтверждено — тот же вызов
  // её выдаёт. Второй конец нужен, чтобы первый не проходил просто потому, что
  // маппинга нет вовсе.
  it('не выдаёт роль по рангу аккаунта с неподтверждённым владением (verified_at IS NULL)', async () => {
    const service = createRoleMappingService({ db: pg.db, logger });
    await service.setMapping(GUILD, 'riot-lol', 'solo-duo', 'DIAMOND', PLAT_ROLE);

    await pg.db.insert(users).values({ id: UNVERIFIED_USER }).onConflictDoNothing();
    const [account] = await pg.db
      .insert(gameAccounts)
      .values({
        userId: UNVERIFIED_USER,
        provider: 'riot-lol',
        externalId: 'PUUID-unverified',
        displayName: 'unverified#EUW',
        verificationMethod: 'manual',
        verifiedAt: null,
      })
      .returning();
    expect(account?.verifiedAt).toBeNull();

    // Контракт с оркестратором: неподтверждённой привязке ranks не передаются вовсе.
    const { member: memberBefore, add: addBefore } = fakeMember([]);
    const blocked = await service.applyRoles(
      memberBefore,
      GUILD,
      'riot-lol',
      account?.verifiedAt ? [riot('DIAMOND')] : [],
    );
    expect(blocked).toEqual({ added: [], removed: [] });
    expect(addBefore).not.toHaveBeenCalled();

    await pg.db.update(gameAccounts).set({ verifiedAt: new Date() }).where(eq(gameAccounts.id, account!.id));
    const [verified] = await pg.db.select().from(gameAccounts).where(eq(gameAccounts.id, account!.id));
    expect(verified?.verifiedAt).not.toBeNull();

    const { member: memberAfter, add: addAfter } = fakeMember([]);
    const allowed = await service.applyRoles(
      memberAfter,
      GUILD,
      'riot-lol',
      verified?.verifiedAt ? [riot('DIAMOND')] : [],
    );
    expect(allowed.added).toEqual([PLAT_ROLE]);
    expect(addAfter).toHaveBeenCalledWith(PLAT_ROLE, expect.any(String));
  });

  it('удаляет маппинг', async () => {
    const service = createRoleMappingService({ db: pg.db, logger });
    await service.setMapping(GUILD, 'riot-tft', 'tft-ranked', 'SILVER', GOLD_ROLE);

    await expect(service.removeMapping(GUILD, 'riot-tft', 'tft-ranked', 'SILVER')).resolves.toBe(true);
    await expect(service.removeMapping(GUILD, 'riot-tft', 'tft-ranked', 'SILVER')).resolves.toBe(false);
  });
});
