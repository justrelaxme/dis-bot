import { DiscordAPIError, PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import type { Database } from '../../../src/core/db/client.js';
import { UserError } from '../../../src/core/errors.js';
import { createLogger } from '../../../src/core/logger.js';
import { profiles, purchases } from '../../../src/modules/progression/schema.js';
import { createProgressionService } from '../../../src/modules/progression/service.js';
import { purchaseRole, type ShopMember } from '../../../src/modules/progression/shop.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

const PRICE = 60;
const ROLE_ID = '75000000000000001';

let counter = 0;

/** Сервер с одним товаром и человек с заданным балансом — у каждого теста свои. */
async function shopWith(coins: number) {
  counter += 1;
  const progression = createProgressionService({ db: pg.db });
  const guildId = `73${String(counter).padStart(15, '0')}`;
  const userId = `74${String(counter).padStart(15, '0')}`;

  const item = await progression.addShopItem({ guildId, payload: ROLE_ID, title: 'Цвет', price: PRICE });
  if (!item) throw new Error('товар не добавился');

  const profile = await progression.profile(guildId, userId);
  await pg.db.update(profiles).set({ coins }).where(eq(profiles.id, profile.id));

  return { progression, guildId, userId, item, profileId: profile.id };
}

async function coinsOf(profileId: number): Promise<number> {
  const [row] = await pg.db.select().from(profiles).where(eq(profiles.id, profileId));
  return row?.coins ?? Number.NaN;
}

async function purchasesOf(guildId: string, userId: string) {
  return pg.db
    .select()
    .from(purchases)
    .where(and(eq(purchases.guildId, guildId), eq(purchases.userId, userId)));
}

function discordError(code: number): DiscordAPIError {
  return new DiscordAPIError(
    { message: 'отказ', code },
    code,
    code === RESTJSONErrorCodes.UnknownRole ? 404 : 403,
    'PUT',
    `/guilds/1/members/2/roles/${ROLE_ID}`,
    { body: undefined, files: undefined },
  );
}

/** Участник-подделка: роли в памяти, выдача по сценарию теста. */
function memberWith(options: {
  add?: () => Promise<unknown>;
  hasRole?: boolean;
  botCanManageRoles?: boolean;
}) {
  const owned = new Set<string>(options.hasRole ? [ROLE_ID] : []);
  const add = vi.fn(async (roleId: string) => {
    await options.add?.();
    owned.add(roleId);
  });
  const remove = vi.fn(async (roleId: string) => {
    owned.delete(roleId);
  });
  const member: ShopMember = {
    roles: { cache: { has: (roleId) => owned.has(roleId) }, add, remove },
    guild: {
      members: {
        me: {
          permissions: {
            has: (permission) =>
              permission === PermissionFlagsBits.ManageRoles && (options.botCanManageRoles ?? true),
          },
        },
      },
    },
  };
  return { member, owned, add, remove };
}

/** Ждёт, пока чей-то запрос в этой базе встанет в очередь за блокировкой строки. */
async function waitForLockWait(db: Database): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await db.execute<{ waiting: number }>(sql`
      select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
    `);
    if ((result.rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('запрос так и не встал в ожидание блокировки');
}

describe('магазин прогрессии', () => {
  it('роль выдалась — монеты списаны, покупка записана', async () => {
    const shop = await shopWith(100);
    const fake = memberWith({});

    const result = await purchaseRole({ ...shop, member: fake.member, logger });

    expect(fake.owned.has(ROLE_ID)).toBe(true);
    expect(result.profile.coins).toBe(40);
    expect(await coinsOf(shop.profileId)).toBe(40);
    expect(await purchasesOf(shop.guildId, shop.userId)).toHaveLength(1);
  });

  it('Discord не выдал роль из-за прав — монеты не списаны, причина названа', async () => {
    const shop = await shopWith(100);
    const fake = memberWith({
      add: async () => Promise.reject(discordError(RESTJSONErrorCodes.MissingPermissions)),
      botCanManageRoles: false,
    });

    const attempt = purchaseRole({ ...shop, member: fake.member, logger });

    await expect(attempt).rejects.toBeInstanceOf(UserError);
    await expect(attempt).rejects.toThrow(/Управление ролями.*Монеты не списаны/);
    expect(await coinsOf(shop.profileId)).toBe(100);
    expect(await purchasesOf(shop.guildId, shop.userId)).toHaveLength(0);
  });

  it('роль бота ниже продаваемой — отказ называет иерархию, а не права', async () => {
    const shop = await shopWith(100);
    const fake = memberWith({
      add: async () => Promise.reject(discordError(RESTJSONErrorCodes.MissingPermissions)),
      botCanManageRoles: true,
    });

    await expect(purchaseRole({ ...shop, member: fake.member, logger })).rejects.toThrow(
      /Роль бота стоит ниже продаваемой/,
    );
    expect(await coinsOf(shop.profileId)).toBe(100);
  });

  it('монет заведомо не хватает — роль даже не выдаётся', async () => {
    const shop = await shopWith(PRICE - 1);
    const fake = memberWith({});

    await expect(purchaseRole({ ...shop, member: fake.member, logger })).rejects.toThrow(/Не хватает монет/);
    expect(fake.add).not.toHaveBeenCalled();
  });

  it('монеты ушли между выдачей и списанием — выданная роль снимается обратно', async () => {
    const shop = await shopWith(100);
    // Пока Discord выдаёт роль, другая покупка успевает потратить монеты.
    const fake = memberWith({
      add: async () => {
        await pg.db.update(profiles).set({ coins: 10 }).where(eq(profiles.id, shop.profileId));
      },
    });

    await expect(purchaseRole({ ...shop, member: fake.member, logger })).rejects.toThrow(
      /Не хватает монет: нужно 60, у тебя 10/,
    );
    expect(fake.remove).toHaveBeenCalledWith(ROLE_ID, expect.any(String));
    expect(fake.owned.has(ROLE_ID)).toBe(false);
    expect(await coinsOf(shop.profileId)).toBe(10);
    expect(await purchasesOf(shop.guildId, shop.userId)).toHaveLength(0);
  });

  it('роль, купленную раньше, неудачная повторная покупка не отнимает', async () => {
    const shop = await shopWith(100);
    const fake = memberWith({ hasRole: true });
    await pg.db.update(profiles).set({ coins: 10 }).where(eq(profiles.id, shop.profileId));

    await expect(purchaseRole({ ...shop, member: fake.member, logger })).rejects.toThrow(/Не хватает монет/);
    expect(fake.remove).not.toHaveBeenCalled();
    expect(fake.owned.has(ROLE_ID)).toBe(true);
  });

  it('списание вычитает в SQL: монеты, пришедшие между чтением и списанием, не пропадают', async () => {
    const shop = await shopWith(100);

    // Строку держит чужая транзакция, которая начисляет 50. Покупка успевает прочитать
    // баланс (100), а её списание встаёт в очередь за блокировкой. Разность, посчитанная
    // из прочитанного, записала бы 40 и съела начисление; вычитание в SQL даёт 90.
    let purchase: Promise<unknown> | undefined;
    await pg.db.transaction(async (tx) => {
      await tx
        .update(profiles)
        .set({ coins: sql`${profiles.coins} + 50` })
        .where(eq(profiles.id, shop.profileId));
      purchase = shop.progression.buy(shop.guildId, shop.userId, shop.item.id);
      await waitForLockWait(pg.db);
    });
    await purchase;

    expect(await coinsOf(shop.profileId)).toBe(90);
  });

  it('две одновременные покупки на один баланс: проходит ровно одна, в минус не уходит', async () => {
    const shop = await shopWith(100);

    const outcomes = await Promise.allSettled([
      shop.progression.buy(shop.guildId, shop.userId, shop.item.id),
      shop.progression.buy(shop.guildId, shop.userId, shop.item.id),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await coinsOf(shop.profileId)).toBe(40);
    expect(await purchasesOf(shop.guildId, shop.userId)).toHaveLength(1);
  });
});
