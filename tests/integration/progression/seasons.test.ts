import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { seasons } from '../../../src/modules/progression/schema.js';
import { createProgressionService } from '../../../src/modules/progression/service.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();

/**
 * Открытый сезон на сервере один. Первые обращения на новом сервере приходят одновременно —
 * сообщение и голос, — и раньше каждое заводило свой «Первый сезон»: опыт расползался по
 * двум сезонам, а таблица показывала только один из них.
 */
describe('первый сезон сервера', () => {
  it('одновременные обращения заводят один сезон', async () => {
    const progression = createProgressionService({ db: pg.db });
    const guildId = '770000000000000001';

    const results = await Promise.all(Array.from({ length: 10 }, () => progression.currentSeason(guildId)));

    expect(new Set(results.map((season) => season.id)).size).toBe(1);
    const open = await pg.db
      .select()
      .from(seasons)
      .where(and(eq(seasons.guildId, guildId), isNull(seasons.endedAt)));
    expect(open).toHaveLength(1);
  });

  /**
   * Сама гонка в тесте воспроизводится ненадёжно — окно между чтением и вставкой короткое.
   * Поэтому проверяем то, на чём держится защита: второй открытый сезон база не принимает.
   */
  it('второй открытый сезон база не принимает', async () => {
    const progression = createProgressionService({ db: pg.db });
    const guildId = '770000000000000003';
    await progression.currentSeason(guildId);

    await expect(pg.db.insert(seasons).values({ guildId, name: 'Лишний' })).rejects.toThrow();
  });

  it('смена сезона по-прежнему работает: старый закрыт, новый открыт', async () => {
    const progression = createProgressionService({ db: pg.db });
    const guildId = '770000000000000002';
    const first = await progression.currentSeason(guildId);

    const closing = await progression.startSeason(guildId, 'Второй сезон');

    expect(closing.previous.id).toBe(first.id);
    expect((await progression.currentSeason(guildId)).id).toBe(closing.season.id);
  });
});
