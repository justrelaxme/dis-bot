import { describe, expect, it } from 'vitest';
import { createCircuitService } from '../../../src/modules/tournaments/services/circuit.js';
import { createTournamentsService } from '../../../src/modules/tournaments/services/tournaments.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();

/**
 * Сезонная серия по настоящей сетке: доигранный турнир начисляет очки всем, кто играл, один
 * раз, и только пока сезон открыт.
 */

let counter = 0;

async function finishedTournament(guildId: string, players: number) {
  counter += 1;
  const service = createTournamentsService({ db: pg.db });
  const tournament = await service.create({
    guildId,
    name: `Неделя ${counter}`,
    game: 'dota2',
    format: 'single-elim',
    entryMode: 'solo',
    teamSize: 1,
    maxEntrants: 16,
    seeding: 'rank',
    bestOf: 1,
    requireVerified: false,
    createdBy: 'organizer',
  });
  await service.openRegistration(tournament.id, new Date(Date.now() + 3_600_000));
  const ids: number[] = [];
  const users: string[] = [];
  for (let index = 0; index < players; index += 1) {
    const user = `83${String(counter).padStart(8, '0')}${String(index).padStart(8, '0')}`;
    ids.push((await service.createEntrant(tournament.id, user, `Игрок ${index + 1}`)).id);
    users.push(user);
    await service.checkIn(tournament.id, user);
  }
  await service.start(tournament.id, new Map(ids.map((id, index) => [id, 1_000 - index])));
  // Побеждает старший сеяный — первый созданный.
  for (let guard = 0; guard < 50; guard += 1) {
    const view = await service.bracket(tournament.id);
    const next = view.matches.find((match) => match.state === 'ready');
    if (!next) break;
    const seedOf = (id: number): number => view.entrants.find((entrant) => entrant.id === id)?.seed ?? 99;
    const winner = seedOf(next.entrantAId!) <= seedOf(next.entrantBId!) ? next.entrantAId! : next.entrantBId!;
    await service.settle(next.id, winner, 'organizer', 'resolve', true);
  }
  return { tournamentId: tournament.id, users };
}

/** Дуэль двух заданных игроков: побеждает `winner`. Турнир доигран, очки ещё не начислены. */
async function duel(guildId: string, users: [string, string], winner: 0 | 1, entryMode: 'solo' | 'team' = 'solo') {
  counter += 1;
  const service = createTournamentsService({ db: pg.db });
  const tournament = await service.create({
    guildId,
    name: `Дуэль ${counter}`,
    game: 'dota2',
    format: 'single-elim',
    entryMode,
    teamSize: 1,
    maxEntrants: 4,
    seeding: 'rank',
    bestOf: 1,
    requireVerified: false,
    createdBy: 'organizer',
  });
  await service.openRegistration(tournament.id, new Date(Date.now() + 3_600_000));
  const ids: number[] = [];
  for (const user of users) {
    ids.push((await service.createEntrant(tournament.id, user, entryMode === 'solo' ? `Игрок ${user.slice(-2)}` : `Команда ${user.slice(-2)}`)).id);
    await service.checkIn(tournament.id, user);
  }
  const view = await service.start(tournament.id, new Map(ids.map((id, index) => [id, 10 - index])));
  await service.resolve(view.matches[0]!.id, 'organizer', ids[winner]!);
  return tournament.id;
}

