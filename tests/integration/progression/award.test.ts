import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { COINS_PER_LEVEL, levelFromXp } from '../../../src/modules/progression/rules.js';
import { xpEvents } from '../../../src/modules/progression/schema.js';
import { createProgressionService } from '../../../src/modules/progression/service.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();

let counter = 0;

/**
 * Человек с уже заведённым профилем. Заводим заранее, а не первым из параллельных
 * начислений: первое обращение сервера ещё и открывает сезон, а это другая история, не
 * про сложение опыта.
 */
async function someone() {
  counter += 1;
  const progression = createProgressionService({ db: pg.db });
  const guildId = `76${String(counter).padStart(15, '0')}`;
  const userId = `77${String(counter).padStart(15, '0')}`;
  await progression.profile(guildId, userId);
  return { progression, guildId, userId };
}

/**
 * Начисления против настоящего Postgres: гонка живёт в том, как UPDATE запирает строку, и
 * на заглушке её не увидеть. Сообщение, голос и турнир начисляют одному человеку
 * одновременно — это обычный вечер, а не крайний случай.
 */
describe('начисление опыта', () => {
  it('двадцать одновременных начислений складываются все', async () => {
    const { progression, guildId, userId } = await someone();

    await Promise.all(Array.from({ length: 20 }, () => progression.award(guildId, userId, 10, 'message')));

    const profile = await progression.profile(guildId, userId);
    expect(profile.xp).toBe(200);

    const journal = await pg.db
      .select({ total: sql<number>`sum(${xpEvents.amount})::int` })
      .from(xpEvents)
      .where(and(eq(xpEvents.guildId, guildId), eq(xpEvents.userId, userId)));
    expect(journal[0]?.total).toBe(200);
  });

  it('каждый уровень перешагивается ровно одним начислением и платит монеты один раз', async () => {
    const { progression, guildId, userId } = await someone();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => progression.award(guildId, userId, 30, 'voice')),
    );

    const profile = await progression.profile(guildId, userId);
    const level = levelFromXp(600);
    expect(profile.xp).toBe(600);
    expect(profile.level).toBe(level);
    expect(results.flatMap((result) => result.levelsGained).sort((a, b) => a - b)).toEqual(
      Array.from({ length: level }, (_, index) => index + 1),
    );
    expect(profile.coins).toBe(level * COINS_PER_LEVEL);
  });

  it('монеты, начисленные параллельно с опытом, не затираются', async () => {
    const { progression, guildId, userId } = await someone();

    await Promise.all([
      ...Array.from({ length: 10 }, () => progression.award(guildId, userId, 30, 'message')),
      ...Array.from({ length: 10 }, () => progression.grantCoins(guildId, userId, 7, 'прогноз')),
    ]);

    const profile = await progression.profile(guildId, userId);
    expect(profile.xp).toBe(300);
    expect(profile.coins).toBe(70 + levelFromXp(300) * COINS_PER_LEVEL);
  });

  it('снятие опыта упирается в ноль и опускает уровень без монет', async () => {
    const { progression, guildId, userId } = await someone();
    await progression.award(guildId, userId, 150, 'admin');

    const result = await progression.award(guildId, userId, -500, 'admin');

    expect(result.profile.xp).toBe(0);
    expect(result.profile.level).toBe(0);
    expect(result.levelsGained).toEqual([]);
    expect(result.profile.coins).toBe(COINS_PER_LEVEL);
  });

  it('счётчики сообщений и минут не теряют одновременных прибавок', async () => {
    const { progression, guildId, userId } = await someone();

    await Promise.all([
      ...Array.from({ length: 15 }, () => progression.countMessage(guildId, userId)),
      ...Array.from({ length: 15 }, () => progression.addVoiceMinutes(guildId, userId, 2)),
    ]);

    const profile = await progression.profile(guildId, userId);
    expect(profile.messages).toBe(15);
    expect(profile.voiceMinutes).toBe(30);
  });
});

/** Поправка баланса в минус не уводит его ниже нуля: монеты могли быть уже потрачены. */
describe('поправка баланса', () => {
  it('вычет больше баланса оставляет ноль, а не долг', async () => {
    const progression = createProgressionService({ db: pg.db });
    const guildId = '790000000000000001';
    const userId = '790000000000000002';
    await progression.grantCoins(guildId, userId, 30, 'тест');

    await progression.adjustCoins(guildId, userId, -50, 'пересчёт');

    expect((await progression.profile(guildId, userId)).coins).toBe(0);
  });

  it('прибавка работает как начисление', async () => {
    const progression = createProgressionService({ db: pg.db });
    const guildId = '790000000000000003';
    const userId = '790000000000000004';

    await progression.adjustCoins(guildId, userId, 25, 'пересчёт');

    expect((await progression.profile(guildId, userId)).coins).toBe(25);
  });
});
