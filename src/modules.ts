import type { BotModule } from './core/module.js';
import { createIdentityModule, type IdentityModuleDeps } from './modules/identity/index.js';
import { pingModule } from './modules/ping/index.js';
import { createLfgModule } from './modules/lfg/index.js';
import { createMaintenanceModule } from './modules/maintenance/index.js';
import { createModerationModule } from './modules/moderation/index.js';
import { createProgressionModule } from './modules/progression/index.js';
import { createTournamentsModule } from './modules/tournaments/index.js';
import { createWelcomeModule } from './modules/welcome/index.js';

/**
 * Единственное место, перечисляющее модули бота: и bootstrap (src/index.ts), и
 * регистрация команд (scripts/deploy-commands.ts) вызывают эту функцию — поэтому
 * набор команд, отправленный в Discord, не может разойтись с тем, что реально
 * запущено. Раньше (этап 0, только ping) это была константа; identity требует
 * рантайм-зависимостей (БД, шина событий, ключи провайдеров), которых нет в
 * момент импорта модуля, поэтому список стал функцией от этих зависимостей.
 *
 * tournaments (голосование по дисциплине, этап 5, первый кусок) не добавляет
 * параметр: ему нужна только БД, а она уже есть в identityDeps.db — заводить ради
 * этого отдельный параметр и менять оба места вызова (src/index.ts,
 * scripts/deploy-commands.ts) избыточно.
 */
export function buildModules(identityDeps: IdentityModuleDeps): BotModule[] {
  return [
    pingModule,
    createIdentityModule(identityDeps),
    createTournamentsModule({
      db: identityDeps.db,
      logger: identityDeps.logger,
      bus: identityDeps.bus,
      publicBaseUrl: identityDeps.config.PUBLIC_BASE_URL,
      // Тот же клиент OpenDota, что у синхронизации рангов: circuit breaker живёт в
      // замыкании экземпляра, и второй экземпляр не знал бы, что цепь уже разомкнута.
      fetchClientFor: identityDeps.fetchClientFor,
      rateLimiter: identityDeps.rateLimiter,
    }),
    createProgressionModule({ db: identityDeps.db, cache: identityDeps.cache }),
    createLfgModule({ db: identityDeps.db }),
    createModerationModule({ db: identityDeps.db, cache: identityDeps.cache }),
    createWelcomeModule({ db: identityDeps.db, cache: identityDeps.cache }),
    createMaintenanceModule({ config: identityDeps.config }),
  ];
}
