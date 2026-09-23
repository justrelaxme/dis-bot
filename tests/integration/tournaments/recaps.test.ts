import { describe, expect, it } from 'vitest';
import { createCircuitService } from '../../../src/modules/tournaments/services/circuit.js';
import { createRecapsService } from '../../../src/modules/tournaments/services/recaps.js';
import { createTournamentsService } from '../../../src/modules/tournaments/services/tournaments.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();

/** Итог недели по настоящей базе: чемпионы, апсет и то, что неделя занимается один раз. */
describe('итог недели', () => {
  it('собирает чемпиона и апсет из доигранного турнира', async () => {
    const guildId = '860000000000000001';
    const service = createTournamentsService({ db: pg.db });
    const tournament = await service.create({
      guildId,
      name: 'Кубок недели',
      game: 'valorant',
      format: 'single-elim',
      entryMode: 'solo',
      teamSize: 1,
      maxEntrants: 4,
      seeding: 'rank',
      bestOf: 1,
      requireVerified: false,
      createdBy: 'organizer',
    });
    await service.openRegistration(tournament.id, new Date(Date.now() + 3_600_000));
    const ids: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const user = `86100000000000000${index}`;
      ids.push((await service.createEntrant(tournament.id, user, `Игрок ${index + 1}`)).id);
      await service.checkIn(tournament.id, user);
    }
    const view = await service.start(tournament.id, new Map(ids.map((id, index) => [id, 100 - index])));
    // Первый круг: в одном матче побеждает четвёртый сид — это и есть апсет.
    for (const match of view.matches.filter((row) => row.round === 1)) {
      const seedOf = (id: number) => view.entrants.find((entrant) => entrant.id === id)?.seed ?? 0;
      const weaker = seedOf(match.entrantAId!) > seedOf(match.entrantBId!) ? match.entrantAId! : match.entrantBId!;
      await service.resolve(match.id, 'organizer', weaker);
    }
    const final = (await service.bracket(tournament.id)).matches.find((row) => row.round === 2)!;
    await service.resolve(final.id, 'organizer', final.entrantAId!);

    const recaps = createRecapsService({ db: pg.db, circuit: createCircuitService({ db: pg.db }) });
    const now = new Date(Date.now() + 60_000);
    const week = await recaps.gather(guildId, new Date(now.getTime() - 7 * 86_400_000), now);

    expect(week.tournaments).toHaveLength(1);
    expect(week.tournaments[0]).toMatchObject({ name: 'Кубок недели', entrants: 4 });
    expect(week.upset?.winnerSeed).toBe(4);
    expect(week.upset?.loserSeed).toBe(1);
    expect(await recaps.guildsWithFinished(new Date(now.getTime() - 7 * 86_400_000), now)).toContain(guildId);
  });

  it('неделя занимается один раз, а отданная — снова свободна', async () => {
    const recaps = createRecapsService({ db: pg.db, circuit: createCircuitService({ db: pg.db }) });

    expect(await recaps.claim('860000000000000002', '2026-09-28')).toBe(true);
    expect(await recaps.claim('860000000000000002', '2026-09-28')).toBe(false);
    await recaps.release('860000000000000002', '2026-09-28');
    expect(await recaps.claim('860000000000000002', '2026-09-28')).toBe(true);
  });
});
