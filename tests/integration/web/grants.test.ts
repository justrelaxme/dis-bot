import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createGrantsService } from '../../../src/modules/web/grants.js';
import { webGrants } from '../../../src/modules/web/schema.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();

/**
 * Пропуск на витрину — это и есть право что-то менять: ссылку можно переслать, и тогда
 * доступ уйдёт вместе с ней. Отсюда два свойства, которые обязаны работать, а не «обычно
 * работать»: выдача новой ссылки гасит прежнюю (иначе доступ не отозвать вообще ничем), и
 * просроченная не действует.
 */

let counter = 0;
const ids = (): { guildId: string; userId: string } => {
  counter += 1;
  const pad = String(counter).padStart(4, '0');
  return { guildId: `72000000000000${pad}`, userId: `73000000000000${pad}` };
};

describe('пропуск в конструктор', () => {
  it('выдаётся и опознаётся', async () => {
    const grants = createGrantsService({ db: pg.db });
    const who = ids();

    const issued = await grants.issue({ ...who, scope: 'formats' });
    const owner = await grants.owner(issued.token, 'formats');

    expect(owner?.guildId).toBe(who.guildId);
    expect(owner?.userId).toBe(who.userId);
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  /** Единственный способ отозвать выданную ссылку — выдать новую. Значит, он обязан работать. */
  it('новая ссылка гасит прежнюю', async () => {
    const grants = createGrantsService({ db: pg.db });
    const who = ids();

    const first = await grants.issue({ ...who, scope: 'formats' });
    const second = await grants.issue({ ...who, scope: 'formats' });

    expect(second.token).not.toBe(first.token);
    expect(await grants.owner(first.token, 'formats')).toBeNull();
    expect(await grants.owner(second.token, 'formats')).not.toBeNull();
  });

  /** Пропуск другого человека не гасится: иначе один организатор выбивал бы второго. */
  it('ссылка другого человека остаётся действующей', async () => {
    const grants = createGrantsService({ db: pg.db });
    const first = ids();
    const second = { guildId: first.guildId, userId: ids().userId };

    const mine = await grants.issue({ ...first, scope: 'formats' });
    await grants.issue({ ...second, scope: 'formats' });

    expect(await grants.owner(mine.token, 'formats')).not.toBeNull();
  });

  it('выдуманный токен никого не пускает', async () => {
    const grants = createGrantsService({ db: pg.db });

    expect(await grants.owner('такого-нет', 'formats')).toBeNull();
    expect(await grants.owner(undefined, 'formats')).toBeNull();
    expect(await grants.owner('', 'formats')).toBeNull();
  });

  it('просроченный пропуск не действует', async () => {
    const grants = createGrantsService({ db: pg.db });
    const who = ids();
    const issued = await grants.issue({ ...who, scope: 'formats' });

    await pg.db
      .update(webGrants)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(webGrants.token, issued.token));

    expect(await grants.owner(issued.token, 'formats')).toBeNull();
  });

  /**
   * Уборка — про размер таблицы, а не про безопасность: просроченный пропуск не действует и
   * до неё. Поэтому она не должна задевать действующие.
   */
  it('уборка убирает просроченные и не трогает живые', async () => {
    const grants = createGrantsService({ db: pg.db });
    const alive = ids();
    const dead = ids();

    const living = await grants.issue({ ...alive, scope: 'formats' });
    const expired = await grants.issue({ ...dead, scope: 'formats' });
    await pg.db
      .update(webGrants)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(webGrants.token, expired.token));

    const removed = await grants.sweepExpired(new Date());

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await grants.owner(living.token, 'formats')).not.toBeNull();
  });

  it('токены неугадываемы: длинные и разные', async () => {
    const grants = createGrantsService({ db: pg.db });
    const seen = new Set<string>();

    for (let index = 0; index < 5; index += 1) {
      const issued = await grants.issue({ ...ids(), scope: 'formats' });
      expect(issued.token.length).toBeGreaterThan(32);
      seen.add(issued.token);
    }

    expect(seen.size).toBe(5);
  });
});
