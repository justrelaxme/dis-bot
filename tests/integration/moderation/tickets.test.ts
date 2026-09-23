import {
  ChannelType,
  DiscordAPIError,
  RESTJSONErrorCodes,
  type ActionRowBuilder,
  type ButtonBuilder,
  type ChatInputCommandInteraction,
  type ClientEvents,
} from 'discord.js';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Cache } from '../../../src/core/cache.js';
import type { Config } from '../../../src/core/config.js';
import { UserError } from '../../../src/core/errors.js';
import { createLogger } from '../../../src/core/logger.js';
import type { EventHandler, ModuleContext } from '../../../src/core/module.js';
import { createModerationModule } from '../../../src/modules/moderation/index.js';
import { tickets } from '../../../src/modules/moderation/schema.js';
import { createModerationService } from '../../../src/modules/moderation/service.js';
import { fakeChatInputInteraction } from '../../helpers/interaction.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

// Кэш нужен только антиспаму; тикеты его не трогают.
const cache = {} as Cache;

let counter = 0;

/** Сервер, автор тикета и id его ветки — у каждого теста свои. */
function ids() {
  counter += 1;
  const n = String(counter).padStart(15, '0');
  return { guildId: `81${n}`, userId: `82${n}`, threadId: `83${n}` };
}

async function openedTicket() {
  const moderation = createModerationService({ db: pg.db, cache });
  const { guildId, userId, threadId } = ids();
  const ticket = await moderation.openTicket({ guildId, userId, threadId, topic: 'жалоба' });
  return { moderation, guildId, userId, threadId, ticket };
}

async function ticketRow(id: number) {
  const [row] = await pg.db.select().from(tickets).where(eq(tickets.id, id));
  return row;
}

function fakeThread(id: string) {
  return {
    id,
    archived: false,
    isThread: () => true,
    send: vi.fn(async () => ({})),
    setLocked: vi.fn(async () => ({})),
    setArchived: vi.fn(async () => ({})),
  };
}

function moduleParts() {
  const module = createModerationModule({ db: pg.db, cache });
  const event = <K extends 'interactionCreate' | 'threadUpdate'>(name: K) => {
    const handler = module.events?.find((candidate) => candidate.event === name);
    if (!handler) throw new Error(`модуль не слушает ${name}`);
    return handler as unknown as EventHandler<K>;
  };
  const command = module.commands?.find((candidate) => candidate.builder.name === 'ticket');
  if (!command) throw new Error('команды /ticket нет');
  return { module, event, command };
}

function ticketInteraction(input: {
  subcommand: 'open' | 'close';
  guildId: string;
  userId: string;
  channelId: string;
  channel?: unknown;
  topic?: string;
  moderator?: boolean;
}): { interaction: ChatInputCommandInteraction; editReply: ReturnType<typeof vi.fn> } {
  const fake = fakeChatInputInteraction('ticket');
  const values: Record<string, unknown> = {
    options: {
      getSubcommand: () => input.subcommand,
      getString: () => input.topic ?? null,
    },
    inGuild: () => true,
    guildId: input.guildId,
    channelId: input.channelId,
    channel: input.channel ?? null,
    user: { id: input.userId, tag: 'игрок' },
    memberPermissions: { has: () => input.moderator ?? false },
  };
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(fake.interaction, key, { value });
  }
  return { interaction: fake.interaction, editReply: fake.calls.editReply };
}

/** Событие правки ветки: была ли она в архиве до и после. */
function threadChange(threadId: string, before: boolean, after: boolean): ClientEvents['threadUpdate'] {
  return [
    { id: threadId, archived: before },
    { id: threadId, archived: after },
  ] as unknown as ClientEvents['threadUpdate'];
}

function unknownChannel(): DiscordAPIError {
  return new DiscordAPIError(
    { message: 'Unknown Channel', code: RESTJSONErrorCodes.UnknownChannel },
    RESTJSONErrorCodes.UnknownChannel,
    404,
    'GET',
    '/channels/1',
    { body: undefined, files: undefined },
  );
}

describe('тикеты: сервис', () => {
  it('автор закрывает тикет, и после этого может открыть новый', async () => {
    const { moderation, guildId, userId, threadId, ticket } = await openedTicket();
    expect((await moderation.openTicketOf(guildId, userId))?.id).toBe(ticket.id);

    const closed = await moderation.closeTicketFromThread(threadId, userId, false);

    expect(closed.closedAt).toBeInstanceOf(Date);
    expect(closed.closedBy).toBe(userId);
    expect(await moderation.openTicketOf(guildId, userId)).toBeNull();

    const next = await moderation.openTicket({ guildId, userId, threadId: `${threadId}-2`, topic: 'снова' });
    expect((await moderation.openTicketOf(guildId, userId))?.id).toBe(next.id);
  });

  it('посторонний закрыть не может, модератор — может', async () => {
    const { moderation, guildId, userId, threadId, ticket } = await openedTicket();

    await expect(moderation.closeTicketFromThread(threadId, 'посторонний', false)).rejects.toBeInstanceOf(
      UserError,
    );
    expect((await moderation.openTicketOf(guildId, userId))?.id).toBe(ticket.id);

    const closed = await moderation.closeTicketFromThread(threadId, 'модератор', true);
    expect(closed.closedBy).toBe('модератор');
  });

  it('повторное закрытие — не событие: сервис отвечает, что уже закрыт', async () => {
    const { moderation, userId, threadId, ticket } = await openedTicket();
    await moderation.closeTicketFromThread(threadId, userId, false);

    await expect(moderation.closeTicketFromThread(threadId, userId, false)).rejects.toThrow(/уже закрыт/);
    expect(await moderation.closeTicket(ticket.id, 'system')).toBeNull();
    expect((await ticketRow(ticket.id))?.closedBy).toBe(userId);
  });

  it('вне ветки тикета закрывать нечего', async () => {
    const moderation = createModerationService({ db: pg.db, cache });
    await expect(moderation.closeTicketFromThread('не-тикет', 'кто-то', true)).rejects.toThrow(
      /не ветка тикета/,
    );
  });
});

