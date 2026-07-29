import type { BotModule } from './core/module.js';
import { createIdentityModule, type IdentityModuleDeps } from './modules/identity/index.js';
import { pingModule } from './modules/ping/index.js';
import { createTournamentsModule } from './modules/tournaments/index.js';

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
  return [pingModule, createIdentityModule(identityDeps), createTournamentsModule({ db: identityDeps.db })];
}
