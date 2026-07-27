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
  // Croner держит собственный глобальный реестр имён джоб и сам бросает на дубликате —
  // но с указанием на croner, а не на модули бота. Проверяем заранее, чтобы ошибка
  // называла виновных, как и для команд выше.
  const seenJobs = new Map<string, string>();

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
      const existingModuleName = seenJobs.get(job.name);
      if (existingModuleName) {
        throw new Error(
          `Джоба «${job.name}» объявлена дважды: в модулях «${existingModuleName}» и «${module.name}».`,
        );
      }
      seenJobs.set(job.name, module.name);
      jobs.push({ job, moduleName: module.name });
    }
  }

  return { modules, commands, jobs };
}
