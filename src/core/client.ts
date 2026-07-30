import { Client, GatewayIntentBits } from 'discord.js';

/**
 * Интенты по принципу минимальных привилегий — но ровно те, без которых объявленные
 * обработчики событий не получат ничего.
 *
 * Это место опасно тем, что ошибка в нём не проявляется ошибкой: без нужного интента
 * Discord просто не присылает событие, обработчик молчит, и в логах пусто. Поэтому список
 * ниже привязан к тому, что модули реально слушают:
 *
 * - `Guilds` — базовое: гильдии, каналы, интеракции;
 * - `GuildMembers` — `guildMemberAdd` (встреча новичка, антирейд) и выдача ролей за ранг;
 * - `GuildMessages` — `messageCreate` вообще: без него нет ни опыта за сообщения, ни антиспама;
 * - `MessageContent` — **текст** сообщения: антиспам считает по нему повторы и упоминания,
 *   а прогрессия проверяет минимальную длину. Привилегированный интент;
 * - `GuildVoiceStates` — `voiceStateUpdate`: опыт за голос и комнаты LFG.
 *
 * `GuildMembers` и `MessageContent` привилегированные: их надо включить в Developer Portal
 * (Bot → Privileged Gateway Intents), иначе Discord отклонит подключение с
 * «Used disallowed intents».
 */
export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });
}
