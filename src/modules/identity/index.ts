import type { GuildMember } from 'discord.js';
import { Cache, type CachedValue, type SwrOptions } from '../../core/cache.js';
import type { Config } from '../../core/config.js';
import type { Cooldown } from '../../core/cooldown.js';
import type { Database } from '../../core/db/client.js';
import type { EventBus } from '../../core/events/bus.js';
import type { FetchClient } from '../../core/http/fetch-client.js';
import type { Logger } from '../../core/logger.js';
import type { BotModule } from '../../core/module.js';
import type { RateLimiter } from '../../core/rate-limit.js';
import { createLinkCommand, type IdentityDeps } from './commands/link.js';
import { createProfileCommand } from './commands/profile.js';
import { createRankSyncCommand } from './commands/ranksync.js';
import { createRoleMapCommand } from './commands/rolemap.js';
import { createUnlinkCommand } from './commands/unlink.js';
import { createHoyolabChronicle } from './providers/hoyolab.js';
import { createProviderRegistry } from './providers/index.js';
import { createLinkingService } from './services/linking.js';
import { createRankSyncService } from './services/rank-sync.js';
import { createRoleMappingService } from './services/role-mapping.js';

/** Значения из спеки: пачка на 100 аккаунтов каждые 30 минут. */
const SYNC_CRON = '*/30 * * * *';
const SYNC_BATCH_SIZE = 100;

/**
 * "Прозрачный" кэш для реестра провайдеров синхронизации (находки 1 и 2 итогового
 * ревью ветки). swr() ничего не хранит и не отдаёт — просто исполняет load() и
 * возвращает результат как есть, включая исключение. Обычный Cache.swr (Task 18)
 * при сбое загрузчика отдаёт просроченное значение — годится для команд (быстрый
 * ответ, деградация вместо ошибки при чтении), но противопоказано синхронизации:
 * она добывает данные, а не читает их, и обязана видеть настоящий ответ провайдера,
 * включая настоящий сбой. Иначе счётчики synced/failed в syncBatch перестают
 * что-либо значить (сбой Riot тихо становится «synced: 100, failed: 0»), а
 * /ranksync не может обойти TTL кэша ранга (20 минут — больше её же кулдауна
 * в 10 минут), из-за чего команда отвечает игроку, ничего не проверив в Riot.
 *
 * createProviderRegistry — единственное место, которое знает, как собрать все
 * четыре провайдера (providers/index.ts), и она всегда оборачивает их withCache.
 * Чтобы не заводить вторую, дублирующую точку сборки провайдеров, реестр для
 * синхронизации получают тем же вызовом createProviderRegistry, но с этим кэшем:
 * поведенчески он неотличим от отсутствия кэша, а HTTP-клиенты, ключи и rate
 * limiter внутри — те же самые, что и у кэширующего реестра команд (см. ниже),
 * поэтому circuit breaker на каждого провайдера общий на процесс, а не удваивается
 * (находка 4 итогового ревью).
 *
 * `Cache` — класс с приватными полями (живое соединение с Redis), поэтому
 * структурная типизация TypeScript не пропустит литерал без приведения типа —
 * тот же приём (обход приватности через `as unknown as`), что уже применяется в
 * проекте для похожих целей в core/cooldown.ts и core/rate-limit.ts.
 */
function createPassthroughCache(): Cache {
  const passthrough = {
    async swr<T>(_key: string, options: SwrOptions<T>): Promise<CachedValue<T>> {
      return { value: await options.load(), stale: false, storedAt: new Date() };
    },
    async drop(): Promise<void> {},
    async close(): Promise<void> {},
  };
  return passthrough as unknown as Cache;
}

export interface IdentityModuleDeps {
  db: Database;
  bus: EventBus;
  logger: Logger;
  config: Config;
  cooldown: Cooldown;
  rateLimiter: RateLimiter;
  cache: Cache;
  /** Отдельный клиент на провайдера: у каждого свой circuit breaker. */
  fetchClientFor: (provider: string) => FetchClient;
  /** Поиск участника сервера. Возвращает null, если он ушёл с сервера. */
  fetchMember: (guildId: string, userId: string) => Promise<GuildMember | null>;
}

