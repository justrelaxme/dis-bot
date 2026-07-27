import { sql } from 'drizzle-orm';
import { Events } from 'discord.js';
import { createCache } from './core/cache.js';
import { createDiscordClient } from './core/client.js';
import { createRouter } from './core/commands/router.js';
import { loadConfig } from './core/config.js';
import { createDatabase } from './core/db/client.js';
import { EventBus } from './core/events/bus.js';
import { createHttpServer } from './core/http/server.js';
import { createLogger } from './core/logger.js';
import { createMetrics } from './core/metrics.js';
import type { ModuleContext } from './core/module.js';
import { buildRegistry } from './core/registry.js';
import { createScheduler } from './core/scheduler.js';
import { createShutdown } from './core/shutdown.js';
import { modules } from './modules.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const config = loadConfig();
const logger = createLogger(config);

// Последний рубеж: несколько промисов в этом файле намеренно void-ятся
// (@typescript-eslint/no-floating-promises выключен осознанно), и без этих
// обработчиков их падение убивало бы процесс без единой строки в логах.
process.on('unhandledRejection', (error) => {
  logger.fatal({ err: error }, 'необработанное отклонение промиса');
});
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'необработанное исключение');
  process.exit(1);
});

const shutdown = createShutdown({ logger });

const { db, close: closeDatabase } = createDatabase(config, logger);
const cache = createCache(config, logger);
const bus = new EventBus(logger);
const metrics = createMetrics();
const client = createDiscordClient();

const registry = buildRegistry(modules);

const ctx: ModuleContext = { client, db, cache, logger, bus, config };
const router = createRouter({ registry, ctx, metrics });
const scheduler = createScheduler({ registry, ctx, shutdown });

const http = createHttpServer({
  config,
  logger,
  metrics,
  checks: {
    database: async () => {
      await db.execute(sql`select 1`);
    },
    cache: async () => {
      await cache.swr('healthz', { ttlMs: 5_000, staleMs: 10_000, load: async () => 'ok' });
    },
  },
});

let stopping = false;

client.on(Events.InteractionCreate, (interaction) => {
  // После получения сигнала новые интеракции не берём: доиграть их всё равно не успеем,
  // а взяться и оборвать посреди работы хуже, чем не браться.
  if (stopping) return;
  void shutdown.track(router(interaction));
});

for (const module of modules) {
  for (const handler of module.events ?? []) {
    const listener = (...args: unknown[]) =>
      void shutdown.track(
        // Типы аргументов гарантированы сигнатурой EventHandler на этапе объявления.
        handler.handle(ctx, ...(args as never)).catch((err: unknown) => {
          logger.error({ err, event: handler.event, module: module.name }, 'обработчик события модуля упал');
        }),
      );
    if (handler.once) client.once(handler.event, listener);
    else client.on(handler.event, listener);
  }
  await module.setup?.(ctx);
}

shutdown.onSignal(async () => {
  await http.close();
});
shutdown.onSignal(async () => {
  await client.destroy();
});
shutdown.onSignal(async () => {
  for (const module of modules) await module.teardown?.();
});
shutdown.onSignal(async () => {
  await cache.close();
});
shutdown.onSignal(async () => {
  await closeDatabase();
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'получен сигнал остановки');
    // Порядок обязателен: сперва перестаём принимать новую работу (флаг и остановка
    // планировщика), потом дожидаемся уже начатой (drain), и только потом рвём
    // ресурсы в onSignal-шагах. Иначе интеракции, прилетевшие в окне ожидания,
    // достаются с уже закрытыми БД и Redis.
    stopping = true;
    scheduler.stop();
    void shutdown.drain(SHUTDOWN_TIMEOUT_MS).then(() => process.exit(0));
  });
}

await http.listen({ port: config.HTTP_PORT, host: '0.0.0.0' });
logger.info({ port: config.HTTP_PORT }, 'HTTP-сервер слушает');

client.once(Events.ClientReady, (ready) => {
  logger.info({ tag: ready.user.tag, modules: modules.map((m) => m.name) }, 'бот подключён');
  scheduler.start();
  void bus.emit('core.ready', { at: new Date() });
});

await client.login(config.DISCORD_TOKEN);
