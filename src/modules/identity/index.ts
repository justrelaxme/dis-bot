import type { GuildMember } from 'discord.js';
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
import { createProviderRegistry } from './providers/index.js';
import { createLinkingService } from './services/linking.js';
import { createRankSyncService } from './services/rank-sync.js';
import { createRoleMappingService } from './services/role-mapping.js';

/** Значения из спеки: пачка на 100 аккаунтов каждые 30 минут. */
const SYNC_CRON = '*/30 * * * *';
const SYNC_BATCH_SIZE = 100;

export interface IdentityModuleDeps {
  db: Database;
  bus: EventBus;
  logger: Logger;
  config: Config;
  cooldown: Cooldown;
  rateLimiter: RateLimiter;
  /** Отдельный клиент на провайдера: у каждого свой circuit breaker. */
  fetchClientFor: (provider: string) => FetchClient;
  /** Поиск участника сервера. Возвращает null, если он ушёл с сервера. */
  fetchMember: (guildId: string, userId: string) => Promise<GuildMember | null>;
}

export function createIdentityModule(deps: IdentityModuleDeps): BotModule {
  const linking = createLinkingService({ db: deps.db });
  const roles = createRoleMappingService({ db: deps.db, logger: deps.logger });
  const providers = createProviderRegistry({
    publicBaseUrl: deps.config.PUBLIC_BASE_URL,
    ...(deps.config.STEAM_API_KEY ? { steamApiKey: deps.config.STEAM_API_KEY } : {}),
    ...(deps.config.RIOT_API_KEY ? { riotApiKey: deps.config.RIOT_API_KEY } : {}),
    steamClient: deps.fetchClientFor('steam'),
    openDotaClient: deps.fetchClientFor('opendota'),
    riotClient: deps.fetchClientFor('riot'),
    rateLimiter: deps.rateLimiter,
  });
  const rankSync = createRankSyncService({
    db: deps.db,
    linking,
    providers,
    bus: deps.bus,
    logger: deps.logger,
  });

  const identityDeps: IdentityDeps = { linking, providers, roles, rankSync, bus: deps.bus };

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