export function createIdentityModule(deps: IdentityModuleDeps): BotModule {
  const linking = createLinkingService({ db: deps.db });
  const roles = createRoleMappingService({ db: deps.db, logger: deps.logger });

  // Клиенты и ключи собираются один раз и переиспользуются для обоих реестров ниже —
  // иначе у Steam/Riot появится по два circuit breaker на процесс (находка 4).
  const steamClient = deps.fetchClientFor('steam');
  const openDotaClient = deps.fetchClientFor('opendota');
  const riotClient = deps.fetchClientFor('riot');
  const enkaClient = deps.fetchClientFor('enka');
  const steamApiKey = deps.config.STEAM_API_KEY;
  const riotApiKey = deps.config.RIOT_API_KEY;

  // Реестр для команд (/link, /profile, /unlink, /rolemap): обёрнут кэшем (Task 18) —
  // быстрый ответ и деградация до устаревших данных при временной недоступности
  // провайдера. Это чтение, и кэш ему уместен.
  const providers = createProviderRegistry({
    publicBaseUrl: deps.config.PUBLIC_BASE_URL,
    ...(steamApiKey ? { steamApiKey } : {}),
    ...(riotApiKey ? { riotApiKey } : {}),
    steamClient,
    openDotaClient,
    riotClient,
    enkaClient,
    rateLimiter: deps.rateLimiter,
    cache: deps.cache,
  });

  // Реестр для синхронизации: без реального кэша (находки 1 и 2, см. createPassthroughCache
  // выше) — syncBatch и /ranksync добывают данные и обязаны видеть настоящий ответ
  // провайдера, а не просроченную копию.
  const rawProviders = createProviderRegistry({
    publicBaseUrl: deps.config.PUBLIC_BASE_URL,
    ...(steamApiKey ? { steamApiKey } : {}),
    ...(riotApiKey ? { riotApiKey } : {}),
    steamClient,
    openDotaClient,
    riotClient,
    enkaClient,
    rateLimiter: deps.rateLimiter,
    cache: createPassthroughCache(),
  });

  const rankSync = createRankSyncService({
    db: deps.db,
    linking,
    providers: rawProviders,
    bus: deps.bus,
    logger: deps.logger,
  });

  // Летопись HoYoLAB: единственный источник полного состава аккаунта Genshin. Отдельно от
  // реестра провайдеров, потому что это не привязка и не ранг — это сведения об аккаунте,
  // и у неё свой ключ, своя квота и своё право отсутствовать.
  const chronicle = createHoyolabChronicle({
    client: deps.fetchClientFor('hoyolab'),
    rateLimiter: deps.rateLimiter,
    ...(deps.config.HOYOLAB_COOKIE ? { cookie: deps.config.HOYOLAB_COOKIE } : {}),
  });

  const identityDeps: IdentityDeps = { linking, providers, roles, rankSync, bus: deps.bus, chronicle };

  return {
    name: 'identity',

    commands: [
      createLinkCommand(identityDeps),
      createUnlinkCommand(identityDeps),
      createProfileCommand(identityDeps),
      createRankSyncCommand({ ...identityDeps, cooldown: deps.cooldown }),
      createRoleMapCommand({ roles }),
    ],

    jobs: [
      {
        name: 'identity:rank-sync',
        cron: SYNC_CRON,
        run: async () => {
          await rankSync.syncBatch(SYNC_BATCH_SIZE);
        },
      },
    ],

    async setup(ctx) {
      deps.bus.on('rank.changed', async (payload) => {
        // Роли выдаются на всех серверах, где настроен маппинг. Сейчас сервер один,
        // но поиск по guild_id уже здесь — переход к нескольким не потребует правок.
        for (const guildId of ctx.client.guilds.cache.keys()) {
          const member = await deps.fetchMember(guildId, payload.userId);
          if (!member) continue;

          const accounts = await linking.listAccounts(payload.userId);
          const account = accounts.find((a) => a.provider === payload.provider);
          // Неподтверждённые привязки авто-роль не дают.
          if (!account?.verifiedAt) continue;

          const ranks = await linking.latestRanks(account.id);
          await roles.applyRoles(member, guildId, account.provider, ranks);
        }
      });
    },

    async teardown() {
      await deps.cooldown.close();
      await deps.rateLimiter.close();
    },
  };
}
