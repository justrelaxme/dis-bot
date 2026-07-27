import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditLog, guilds, members, users } from '../../../src/core/db/schema/index.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();

describe('схема ядра', () => {
  it('сохраняет сервер, пользователя и участника', async () => {
    await pg.db.insert(guilds).values({ id: '111111111111111111' });
    await pg.db.insert(users).values({ id: '222222222222222222' });
    await pg.db.insert(members).values({
      guildId: '111111111111111111',
      userId: '222222222222222222',
      joinedAt: new Date(),
    });

    const rows = await pg.db.select().from(members).where(eq(members.guildId, '111111111111111111'));
    expect(rows).toHaveLength(1);
  });

  it('подставляет пустой объект в settings по умолчанию', async () => {
    await pg.db.insert(guilds).values({ id: '333333333333333333' });
    const [row] = await pg.db.select().from(guilds).where(eq(guilds.id, '333333333333333333'));
    expect(row?.settings).toEqual({});
  });

  it('запрещает участника без существующего сервера', async () => {
    await expect(
      pg.db.insert(members).values({
        guildId: '999999999999999999',
        userId: '222222222222222222',
        joinedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('пишет запись аудита с NULL в actor_id для действий бота', async () => {
    await pg.db.insert(auditLog).values({
      guildId: '111111111111111111',
      action: 'core.started',
      details: { version: '0.1.0' },
    });
    const rows = await pg.db.select().from(auditLog).where(eq(auditLog.action, 'core.started'));
    expect(rows[0]?.actorId).toBeNull();
    expect(rows[0]?.details).toEqual({ version: '0.1.0' });
  });
});
