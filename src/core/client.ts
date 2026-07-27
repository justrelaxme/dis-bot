import { Client, GatewayIntentBits } from 'discord.js';

/**
 * Интенты по принципу минимальных привилегий.
 * MessageContent появится с модерацией, GuildVoiceStates — с LFG.
 */
export function createDiscordClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });
}
