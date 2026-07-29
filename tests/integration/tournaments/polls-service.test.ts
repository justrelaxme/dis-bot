import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { tournamentPolls } from '../../../src/modules/tournaments/schema.js';
import { createPollsService } from '../../../src/modules/tournaments/services/polls.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const ORGANIZER = '333333333333333333';

async function createDuePoll(messageId: string, closesAt = new Date(Date.now() - 60_000)) {
  const service = createPollsService({ db: pg.db });
  return service.createPoll({
    guildId: GUILD,
    channelId: CHANNEL,
    messageId,
    options: ['dota2', 'lol', 'tft', 'valorant'],
    closesAt,
    createdBy: ORGANIZER,
  });
}

describe('PollsService', () => {
  it('createPoll сохраняет голосование и возвращает вставленную строку', async () => {
    const service = createPollsService({ db: pg.db });
    const row = await service.createPoll({
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: 'create-1',
      options: ['dota2', 'valorant'],
      closesAt: new Date('2026-07-28T20:00:00.000Z'),
      createdBy: ORGANIZER,
    });

    expect(row.id).toBeGreaterThan(0);
    expect(row.options).toEqual(['dota2', 'valorant']);
    expect(row.winnerGame).toBeNull();
    expect(row.finalizedAt).toBeNull();
  });

  it('findDue находит только просроченные и ещё не зафиксированные голосования', async () => {
    const service = createPollsService({ db: pg.db });
    const due = await createDuePoll('due-1');
    await createDuePoll('not-due-1', new Date(Date.now() + 3_600_000));
    const alreadyFinalized = await createDuePoll('finalized-1');
    await service.claimOutcome(alreadyFinalized.id, 'dota2');

    const foundIds = (await service.findDue(new Date(), 100)).map((row) => row.id);

    expect(foundIds).toContain(due.id);
    expect(foundIds).not.toContain(alreadyFinalized.id);
  });

  it('НЕ даёт объявить итог дважды: второй claimOutcome по тому же id получает null и не переписывает победителя', async () => {
    // Это и есть гарантия «нельзя объявить итог дважды» из требований: она держится
    // на условии WHERE finalized_at IS NULL внутри claimOutcome. Мутационная проверка
    // №1 в отчёте — снять именно это условие и убедиться, что этот тест падает.
    const service = createPollsService({ db: pg.db });
    const poll = await createDuePoll('claim-once');

    const first = await service.claimOutcome(poll.id, 'lol');
    const second = await service.claimOutcome(poll.id, 'dota2');

    expect(first?.winnerGame).toBe('lol');
    expect(first?.finalizedAt).not.toBeNull();
    expect(second).toBeNull();

    const [stored] = await pg.db.select().from(tournamentPolls).where(eq(tournamentPolls.id, poll.id));
    expect(stored?.winnerGame).toBe('lol');
  });

  it('при гонке двух одновременных claimOutcome побеждает ровно один вызов', async () => {
    const service = createPollsService({ db: pg.db });
    const poll = await createDuePoll('race-1');

    const [a, b] = await Promise.all([service.claimOutcome(poll.id, 'dota2'), service.claimOutcome(poll.id, 'lol')]);

    const winners = [a, b].filter((result) => result !== null);
    expect(winners).toHaveLength(1);
  });

  it('claimOutcome с null победителем фиксирует итог (ничья или ноль голосов) без ошибки', async () => {
    const service = createPollsService({ db: pg.db });
    const poll = await createDuePoll('no-winner-1');

    const claimed = await service.claimOutcome(poll.id, null);

    expect(claimed?.winnerGame).toBeNull();
    expect(claimed?.finalizedAt).not.toBeNull();
  });

  it('revertClaim снимает финализацию, и findDue снова подбирает голосование', async () => {
    const service = createPollsService({ db: pg.db });
    const poll = await createDuePoll('revert-1');
    await service.claimOutcome(poll.id, 'tft');

    await service.revertClaim(poll.id);

    const foundAgain = (await service.findDue(new Date(), 100)).find((row) => row.id === poll.id);
    expect(foundAgain?.winnerGame).toBeNull();
    expect(foundAgain?.finalizedAt).toBeNull();
  });
});
