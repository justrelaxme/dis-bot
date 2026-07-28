import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { BotModule } from '../../core/module.js';

/**
 * Эталонный модуль. Показывает минимальный полный набор: объявление команды
 * данными, эфемерный ответ через flags, отсутствие defer для мгновенных операций.
 */
export const pingModule: BotModule = {
  name: 'ping',
  commands: [
    {
      builder: new SlashCommandBuilder().setName('ping').setDescription('Проверить, что бот жив'),
      async execute(interaction) {
        const latency = Math.round(interaction.client.ws.ping);
        await interaction.reply({
          content: `Понг. Задержка шлюза: ${latency} мс.`,
          flags: MessageFlags.Ephemeral,
        });
      },
    },
  ],
};
