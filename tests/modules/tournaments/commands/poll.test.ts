import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../../src/core/config.js';
import { UserError } from '../../../../src/core/errors.js';
import { createLogger } from '../../../../src/core/logger.js';
import type { ModuleContext } from '../../../../src/core/module.js';
import { createTournamentPollCommand } from '../../../../src/modules/tournaments/commands/poll.js';
import type { PollsService, TournamentPollRow } from '../../../../src/modules/tournaments/services/polls.js';
import { fakeChatInputInteraction } from '../../../helpers/interaction.js';

const ctx = { logger: createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config) } as unknown as ModuleContext;

function fakePolls() {
  return {
    createPoll: vi.fn<PollsService['createPoll']>(async (input) => ({
      id: 1,
      guildId: input.guildId,
      channelId: input.channelId,
      messageId: input.messageId,
      options: [...input.options],
      closesAt: input.closesAt,
      winnerGame: null,
      finalizedAt: null,
      createdBy: input.createdBy,
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as TournamentPollRow),
    findDue: vi.fn<PollsService['findDue']>(async () => []),
    claimOutcome: vi.fn<PollsService['claimOutcome']>(async () => null),
    revertClaim: vi.fn<PollsService['revertClaim']>(async () => {}),
  };
}

interface PollEditReplyPayload {
  content: string;
  poll: {
    question: { text: string };
    answers: Array<{ text: string }>;
    duration: number;
    allowMultiselect: boolean;
  };
}

interface FakeEditReplyMessage {
  id: string;
  channelId: string;
  poll: { expiresAt: Date | null } | null;
}

function interactionWith(options: {
  hours?: number;
  guild?: unknown;
  editReplyResult?: FakeEditReplyMessage;
}) {
  const fake = fakeChatInputInteraction('tournament');
  const hours = options.hours ?? 3;

  Object.defineProperty(fake.interaction, 'options', {
    value: {
      getSubcommand: () => 'poll',
      getInteger: (name: string, required?: boolean) => {
        if (name === 'hours') return hours;
        if (required) throw new Error(`опция ${name} обязательна`);
        return null;
      },
    },
  });

  Object.defineProperty(fake.interaction, 'guild', {
    value: options.guild === undefined ? { id: '111111111111111111' } : options.guild,
    configurable: true,
  });

  const editReplyResult: FakeEditReplyMessage = options.editReplyResult ?? {
    id: '900000000000000099',
    channelId: '333333333333333333',
    poll: { expiresAt: new Date('2026-07-28T21:00:00.000Z') },
  };
  const editReply = vi.fn<(payload: PollEditReplyPayload) => Promise<FakeEditReplyMessage>>(async () => editReplyResult);
  Object.defineProperty(fake.interaction, 'editReply', { value: editReply, configurable: true });

  return { interaction: fake.interaction, editReply };
}

describe('/tournament poll', () => {
  it('требует право «Управление сервером»', () => {
    const command = createTournamentPollCommand({ polls: fakePolls() as never });
    const json = command.builder.toJSON();
    expect(json.default_member_permissions).toBe(String(PermissionFlagsBits.ManageGuild));
  });

  it('объявляет подкоманду poll с обязательным целым числом часов не меньше одного', () => {
    const command = createTournamentPollCommand({ polls: fakePolls() as never });
    const json = command.builder.toJSON();
    const poll = json.options?.find((o) => o.name === 'poll') as
      | { options?: Array<{ name: string; required?: boolean; min_value?: number; type?: number }> }
      | undefined;
    const hoursOption = poll?.options?.find((o) => o.name === 'hours');

    expect(hoursOption?.required).toBe(true);
    expect(hoursOption?.min_value).toBe(1);
  });

  it('делает публичный (неэфемерный) defer — итоговое голосование должно быть видно всем', () => {
    const command = createTournamentPollCommand({ polls: fakePolls() as never });
    expect(command.defer).toEqual({ ephemeral: false });
  });

  it('превращает отложенный ответ в нативное голосование с четырьмя дисциплинами и заданной длительностью', async () => {
    const command = createTournamentPollCommand({ polls: fakePolls() as never });
    const { interaction, editReply } = interactionWith({ hours: 5 });

    await command.execute(interaction, ctx);

    expect(editReply).toHaveBeenCalledTimes(1);
    const payload = editReply.mock.calls[0]?.[0];
    expect(payload?.poll.question.text).toBe('По какой дисциплине проводим турнир?');
    expect(payload?.poll.answers.map((a) => a.text)).toEqual([
      'Dota 2',
      'League of Legends',
      'Teamfight Tactics',
      'Valorant',
    ]);
    expect(payload?.poll.duration).toBe(5);
    expect(payload?.poll.allowMultiselect).toBe(false);
  });

  it('сохраняет голосование в БД с guildId, channelId, messageId и сроком закрытия из ответа Discord', async () => {
    const polls = fakePolls();
    const command = createTournamentPollCommand({ polls: polls as never });
    const { interaction } = interactionWith({
      hours: 5,
      editReplyResult: { id: 'msg-42', channelId: 'chan-7', poll: { expiresAt: new Date('2026-07-28T23:00:00.000Z') } },
    });

    await command.execute(interaction, ctx);

    expect(polls.createPoll).toHaveBeenCalledWith({
      guildId: '111111111111111111',
      channelId: 'chan-7',
      messageId: 'msg-42',
      options: ['dota2', 'lol', 'tft', 'valorant'],
      closesAt: new Date('2026-07-28T23:00:00.000Z'),
      createdBy: '222222222222222222',
    });
  });

  it('считает срок закрытия по числу часов, если Discord не вернул expiresAt', async () => {
    const polls = fakePolls();
    const command = createTournamentPollCommand({ polls: polls as never });
    const before = Date.now();
    const { interaction } = interactionWith({ hours: 2, editReplyResult: { id: 'msg-1', channelId: 'chan-1', poll: null } });

    await command.execute(interaction, ctx);

    const call = polls.createPoll.mock.calls[0]?.[0];
    expect(call?.closesAt.getTime()).toBeGreaterThanOrEqual(before + 2 * 3_600_000 - 2_000);
    expect(call?.closesAt.getTime()).toBeLessThanOrEqual(Date.now() + 2 * 3_600_000 + 2_000);
  });

  it('отказывает вне сервера и не трогает БД', async () => {
    const polls = fakePolls();
    const command = createTournamentPollCommand({ polls: polls as never });
    const { interaction } = interactionWith({ guild: null });

    await expect(command.execute(interaction, ctx)).rejects.toThrow(UserError);
    expect(polls.createPoll).not.toHaveBeenCalled();
  });

  it('отказывает при часах меньше одного и не трогает БД', async () => {
    const polls = fakePolls();
    const command = createTournamentPollCommand({ polls: polls as never });
    const { interaction } = interactionWith({ hours: 0 });

    await expect(command.execute(interaction, ctx)).rejects.toThrow(UserError);
    expect(polls.createPoll).not.toHaveBeenCalled();
  });
});
