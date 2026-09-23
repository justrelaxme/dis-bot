import { ChannelType, type ClientEvents } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { UserError } from '../../../src/core/errors.js';
import { createLogger } from '../../../src/core/logger.js';
import type { EventHandler, ModuleContext } from '../../../src/core/module.js';
import { createLfgModule } from '../../../src/modules/lfg/index.js';
import { createLfgService } from '../../../src/modules/lfg/service.js';
import { fakeChatInputInteraction } from '../../helpers/interaction.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

let counter = 0;

function ids() {
  counter += 1;
  const n = String(counter).padStart(15, '0');
  return { guildId: `91${n}`, host: `92${n}`, second: `93${n}`, third: `94${n}` };
}

function moduleParts() {
  const module = createLfgModule({ db: pg.db });
  const buttons = module.events?.find((handler) => handler.event === 'interactionCreate');
  const command = module.commands?.find((candidate) => candidate.builder.name === 'lfg');
  if (!buttons || !command) throw new Error('модуль LFG собран не полностью');
  return { buttons: buttons as unknown as EventHandler<'interactionCreate'>, command };
}

/** Голосовой канал сбора: только права, их и проверяем. */
function fakeVoice(id: string) {
  return {
    id,
    type: ChannelType.GuildVoice,
    permissionOverwrites: { edit: vi.fn(async () => ({})), delete: vi.fn(async () => ({})) },
  };
}

function pressButton(input: { customId: string; userId: string; guild: unknown }) {
  return {
    isButton: () => true,
    customId: input.customId,
    user: { id: input.userId },
    guild: input.guild,
    member: null,
    deferred: false,
    replied: false,
    update: vi.fn(async () => ({})),
    reply: vi.fn(async () => ({})),
    followUp: vi.fn(async () => ({})),
  } as unknown as ClientEvents['interactionCreate'][0];
}

function postInteraction(input: { guildId: string; userId: string; game: string; slots: number }) {
  const fake = fakeChatInputInteraction('lfg');
  const values: Record<string, unknown> = {
    options: {
      getSubcommand: () => 'post',
      getString: (name: string) => (name === 'game' ? input.game : null),
      getInteger: (name: string) => (name === 'slots' ? input.slots : null),
    },
    inGuild: () => true,
    guildId: input.guildId,
    user: { id: input.userId },
  };
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(fake.interaction, key, { value });
  }
  return fake;
}

describe('LFG: сервис', () => {
  it('Genshin есть среди игр, и в мир больше четверых не собрать', async () => {
    const lfg = createLfgService({ db: pg.db });
    const { guildId, host, second } = ids();
    const base = { guildId, game: 'genshin' as const, mode: 'боссы', channelId: 'канал', ttlMinutes: 60 };

    await expect(lfg.open({ ...base, hostUserId: host, slots: 5 })).rejects.toBeInstanceOf(UserError);
    const { post } = await lfg.open({ ...base, hostUserId: second, slots: 4 });
    expect(post.game).toBe('genshin');
  });

  it('карточка записывается вместе с каналом, где она лежит', async () => {
    const lfg = createLfgService({ db: pg.db });
    const { guildId, host } = ids();
    const { post } = await lfg.open({
      guildId,
      hostUserId: host,
      game: 'dota2',
      mode: 'турбо',
      slots: 5,
      channelId: 'канал-сборов',
      ttlMinutes: 60,
    });

    await lfg.attachMessage(post.id, 'канал-где-вызвали', 'сообщение');

    const stored = await lfg.byId(post.id);
    expect(stored.channelId).toBe('канал-где-вызвали');
    expect(stored.messageId).toBe('сообщение');
  });
});

