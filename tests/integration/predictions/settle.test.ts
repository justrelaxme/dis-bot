import { describe, expect, it } from 'vitest';
import { createPredictionsService } from '../../../src/modules/predictions/service.js';
import { createTournamentsService } from '../../../src/modules/tournaments/services/tournaments.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();

/**
 * Расчёт прогнозов. Проверяется против настоящего Postgres, потому что защита от двойной
 * выплаты стоит на условии в WHERE: отметка о выдаче ставится тем же обновлением, которое
 * проверяет её отсутствие. На заглушке это не проверяется вообще, а выданные монеты уже
 * потратят — отменить будет нечем.
 */

let counter = 0;

async function readyMatch() {
  counter += 1;
  const service = createTournamentsService({ db: pg.db });
  const guildId = `67000000000000${String(counter).padStart(4, '0')}`;

  const tournament = await service.create({
    guildId,
    name: `Прогнозы ${counter}`,
    game: 'dota2',
    format: 'single-elim',
    entryMode: 'solo',
    teamSize: 1,
    maxEntrants: 8,
    seeding: 'rank',
    bestOf: 1,
    requireVerified: false,
    createdBy: 'organizer',
  });
  await service.openRegistration(tournament.id, new Date(Date.now() + 3_600_000));

  const ids: number[] = [];
  const users: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const user = `68${String(counter).padStart(7, '0')}${String(index).padStart(7, '0')}`;
    const entrant = await service.createEntrant(tournament.id, user, `Игрок ${index + 1}`);
    await service.checkIn(tournament.id, user);
    ids.push(entrant.id);
    users.push(user);
  }
  const view = await service.start(tournament.id, new Map(ids.map((id, index) => [id, 1_000 - index])));
  const match = view.matches.find((row) => row.state === 'ready');
  if (!match) throw new Error('матч не построился');

  return { service, guildId, tournamentId: tournament.id, match, ids, users };
}

/** Начисления записываются, а не идут в прогрессию: тест про расчёт, а не про кошелёк. */
function ledger() {
  const paid: { userId: string; coins: number }[] = [];
  return {
    paid,
    grantCoins: async (_guildId: string, userId: string, coins: number): Promise<void> => {
      paid.push({ userId, coins });
    },
  };
}

describe('расчёт прогнозов', () => {
  it('угадавший получает монеты, не угадавший — ноль', async () => {
    const { service, guildId, match, ids } = await readyMatch();
    const book = ledger();
    const predictions = createPredictionsService({ db: pg.db, grantCoins: book.grantCoins });

    await predictions.predict(match.id, guildId, 'зритель-1', ids[0] as number);
    await predictions.predict(match.id, guildId, 'зритель-2', ids[1] as number);
    await service.settle(match.id, ids[0] as number, 'organizer', 'resolve', true);

    const settled = await predictions.settleDue(10);

    expect(settled.matches).toBe(1);
    expect(book.paid).toHaveLength(1);
    expect(book.paid[0]?.userId).toBe('зритель-1');
    expect(book.paid[0]?.coins).toBeGreaterThan(0);
  });

  /**
   * Главная проверка. Джоба идёт каждые пять минут, и наложение двух тиков не должно
   * заплатить дважды: отметка о выдаче ставится под условием её отсутствия.
   */
  it('повторный расчёт не платит второй раз', async () => {
    const { service, guildId, match, ids } = await readyMatch();
    const book = ledger();
    const predictions = createPredictionsService({ db: pg.db, grantCoins: book.grantCoins });

    await predictions.predict(match.id, guildId, 'зритель-1', ids[0] as number);
    await service.settle(match.id, ids[0] as number, 'organizer', 'resolve', true);

    await predictions.settleDue(10);
    const again = await predictions.settleDue(10);

    expect(again.paid, 'второй проход выдал монеты повторно').toBe(0);
    expect(book.paid).toHaveLength(1);
  });

  it('одновременные расчёты тоже платят один раз', async () => {
    const { service, guildId, match, ids } = await readyMatch();
    const book = ledger();
    const predictions = createPredictionsService({ db: pg.db, grantCoins: book.grantCoins });

    await predictions.predict(match.id, guildId, 'зритель-1', ids[0] as number);
    await service.settle(match.id, ids[0] as number, 'organizer', 'resolve', true);

    await Promise.all([predictions.settleDue(10), predictions.settleDue(10)]);

    expect(book.paid).toHaveLength(1);
  });

  it('незакрытый матч не рассчитывается', async () => {
    const { guildId, match, ids } = await readyMatch();
    const book = ledger();
    const predictions = createPredictionsService({ db: pg.db, grantCoins: book.grantCoins });

    await predictions.predict(match.id, guildId, 'зритель-1', ids[0] as number);
    const settled = await predictions.settleDue(10);

    expect(settled.matches).toBe(0);
    expect(book.paid).toEqual([]);
  });
});

describe('кто может дать прогноз', () => {
  it('второй прогноз на тот же матч не принимается', async () => {
    const { guildId, match, ids } = await readyMatch();
    const predictions = createPredictionsService({ db: pg.db, grantCoins: ledger().grantCoins });

    await predictions.predict(match.id, guildId, 'зритель-1', ids[0] as number);

    await expect(
      predictions.predict(match.id, guildId, 'зритель-1', ids[1] as number),
    ).rejects.toThrow(/уже дал/);
  });

  /** Участник матча его исход решает, а не угадывает. */
  it('игрок этого матча прогноз не даёт', async () => {
    const { guildId, match, ids, users } = await readyMatch();
    const predictions = createPredictionsService({ db: pg.db, grantCoins: ledger().grantCoins });

    await expect(
      predictions.predict(match.id, guildId, users[0] as string, ids[0] as number),
    ).rejects.toThrow(/решаешь/);
  });

  it('после заявки результата прогноз поздно', async () => {
    const { service, guildId, match, ids, users } = await readyMatch();
    const predictions = createPredictionsService({ db: pg.db, grantCoins: ledger().grantCoins });

    await service.report(match.id, users[0] as string, ids[0] as number);

    await expect(
      predictions.predict(match.id, guildId, 'зритель-1', ids[0] as number),
    ).rejects.toThrow(/поздно/);
  });

  it('прогноз на того, кто не играет в этом матче, не принимается', async () => {
    const { guildId, match } = await readyMatch();
    const predictions = createPredictionsService({ db: pg.db, grantCoins: ledger().grantCoins });

    await expect(predictions.predict(match.id, guildId, 'зритель-1', 999_999)).rejects.toThrow(
      /соперник/,
    );
  });
});
