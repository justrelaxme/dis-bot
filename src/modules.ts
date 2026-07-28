import type { BotModule } from './core/module.js';
import { pingModule } from './modules/ping/index.js';

/** Единственный список модулей бота. И bootstrap, и регистрация команд читают его. */
export const modules: BotModule[] = [pingModule];
