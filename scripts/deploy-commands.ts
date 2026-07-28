import { REST, Routes } from 'discord.js';
import { loadConfig } from '../src/core/config.js';
import type { Database } from '../src/core/db/client.js';
import { EventBus } from '../src/core/events/bus.js';
import { createLogger } from '../src/core/logger.js';
import { buildRegistry } from '../src/core/registry.js';
import { buildModules } from '../src/modules.js';

const config = loadConfig();
const logger = createLogger(config);

// Скрипту нужны только билдеры команд (entry.command.builder.toJSON() ниже) — ни
// один метод БД, шины или заглушек не вызывается ни разу. Поэтому БД — пустая
// заглушка (никогда не разыменовывается), а шина — настоящий, но бездействующий
// EventBus (дешевле создать реальный, чем городить ещё один каст).
const db = {} as unknown as Database;
const bus = new EventBus(logger);

const modules = buildModules({
  db,
  bus,
  logger,
  config,
  cooldown: { hit: async () => ({ allowed: true, retryAfterMs: 0 }), close: async () => {} },
  rateLimiter: { acquire: async () => {}, close: async () => {} },
  fetchClientFor: () => ({ json: async () => ({}) }) as never,
  fetchMember: async () => null,
});

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
