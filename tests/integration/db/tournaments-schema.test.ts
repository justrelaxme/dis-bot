import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { tournamentPolls } from '../../../src/modules/tournaments/schema.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const ORGANIZER = '333333333333333333';

describe('схема tournament_polls', () => {
  it('сохраняет голосование и оставляет winnerGame/finalizedAt пустыми по умолчанию', async () => {
    const closesAt = new Date('2026-07-28T22:00:00.000Z');
    const [row] = await pg.db
      .insert(tournamentPolls)
      .values({
        guildId: GUILD,
        channelId: CHANNEL,
        messageId: 'msg-defaults',
        options: ['dota2', 'lol', 'tft', 'valorant'],
        closesAt,
        createdBy: ORGANIZER,
      })
      .returning();

    expect(row?.winnerGame).toBeNull();
    expect(row?.finalizedAt).toBeNull();
    expect(row?.options).toEqual(['dota2', 'lol', 'tft', 'valorant']);
    expect(row?.closesAt.toISOString()).toBe(closesAt.toISOString());
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.updatedAt).toBeInstanceOf(Date);
  });

  it('запрещает два голосования с одним и тем же messageId', async () => {
    await pg.db.insert(tournamentPolls).values({
      guildId: GUILD,
      channelId: CHANNEL,
      messageId: 'msg-dup',
      options: ['dota2'],
      closesAt: new Date(),
      createdBy: ORGANIZER,
    });

    await expect(
      pg.db.insert(tournamentPolls).values({
        guildId: GUILD,
        channelId: CHANNEL,
        messageId: 'msg-dup',
        options: ['lol'],
        closesAt: new Date(),
        createdBy: ORGANIZER,
      }),
    ).rejects.toMatchObject({
      cause: { code: '23505', message: expect.stringMatching(/tournament_polls_message_uq/) },
    });
  });

  it('записывает победителя и время фиксации итога', async () => {
    const [row] = await pg.db
      .insert(tournamentPolls)
      .values({
        guildId: GUILD,
        channelId: CHANNEL,
        messageId: 'msg-winner',
        options: ['dota2', 'lol'],
        closesAt: new Date(),
        createdBy: ORGANIZER,
      })
      .returning();
    const pollId = row?.id;
    if (pollId === undefined) throw new Error('голосование не создано');

    await pg.db.update(tournamentPolls).set({ winnerGame: 'dota2', finalizedAt: new Date() }).where(eq(tournamentPolls.id, pollId));

    const [updated] = await pg.db.select().from(tournamentPolls).where(eq(tournamentPolls.id, pollId));
    expect(updated?.winnerGame).toBe('dota2');
    expect(updated?.finalizedAt).not.toBeNull();
  });

  it('допускает finalizedAt без winnerGame — ничья или ноль голосов, это не ошибка схемы', async () => {
    const [row] = await pg.db
      .insert(tournamentPolls)
      .values({
        guildId: GUILD,
        channelId: CHANNEL,
        messageId: 'msg-no-winner',
        options: ['tft', 'valorant'],
        closesAt: new Date(),
        createdBy: ORGANIZER,
      })
      .returning();
    const pollId = row?.id;
    if (pollId === undefined) throw new Error('голосование не создано');

    await pg.db.update(tournamentPolls).set({ finalizedAt: new Date() }).where(eq(tournamentPolls.id, pollId));

    const [updated] = await pg.db.select().from(tournamentPolls).where(eq(tournamentPolls.id, pollId));
    expect(updated?.finalizedAt).not.toBeNull();
    expect(updated?.winnerGame).toBeNull();
  });
});
