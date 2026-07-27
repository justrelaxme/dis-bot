import type {
  ChatInputCommandInteraction,
  Client,
  ClientEvents,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import type { Cache } from './cache.js';
import type { Config } from './config.js';
import type { Database } from './db/client.js';
import type { EventBus } from './events/bus.js';
import type { Logger } from './logger.js';

/** Зависимости приходят аргументом, а не глобальным импортом — иначе модуль нечем тестировать. */
export interface ModuleContext {
  client: Client;
  db: Database;
  cache: Cache;
  logger: Logger;
  bus: EventBus;
  config: Config;
}

export type CommandBuilder =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

export interface CommandDefinition {
  builder: CommandBuilder;
  /**
   * Роутер вызовет deferReply() до execute. Обязательно для всего, что делает
   * сетевой вызов: окно ответа Discord — 3 секунды.
   */
  defer?: { ephemeral: boolean };
  execute(interaction: ChatInputCommandInteraction, ctx: ModuleContext): Promise<void>;
}

export interface EventHandler<K extends keyof ClientEvents = keyof ClientEvents> {
  event: K;
  once?: boolean;
  handle(ctx: ModuleContext, ...args: ClientEvents[K]): Promise<void>;
}

export interface ScheduledJob {
  name: string;
  /** Выражение cron с пятью полями, например '*\/30 * * * *'. */
  cron: string;
  run(ctx: ModuleContext): Promise<void>;
}

export interface BotModule {
  name: string;
  commands?: CommandDefinition[];
  events?: EventHandler[];
  jobs?: ScheduledJob[];
  setup?(ctx: ModuleContext): Promise<void>;
  teardown?(): Promise<void>;
}
