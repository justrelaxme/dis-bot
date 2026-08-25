import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Events, Routes } from 'discord.js';
import { createCache } from './core/cache.js';
import { createDiscordClient } from './core/client.js';
import { createRouter } from './core/commands/router.js';
import { loadConfig } from './core/config.js';
import { createCooldown } from './core/cooldown.js';
import { createDatabase } from './core/db/client.js';
import { explainStartupFailure, migrateWithRetry } from './core/db/startup.js';
import { EventBus } from './core/events/bus.js';
import { createFetchClient, type FetchClient } from './core/http/fetch-client.js';
import { createHttpServer } from './core/http/server.js';
import { createLogger } from './core/logger.js';
import { createMetrics } from './core/metrics.js';
import type { ModuleContext } from './core/module.js';
import { createRateLimiter } from './core/rate-limit.js';
import { buildRegistry } from './core/registry.js';
import { createScheduler } from './core/scheduler.js';
import { createShutdown } from './core/shutdown.js';
import { buildModules } from './modules.js';
import { registerSteamCallback } from './modules/identity/http/steam-callback.js';
import { registerDraftRoutes } from './modules/web/draft.js';
import { registerFormatRoutes } from './modules/web/formats.js';
import { registerWebRoutes } from './modules/web/routes.js';
import { createProviderRegistry } from './modules/identity/providers/index.js';
import { createLinkingService } from './modules/identity/services/linking.js';

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

/**
 * Куда мы вообще стучались — хост, порт и имя базы, без пароля. Нужно ровно для одного
 * случая, который случается чаще всех остальных вместе: в переменные окружения уехала
 * строка подключения для локальной разработки, и контейнер бесконечно перезапускается с
 * «ECONNREFUSED», не говоря куда именно он не смог подключиться.
 */
function describeDatabaseTarget(databaseUrl: string): Record<string, string> {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return { database: 'адрес не разобрался как URL' };
  }

  const local = ['localhost', '127.0.0.1', '::1', ''].includes(url.hostname);
  return {
    host: url.hostname,
    port: url.port || '5432',
    database: url.pathname.replace(/^\//u, '') || '(не указана)',
    ...(local
      ? {
          hint: 'база указана на localhost. Внутри контейнера localhost — это сам контейнер, а не ваша машина: нужен адрес внешней базы',
        }
      : {}),
  };
}

/**
 * Публичный адрес — не декларация. Из него строятся ссылки на сетку, лидерборд и зал славы
 * в объявлениях турниров, и адрес, куда Steam возвращает браузер игрока после входа.
 *
 * Локальный адрес в развёрнутом боте — тихая поломка: бот работает, объявления выходят, а
 * ссылки в них не открываются ни у кого, и `/link steam` не доходит до конца. Узнать об этом
 * можно только от игрока, который пожаловался. Поэтому предупреждение при старте, рядом с
 * остальными строками запуска: пропустить его труднее, чем догадаться о причине потом.
 *
 * Предупреждение, а не отказ стартовать: бот с нерабочими ссылками полезнее, чем
 * неработающий бот.
 */
{
  const hostname = new URL(config.PUBLIC_BASE_URL).hostname;
  if (['localhost', '127.0.0.1', '::1'].includes(hostname)) {
    logger.warn(
      { publicBaseUrl: config.PUBLIC_BASE_URL },
      'PUBLIC_BASE_URL ведёт на localhost: ссылки на сетку и лидерборд не откроются ни у кого, а /link steam не сможет вернуть игрока — укажите публичный адрес бота',
    );
  }
}

const { db, close: closeDatabase } = createDatabase(config, logger);

/**
 * Миграции перед всем остальным — и в этом же процессе, а не отдельным файлом.
 *
 * На платформах с одним контейнером отдельного шага миграций нет: код и база обновляются
 * одним деплоем, и бот, запущенный раньше миграций, упадёт на первом обращении к новой
 * колонке. Раньше это делал отдельный скомпилированный entrypoint, но он оказался лишней
 * точкой отказа: платформа запускала контейнер и не находила этот файл, хотя `dist/src`
 * был на месте. Одна точка входа надёжнее двух — тем более что именно `dist/src/index.js`
 * ищут все автоопределители.
 *
 * В docker-compose миграции выполняет отдельный одноразовый сервис, и повторный прогон
 * здесь ничего не делает: drizzle применяет только то, чего ещё нет в своей таблице.
 */
if (config.MIGRATE_ON_START) {
  // Недоступную базу переспрашиваем, а не падаем сразу: база, засыпающая при простое, на
  // первом соединении отвечает не мгновенно, и уйти из-за этого в перезапуск — потерять
  // минуты на ровном месте. Что переспрашивать, а что нет, решает db/startup.ts.
  const result = await migrateWithRetry(() => migrate(db, { migrationsFolder: config.MIGRATIONS_DIR }), {
    onRetry: ({ attempt, attempts, waitMs }) => {
      logger.warn(
        { attempt, attempts, waitMs, ...describeDatabaseTarget(config.DATABASE_URL) },
        'база не ответила — пробуем ещё раз',
      );
    },
  });

  if (result.ok) {
    logger.info(
      result.attemptsUsed > 1 ? { attempts: result.attemptsUsed } : {},
      'миграции применены',
    );
  } else {
    // Стартовать без применённых миграций нельзя: бот будет падать на каждом запросе к
    // изменённой таблице, и разбирать придётся уже по этим падениям, а не по одной строке.
    //
    // Сообщение называет тот отказ, который случился. Раньше здесь всегда стояло «миграции
    // не применились», и при недоступной базе это отправляло искать поломку в миграциях —
    // хотя до них дело не доходило вовсе. Адрес базы без пароля прилагается: стек сообщает
    // «ECONNREFUSED», но не говорит куда, а самая частая причина в контейнере одна и та же —
    // в переменные уехала строка для локальной разработки, где база на localhost. Внутри
    // контейнера localhost это сам контейнер, и базы там нет.
    logger.fatal(
      {
        err: result.error,
        failure: result.failure,
        attempts: result.attemptsUsed,
        ...describeDatabaseTarget(config.DATABASE_URL),
      },
      explainStartupFailure(result.failure ?? 'migration'),
    );
    await closeDatabase();
    process.exit(1);
  }
}
const cache = createCache(config, logger);
const bus = new EventBus(logger);
const metrics = createMetrics();
const client = createDiscordClient();

