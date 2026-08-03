import { describe, expect, it } from 'vitest';
import { createTournamentsService } from '../../../src/modules/tournaments/services/tournaments.js';
import { createMessagesService } from '../../../src/modules/tournaments/services/messages.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();

/**
 * Учёт сообщений турнира. Проверяется против настоящего Postgres, потому что вся защита от
 * повторной записи здесь построена на уникальности `(channelId, messageId)` — на заглушке
 * она не проверяется вообще.
 *
 * Главное свойство: **сор удаляется, запись остаётся.** Ошибка в эту сторону дороже, чем в
 * обратную: неубранная панель регистрации это неудобство, а стёртый итог турнира — потеря
 * летописи, которую взять больше негде.
 */

let counter = 0;

async function makeTournament(): Promise<number> {
  counter += 1;
  const service = createTournamentsService({ db: pg.db });
  const tournament = await service.create({
    guildId: `61000000000000${String(counter).padStart(4, '0')}`,
    name: `Турнир ${counter}`,
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
  return tournament.id;
}

describe('учёт сообщений турнира', () => {
  it('к уборке идёт сор, а запись остаётся', async () => {
    const messages = createMessagesService({ db: pg.db });
    const tournamentId = await makeTournament();

    await messages.remember(tournamentId, { channelId: 'c1', messageId: 'панель' }, { transient: true });
    await messages.remember(tournamentId, { channelId: 'c1', messageId: 'напоминание' }, { transient: true });
    await messages.remember(tournamentId, { channelId: 'c1', messageId: 'итог' }, { transient: false });

    const sweepable = await messages.sweepable(tournamentId);

    expect(sweepable.map((message) => message.messageId).sort()).toEqual(['напоминание', 'панель']);
  });

  /**
   * Джобы идемпотентны, и один и тот же вызов может дойти дважды. Вторая запись того же
   * сообщения не должна ни падать, ни удваивать его в списке уборки.
   */
  it('повторная запись того же сообщения ничего не меняет', async () => {
    const messages = createMessagesService({ db: pg.db });
    const tournamentId = await makeTournament();

    await messages.remember(tournamentId, { channelId: 'c2', messageId: 'm1' }, { transient: true });
    await messages.remember(tournamentId, { channelId: 'c2', messageId: 'm1' }, { transient: true });

    expect(await messages.sweepable(tournamentId)).toHaveLength(1);
  });

  it('забытое сообщение больше не предлагается к уборке', async () => {
    const messages = createMessagesService({ db: pg.db });
    const tournamentId = await makeTournament();

    await messages.remember(tournamentId, { channelId: 'c3', messageId: 'm1' }, { transient: true });
    await messages.forget({ channelId: 'c3', messageId: 'm1' });

    expect(await messages.sweepable(tournamentId)).toEqual([]);
  });

  it('сообщения чужого турнира не попадают в уборку', async () => {
    const messages = createMessagesService({ db: pg.db });
    const mine = await makeTournament();
    const other = await makeTournament();

    await messages.remember(mine, { channelId: 'c4', messageId: 'моё' }, { transient: true });
    await messages.remember(other, { channelId: 'c4', messageId: 'чужое' }, { transient: true });

    expect((await messages.sweepable(mine)).map((message) => message.messageId)).toEqual(['моё']);
  });

  /**
   * Турнир удалён — записи о его сообщениях уходят вместе с ним. Иначе таблица росла бы
   * вечно, храня идентификаторы сообщений, которые уже некому убирать.
   */
  it('удаление турнира уносит записи о его сообщениях', async () => {
    const messages = createMessagesService({ db: pg.db });
    const tournamentId = await makeTournament();
    await messages.remember(tournamentId, { channelId: 'c5', messageId: 'm1' }, { transient: true });

    await pg.db.execute(`delete from tournaments where id = ${tournamentId}`);

    expect(await messages.sweepable(tournamentId)).toEqual([]);
  });
});
