import type { BotModule, CommandDefinition, ScheduledJob } from './module.js';

export interface Registry {
  modules: BotModule[];
  commands: Map<string, { command: CommandDefinition; moduleName: string }>;
  jobs: Array<{ job: ScheduledJob; moduleName: string }>;
}

export function buildRegistry(modules: BotModule[]): Registry {
  const seenModules = new Set<string>();
  const commands = new Map<string, { command: CommandDefinition; moduleName: string }>();
  const jobs: Array<{ job: ScheduledJob; moduleName: string }> = [];

  for (const module of modules) {
    if (seenModules.has(module.name)) {
      throw new Error(`Два модуля с именем «${module.name}». Имена модулей должны быть уникальны.`);
    }
    seenModules.add(module.name);

    for (const command of module.commands ?? []) {
      const name = command.builder.name;
      const existing = commands.get(name);
      if (existing) {
        throw new Error(
          `Команда «${name}» объявлена дважды: в модулях «${existing.moduleName}» и «${module.name}».`,
        );
      }
      commands.set(name, { command, moduleName: module.name });
    }

    for (const job of module.jobs ?? []) {
      jobs.push({ job, moduleName: module.name });
    }
  }

  return { modules, commands, jobs };
}