describe('тикеты: модуль', () => {
  it('ветка ушла в архив — тикет закрыт', async () => {
    const { ticket, threadId } = await openedTicket();
    const { event } = moduleParts();

    await event('threadUpdate').handle(
      { logger } as unknown as ModuleContext,
      ...threadChange(threadId, false, true),
    );

    const row = await ticketRow(ticket.id);
    expect(row?.closedAt).toBeInstanceOf(Date);
    expect(row?.closedBy).toBe('system');
  });

  it('правка ветки без ухода в архив тикет не закрывает', async () => {
    const { ticket, threadId } = await openedTicket();
    const { event } = moduleParts();

    await event('threadUpdate').handle(
      { logger } as unknown as ModuleContext,
      ...threadChange(threadId, false, false),
    );

    expect((await ticketRow(ticket.id))?.closedAt).toBeNull();
  });

  it('кнопка «Закрыть тикет» закрывает, гасит себя и запирает ветку', async () => {
    const { ticket, userId, threadId } = await openedTicket();
    const { event } = moduleParts();
    const thread = fakeThread(threadId);
    const update = vi.fn(async () => ({}));

    const interaction = {
      isButton: () => true,
      customId: 'tk',
      channelId: threadId,
      channel: thread,
      user: { id: userId },
      memberPermissions: { has: () => false },
      deferred: false,
      replied: false,
      update,
      reply: vi.fn(async () => ({})),
      followUp: vi.fn(async () => ({})),
    };
    await event('interactionCreate').handle(
      { logger } as unknown as ModuleContext,
      interaction as unknown as Parameters<EventHandler<'interactionCreate'>['handle']>[1],
    );

    expect((await ticketRow(ticket.id))?.closedBy).toBe(userId);
    const payload = (update.mock.calls[0] as unknown as [{ components: ActionRowBuilder<ButtonBuilder>[] }])[0];
    expect(payload.components[0]?.toJSON().components[0]).toMatchObject({ custom_id: 'tk', disabled: true });
    expect(thread.send).toHaveBeenCalled();
    expect(thread.setLocked).toHaveBeenCalledWith(true, expect.any(String));
    expect(thread.setArchived).toHaveBeenCalledWith(true, expect.any(String));
  });

  it('/ticket close изнутри ветки закрывает тикет автора', async () => {
    const { ticket, guildId, userId, threadId } = await openedTicket();
    const { command } = moduleParts();
    const thread = fakeThread(threadId);
    const { interaction, editReply } = ticketInteraction({
      subcommand: 'close',
      guildId,
      userId,
      channelId: threadId,
      channel: thread,
    });

    await command.execute(interaction, { logger } as unknown as ModuleContext);

    expect((await ticketRow(ticket.id))?.closedAt).toBeInstanceOf(Date);
    expect(editReply).toHaveBeenCalled();
    expect(thread.setArchived).toHaveBeenCalledWith(true, expect.any(String));
  });

  it('/ticket open с живым тикетом отказывает и ведёт в старый', async () => {
    const { moderation, ticket, guildId, userId, threadId } = await openedTicket();
    const { command } = moduleParts();
    const ctx = {
      logger,
      client: { channels: { fetch: vi.fn(async () => fakeThread(threadId)) } },
    } as unknown as ModuleContext;
    const { interaction } = ticketInteraction({ subcommand: 'open', guildId, userId, channelId: 'канал', topic: 'ещё' });

    await expect(command.execute(interaction, ctx)).rejects.toThrow(/уже открыт тикет/);
    expect((await moderation.openTicketOf(guildId, userId))?.id).toBe(ticket.id);
  });

  it('/ticket open: ветку старого тикета удалили — старый закрывается, открывается новый с кнопкой', async () => {
    const { moderation, ticket, guildId, userId, threadId } = await openedTicket();
    const { command } = moduleParts();
    const logChannelId = `${guildId}-журнал`;
    await moderation.saveSettings(guildId, { logChannelId });

    const created = { id: `${threadId}-новая`, members: { add: vi.fn(async () => ({})) }, send: vi.fn(async () => ({})) };
    const logChannel = { type: ChannelType.GuildText, threads: { create: vi.fn(async () => created) } };
    const ctx = {
      logger,
      client: {
        channels: {
          fetch: vi.fn(async (id: string) => {
            if (id === threadId) throw unknownChannel();
            return id === logChannelId ? logChannel : null;
          }),
        },
      },
    } as unknown as ModuleContext;
    const { interaction } = ticketInteraction({ subcommand: 'open', guildId, userId, channelId: 'канал', topic: 'ещё' });

    await command.execute(interaction, ctx);

    expect((await ticketRow(ticket.id))?.closedBy).toBe('system');
    expect((await moderation.openTicketOf(guildId, userId))?.threadId).toBe(created.id);
    const opening = (created.send.mock.calls[0] as unknown as [{ components: ActionRowBuilder<ButtonBuilder>[] }])[0];
    expect(opening.components[0]?.toJSON().components[0]).toMatchObject({ custom_id: 'tk' });
  });
});