describe('сезонная серия', () => {
  it('без открытого сезона очки не начисляются', async () => {
    const circuit = createCircuitService({ db: pg.db });
    const { tournamentId } = await finishedTournament('840000000000000001', 4);

    expect((await circuit.award(tournamentId)).awarded).toBe(0);
  });

  it('доигранный турнир даёт очки всем, кто играл, и только один раз', async () => {
    const circuit = createCircuitService({ db: pg.db });
    const guildId = '840000000000000002';
    const season = await circuit.start(guildId, 'Осень');
    const { tournamentId, users } = await finishedTournament(guildId, 4);

    expect((await circuit.award(tournamentId)).awarded).toBe(4);
    expect((await circuit.award(tournamentId)).awarded).toBe(0);

    const table = await circuit.standings(season.id);
    expect(table).toHaveLength(4);
    // Чемпион четверых: трое позади, одно за участие, пять за титул.
    expect(table[0]).toMatchObject({ userId: users[0], points: 9, titles: 1, best: 1 });
    expect(table[0]?.name).toBe('Игрок 1');
  });

  it('очки копятся за сезон, а чемпион — лидер при закрытии', async () => {
    const circuit = createCircuitService({ db: pg.db });
    const guildId = '840000000000000003';
    await circuit.start(guildId, 'Зима');
    const first = await finishedTournament(guildId, 4);
    const second = await finishedTournament(guildId, 8);
    await circuit.award(first.tournamentId);
    await circuit.award(second.tournamentId);

    const { season, table } = await circuit.close(guildId);

    // Победа в большом поле стоит больше — лидер тот, кто выиграл восьмерых.
    expect(table[0]?.userId).toBe(second.users[0]);
    expect(season.championUserId).toBe(second.users[0]);
    expect(await circuit.open(guildId)).toBeNull();
    expect((await circuit.champions(guildId))[0]?.name).toBe('Зима');
  });

  it('ничья на вершине: сам чемпиона не назначает, по явному выбору — только из равных', async () => {
    const circuit = createCircuitService({ db: pg.db });
    const guildId = '840000000000000005';
    const a = '841000000000000051';
    const b = '841000000000000052';
    const outsider = '841000000000000053';
    await circuit.start(guildId, 'Ничья');
    await circuit.award(await duel(guildId, [a, b], 0));
    await circuit.award(await duel(guildId, [a, b], 1));

    // По 8 очков, по титулу, лучшее место — первое у обоих: правила чемпиона не называют.
    await expect(circuit.close(guildId)).rejects.toThrow(/Первое место делят/);
    await expect(circuit.close(guildId, { pick: outsider })).rejects.toThrow(/только одного из делящих/);
    expect(await circuit.open(guildId)).not.toBeNull();

    const { season, table } = await circuit.close(guildId, { pick: b });
    expect(season.championUserId).toBe(b);
    expect(table[0]?.userId).toBe(b);
  });

  it('при одном лидере выбрать чемпиона руками нельзя', async () => {
    const circuit = createCircuitService({ db: pg.db });
    const guildId = '840000000000000006';
    const a = '841000000000000061';
    const b = '841000000000000062';
    await circuit.start(guildId, 'Без ничьей');
    await circuit.award(await duel(guildId, [a, b], 0));

    await expect(circuit.close(guildId, { pick: b })).rejects.toThrow(/лидер один/);
  });

  it('потерянное начисление страховка находит, а начисленное — нет', async () => {
    const circuit = createCircuitService({ db: pg.db });
    const guildId = '840000000000000007';
    // Турнир до начала сезона не в счёт: сезон — с момента старта.
    const before = await duel(guildId, ['841000000000000071', '841000000000000072'], 0);
    await circuit.start(guildId, 'Страховка');
    const lost = await duel(guildId, ['841000000000000071', '841000000000000072'], 0);
    const counted = await duel(guildId, ['841000000000000071', '841000000000000072'], 1);
    await circuit.award(counted);

    const pending = await circuit.unawarded(100);
    expect(pending).toContain(lost);
    expect(pending).not.toContain(counted);
    expect(pending).not.toContain(before);

    await circuit.award(lost);
    expect(await circuit.unawarded(100)).not.toContain(lost);
  });

  it('игрок команды без имени получает его при закрытии — чемпион уходит в зал славы по имени', async () => {
    const circuit = createCircuitService({ db: pg.db });
    const guildId = '840000000000000008';
    const captain = '841000000000000081';
    await circuit.start(guildId, 'Команды');
    await circuit.award(await duel(guildId, [captain, '841000000000000082'], 0, 'team'));
    expect((await circuit.unnamed(100)).some((row) => row.userId === captain)).toBe(true);

    const { season } = await circuit.close(guildId, { names: new Map([[captain, 'Капитан Медведей']]) });

    expect(season.championName).toBe('Капитан Медведей');
  });

  it('второй сезон, пока идёт первый, не начинается', async () => {
    const circuit = createCircuitService({ db: pg.db });
    const guildId = '840000000000000004';
    await circuit.start(guildId, 'Весна');

    await expect(circuit.start(guildId, 'Лето')).rejects.toThrow(/ещё идёт/);
  });
});
