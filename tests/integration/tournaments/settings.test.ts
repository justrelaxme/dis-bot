import { describe, expect, it } from 'vitest';
import { createTournamentSettingsService } from '../../../src/modules/tournaments/services/settings.js';
import { createTournamentsService } from '../../../src/modules/tournaments/services/tournaments.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();

/**
 * Настройки турниров: роль организаторов и канал штаба. Правка по полям — поменять канал,
 * не задев роль, должно быть можно без того, чтобы указывать роль заново.
 */
describe('настройки турниров сервера', () => {
  it('по умолчанию настроек нет', async () => {
    const settings = createTournamentSettingsService({ db: pg.db });
    await expect(settings.get('730000000000000001')).resolves.toBeNull();
  });

  it('правка одного поля не трогает другое', async () => {
    const settings = createTournamentSettingsService({ db: pg.db });
    const guildId = '730000000000000002';

    await settings.update(guildId, { organizerRoleId: 'role-1' });
    const saved = await settings.update(guildId, { staffChannelId: 'staff-1' });

    expect(saved.organizerRoleId).toBe('role-1');
    expect(saved.staffChannelId).toBe('staff-1');
  });

  it('null сбрасывает поле', async () => {
    const settings = createTournamentSettingsService({ db: pg.db });
    const guildId = '730000000000000003';

    await settings.update(guildId, { organizerRoleId: 'role-1', staffChannelId: 'staff-1' });
    const saved = await settings.update(guildId, { organizerRoleId: null });

    expect(saved.organizerRoleId).toBeNull();
    expect(saved.staffChannelId).toBe('staff-1');
  });
});

/** Замена посреди турнира должна попасть в ветку матча, который её команда сейчас играет. */
describe('ветки незакрытых матчей участника', () => {
  it('отдаёт ветку идущего матча и не отдаёт закрытого', async () => {
    const service = createTournamentsService({ db: pg.db });
    const tournament = await service.create({
      guildId: '730000000000000010',
      name: 'Замены',
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
    for (let index = 0; index < 4; index += 1) {
      const user = `74000000000000000${index}`;
      ids.push((await service.createEntrant(tournament.id, user, `Игрок ${index + 1}`)).id);
      await service.checkIn(tournament.id, user);
    }
    const view = await service.start(tournament.id, new Map(ids.map((id, index) => [id, 100 - index])));
    const [first, second] = view.matches.filter((match) => match.round === 1);
    await service.attachThread(first!.id, 'thread-live');
    await service.attachThread(second!.id, 'thread-closed');
    await service.resolve(second!.id, 'organizer', second!.entrantAId!);

    const liveSide = first!.entrantAId!;
    const closedSide = second!.entrantAId!;

    await expect(service.openThreadsOf(liveSide)).resolves.toEqual(['thread-live']);
    // У победителя закрытого матча следующий матч ещё без ветки — а закрытая ветка не нужна.
    await expect(service.openThreadsOf(closedSide)).resolves.toEqual([]);
  });
});
