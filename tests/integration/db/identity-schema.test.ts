import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { guilds, users } from '../../../src/core/db/schema/core.js';
import { gameAccounts, rankSnapshots, roleMappings } from '../../../src/modules/identity/schema.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();

const GUILD = '111111111111111111';
const ALICE = '222222222222222222';
const BOB = '333333333333333333';

beforeAll(async () => {
  await pg.db.insert(guilds).values({ id: GUILD });
  await pg.db.insert(users).values([{ id: ALICE }, { id: BOB }]);
});

describe('схема identity', () => {
  it('сохраняет подтверждённый аккаунт', async () => {
    const [row] = await pg.db
      .insert(gameAccounts)
      .values({
        userId: ALICE,
        provider: 'steam',
        externalId: '76561198000000001',
        displayName: 'alice',
        verifiedAt: new Date(),
        verificationMethod: 'steam-openid',
      })
      .returning();

    expect(row?.id).toBeTypeOf('number');
    expect(row?.region).toBeNull();
  });

  it('запрещает привязать один игровой аккаунт к двум пользователям', async () => {
    // drizzle оборачивает ошибку pg в DrizzleQueryError — код и текст Postgres
    // лежат в её .cause, а не на самой ошибке (см. core-schema.test.ts). 23505 — unique_violation.
    await expect(
      pg.db.insert(gameAccounts).values({
        userId: BOB,
        provider: 'steam',
        externalId: '76561198000000001',
        displayName: 'alice-клон',
        verificationMethod: 'manual',
      }),
    ).rejects.toMatchObject({
      cause: { code: '23505', message: expect.stringMatching(/game_accounts_provider_external_uq/) },
    });
  });

  it('запрещает второй аккаунт того же провайдера у одного пользователя', async () => {
    await expect(
      pg.db.insert(gameAccounts).values({
        userId: ALICE,
        provider: 'steam',
        externalId: '76561198000000002',
        displayName: 'смурф',
        verificationMethod: 'manual',
      }),
    ).rejects.toMatchObject({
      cause: { code: '23505', message: expect.stringMatching(/game_accounts_user_provider_uq/) },
    });
  });

  it('хранит историю рангов, а не одно значение', async () => {
    const [account] = await pg.db.select().from(gameAccounts).where(eq(gameAccounts.userId, ALICE));
    const accountId = account!.id;

    await pg.db.insert(rankSnapshots).values([
      { accountId, mode: 'dota-mmr', scale: 'dota-mmr', tier: 'LEGEND', division: '3', points: null, source: 'api', raw: { rank_tier: 53 } },
      { accountId, mode: 'dota-mmr', scale: 'dota-mmr', tier: 'ANCIENT', division: '1', points: null, source: 'api', raw: { rank_tier: 61 } },
    ]);

    const rows = await pg.db.select().from(rankSnapshots).where(eq(rankSnapshots.accountId, accountId));
    expect(rows).toHaveLength(2);
  });

  it('удаляет снимки рангов вместе с аккаунтом', async () => {
    const [account] = await pg.db.select().from(gameAccounts).where(eq(gameAccounts.userId, ALICE));
    await pg.db.delete(gameAccounts).where(eq(gameAccounts.id, account!.id));

    const rows = await pg.db.select().from(rankSnapshots).where(eq(rankSnapshots.accountId, account!.id));
    expect(rows).toHaveLength(0);
  });

  it('запрещает два маппинга на один и тот же ранг', async () => {
    await pg.db.insert(roleMappings).values({
      guildId: GUILD,
      provider: 'riot-lol',
      mode: 'solo-duo',
      tier: 'PLATINUM',
      roleId: '444444444444444444',
    });

    await expect(
      pg.db.insert(roleMappings).values({
        guildId: GUILD,
        provider: 'riot-lol',
        mode: 'solo-duo',
        tier: 'PLATINUM',
        roleId: '555555555555555555',
      }),
    ).rejects.toMatchObject({
      cause: { code: '23505', message: expect.stringMatching(/role_mappings_uq/) },
    });
  });
});