const cooldown = createCooldown({ redisUrl: config.REDIS_URL, logger });
const rateLimiter = createRateLimiter({ redisUrl: config.REDIS_URL, logger });

// Мемоизация по провайдеру (находка 4 итогового ревью): без неё модуль (через
// buildModules ниже) и HTTP-колбэк Steam получили бы РАЗНЫЕ экземпляры FetchClient
// для одного и того же провайдера — а состояние circuit breaker живёт в замыкании
// конкретного экземпляра (см. createFetchClient). Открытая цепь у slash-команд не
// останавливала бы колбэк и наоборот. Квота (rate limiter) и кэш уже общие — их
// состояние в Redis, а не в памяти процесса, поэтому только клиент нуждался в
// переиспользовании.
const fetchClients = new Map<string, FetchClient>();
const fetchClientFor = (provider: string): FetchClient => {
  const existing = fetchClients.get(provider);
  if (existing) return existing;
  const client = createFetchClient({ provider, logger, metrics });
  fetchClients.set(provider, client);
  return client;
};

const modules = buildModules({
  db,
  bus,
  logger,
  config,
  cooldown,
  rateLimiter,
  cache,
  fetchClientFor,
  fetchMember: async (guildId, userId) => {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return null;
    // Участник мог покинуть сервер между синхронизацией и выдачей роли.
    return guild.members.fetch(userId).catch(() => null);
  },
});

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

// Витрина: сетки турниров и лидерборды по рангам. Только чтение, без входа —
// управление остаётся в Discord, поэтому ни авторизации, ни сессий здесь нет.
registerWebRoutes(http, { db, cache, logger, guildId: config.DISCORD_GUILD_ID });

// Драфт — единственная страница витрины, где что-то нажимают. Право действовать даёт
// ссылка с токеном, которую бот присылает капитану в личку: входа на сайт нет и не будет.
registerDraftRoutes(http, { db, cache, logger });

// Конструктор форматов турнира — вторая и последняя страница, где что-то меняют. Право
// даёт та же ссылка с токеном: организатор получает её командой `/tournament formats`.
registerFormatRoutes(http, { db, logger, client, publicBaseUrl: config.PUBLIC_BASE_URL });

registerSteamCallback(http, {
  logger,
  linking: createLinkingService({ db }),
  providers: createProviderRegistry({
    publicBaseUrl: config.PUBLIC_BASE_URL,
    ...(config.STEAM_API_KEY ? { steamApiKey: config.STEAM_API_KEY } : {}),
    ...(config.RIOT_API_KEY ? { riotApiKey: config.RIOT_API_KEY } : {}),
    steamClient: fetchClientFor('steam'),
    openDotaClient: fetchClientFor('opendota'),
    riotClient: fetchClientFor('riot'),
  enkaClient: fetchClientFor('enka'),
    rateLimiter,
    cache,
  }),
  notify: async (userId, text) => {
    const user = await client.users.fetch(userId).catch(() => null);
    await user?.send(text).catch(() => {
      // Личные сообщения могут быть закрыты — это не ошибка бота.
    });
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
    const listener = (...args: unknown[]) => {
      // Зеркалит защиту InteractionCreate выше: во время дренажа новую работу от
      // событий модуля не берём — иначе она попадёт в окно между drain и закрытием
      // БД/Redis в onSignal-шагах.
      if (stopping) return;
      void shutdown.track(
        // Типы аргументов гарантированы сигнатурой EventHandler на этапе объявления.
        handler.handle(ctx, ...(args as never)).catch((err: unknown) => {
          logger.error({ err, event: handler.event, module: module.name }, 'обработчик события модуля упал');
        }),
      );
    };
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
  void deployCommands();
});

/**
 * Набор команд приводится к тому, что в коде. Гильдейская регистрация, поэтому изменения
 * видны сразу, без часа ожидания глобального распространения.
 *
 * Неудача здесь бота не роняет: он уже подключён и умеет всё, кроме новых команд. Падать
 * из-за недоступного Discord API было бы хуже — прошлый набор команд работает, а
 * упавший бот не работает вовсе.
 */
async function deployCommands(): Promise<void> {
  if (!config.DEPLOY_COMMANDS_ON_START) return;
  const body = [...registry.commands.values()].map((entry) => entry.command.builder.toJSON());
  try {
    await client.rest.put(Routes.applicationGuildCommands(config.DISCORD_APP_ID, config.DISCORD_GUILD_ID), {
      body,
    });
    logger.info({ count: body.length }, 'команды зарегистрированы на сервере');
  } catch (error) {
    logger.error({ err: error }, 'команды не зарегистрировались — в Discord остался прошлый набор');
  }
}

await client.login(config.DISCORD_TOKEN);
