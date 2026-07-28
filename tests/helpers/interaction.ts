import type { ChatInputCommandInteraction } from 'discord.js';
import { vi } from 'vitest';

export interface FakeInteraction {
  interaction: ChatInputCommandInteraction;
  calls: {
    reply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
    deferReply: ReturnType<typeof vi.fn>;
  };
}

export function fakeChatInputInteraction(commandName: string): FakeInteraction {
  const state = { deferred: false, replied: false };

  const deferReply = vi.fn(async () => {
    state.deferred = true;
  });
  const reply = vi.fn(async () => {
    state.replied = true;
  });
  const followUp = vi.fn(async () => {
    state.replied = true;
  });

  const interaction = {
    commandName,
    id: '900000000000000001',
    guildId: '111111111111111111',
    user: { id: '222222222222222222' },
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    get deferred() {
      return state.deferred;
    },
    get replied() {
      return state.replied;
    },
    deferReply,
    reply,
    followUp,
    // Подделывается только используемая роутером часть интеракции.
  } as unknown as ChatInputCommandInteraction;

  return { interaction, calls: { reply, followUp, deferReply } };
}