describe('LFG: объявление сбора', () => {
  it('после /lfg-setup here карточка уходит в канал сборов, и записан именно он', async () => {
    const lfg = createLfgService({ db: pg.db });
    const { command } = moduleParts();
    const { guildId, host } = ids();
    const boardId = `${guildId}-сборы`;
    await lfg.saveSettings(guildId, { channelId: boardId });

    const board = {
      id: boardId,
      type: ChannelType.GuildText,
      send: vi.fn(async () => ({ id: 'карточка', channelId: boardId, url: 'https://discord.test/карточка' })),
    };
    const ctx = {
      logger,
      client: { channels: { fetch: vi.fn(async (id: string) => (id === boardId ? board : null)) } },
    } as unknown as ModuleContext;
    const fake = postInteraction({ guildId, userId: host, game: 'valorant', slots: 5 });

    await command.execute(fake.interaction, ctx);

    expect(board.send).toHaveBeenCalledTimes(1);
    const own = await lfg.ownPost(guildId, host);
    expect(own?.channelId).toBe(boardId);
    expect(own?.messageId).toBe('карточка');
    // Там, где вызвали, — только ссылка на карточку, а не вторая карточка.
    const reply = (fake.calls.editReply.mock.calls[0] as unknown as [{ content: string; components?: unknown }])[0];
    expect(reply.content).toContain(`<#${boardId}>`);
    expect(reply.components).toBeUndefined();
  });

  it('канал сборов недоступен — карточка остаётся здесь, и записан этот канал', async () => {
    const lfg = createLfgService({ db: pg.db });
    const { command } = moduleParts();
    const { guildId, host } = ids();
    await lfg.saveSettings(guildId, { channelId: `${guildId}-удалённый` });

    const ctx = {
      logger,
      client: { channels: { fetch: vi.fn(async () => null) } },
    } as unknown as ModuleContext;
    const fake = postInteraction({ guildId, userId: host, game: 'dota2', slots: 5 });

    await command.execute(fake.interaction, ctx);

    const own = await lfg.ownPost(guildId, host);
    // Фейк editReply возвращает сообщение в канале, где вызвана команда.
    expect(own?.channelId).toBe(fake.interaction.channelId);
    expect(own?.messageId).toBe('900000000000000002');
  });
});

describe('LFG: голосовой канал сбора', () => {
  it('ушедший теряет доступ в канал, пришедший на его место — получает', async () => {
    const lfg = createLfgService({ db: pg.db });
    const { buttons } = moduleParts();
    const { guildId, host, second, third } = ids();

    // Состав набран, канал создан на него — как после первого заполнения.
    const { post } = await lfg.open({
      guildId,
      hostUserId: host,
      game: 'genshin',
      mode: 'боссы',
      slots: 2,
      channelId: 'канал',
      ttlMinutes: 60,
    });
    await lfg.join(post.id, second);
    const voiceId = `${guildId}-голос`;
    await lfg.attachVoice(post.id, voiceId);

    const voice = fakeVoice(voiceId);
    const guild = {
      id: guildId,
      channels: {
        fetch: vi.fn(async (id: string) => (id === voiceId ? voice : null)),
        create: vi.fn(async () => {
          throw new Error('второй канал на тот же сбор создаваться не должен');
        }),
      },
    };
    const ctx = { logger } as unknown as ModuleContext;

    await buttons.handle(ctx, pressButton({ customId: `ll:${post.id}`, userId: second, guild }));
    expect(voice.permissionOverwrites.delete).toHaveBeenCalledWith(second, expect.any(String));

    await buttons.handle(ctx, pressButton({ customId: `lj:${post.id}`, userId: third, guild }));
    expect(voice.permissionOverwrites.edit).toHaveBeenCalledWith(
      third,
      expect.objectContaining({ Connect: true, ViewChannel: true }),
      expect.anything(),
    );
    expect(guild.channels.create).not.toHaveBeenCalled();
    expect(await lfg.roster(post.id)).toEqual([host, third]);
  });

  it('пока голосового нет, вход и выход права не трогают', async () => {
    const lfg = createLfgService({ db: pg.db });
    const { buttons } = moduleParts();
    const { guildId, host, second } = ids();
    const { post } = await lfg.open({
      guildId,
      hostUserId: host,
      game: 'dota2',
      mode: 'турбо',
      slots: 5,
      channelId: 'канал',
      ttlMinutes: 60,
    });
    const guild = { id: guildId, channels: { fetch: vi.fn(async () => null), create: vi.fn() } };
    const ctx = { logger } as unknown as ModuleContext;

    await buttons.handle(ctx, pressButton({ customId: `lj:${post.id}`, userId: second, guild }));
    await buttons.handle(ctx, pressButton({ customId: `ll:${post.id}`, userId: second, guild }));

    expect(guild.channels.fetch).not.toHaveBeenCalled();
  });
});
