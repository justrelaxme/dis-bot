import { REST, Routes } from 'discord.js';
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { buildRegistry } from '../src/core/registry.js';
import { modules } from '../src/modules.js';

const config = loadConfig();
const logger = createLogger(config);
const registry = buildRegistry(modules);

const body = [...registry.commands.values()].map((entry) => entry.command.builder.toJSON());
const rest = new REST().setToken(config.DISCORD_TOKEN);

try {
  await rest.put(Routes.applicationGuildCommands(config.DISCORD_APP_ID, config.DISCORD_GUILD_ID), { body });
  logger.info({ count: body.length }, 'команды зарегистрированы на сервере');
} catch (error) {
  logger.error({ err: error }, 'регистрация команд не удалась');
  process.exitCode = 1;
}
