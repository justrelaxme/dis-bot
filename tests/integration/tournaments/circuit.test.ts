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

  it('второй сезон, пока идёт первый, не начинается', async () => {
    const circuit = createCircuitService({ db: pg.db });
    const guildId = '840000000000000004';
    await circuit.start(guildId, 'Весна');

    await expect(circuit.start(guildId, 'Лето')).rejects.toThrow(/ещё идёт/);
  });
});
