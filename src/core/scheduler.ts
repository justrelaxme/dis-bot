import { Cron } from 'croner';
import type { ModuleContext, ScheduledJob } from './module.js';
import type { Registry } from './registry.js';

export interface Scheduler {
  start(): void;
  stop(): void;
  runOnce(jobName: string): Promise<void>;
}

export interface SchedulerDeps {
  registry: Registry;
  ctx: ModuleContext;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const crons: Cron[] = [];

  async function execute(job: ScheduledJob, moduleName: string): Promise<void> {
    const log = deps.ctx.logger.child({ job: job.name, module: moduleName });
    const startedAt = Date.now();
    try {
      await job.run(deps.ctx);
      log.info({ durationMs: Date.now() - startedAt }, 'джоба выполнена');
    } catch (error) {
      // Упавшая джоба не должна ронять процесс: следующий запуск попробует снова.
      log.error({ err: error }, 'джоба упала');
    }
  }

  return {
    start(): void {
      for (const { job, moduleName } of deps.registry.jobs) {
        try {
          crons.push(new Cron(job.cron, { protect: true, name: job.name }, () => execute(job, moduleName)));
        } catch (error) {
          throw new Error(`Некорректное расписание у джобы «${job.name}»: ${(error as Error).message}`);
        }
      }
      deps.ctx.logger.info({ count: crons.length }, 'планировщик запущен');
    },

    stop(): void {
      for (const cron of crons) cron.stop();
      crons.length = 0;
    },

    async runOnce(jobName: string): Promise<void> {
      const entry = deps.registry.jobs.find(({ job }) => job.name === jobName);
      if (!entry) {
        throw new Error(`Джоба «${jobName}» не зарегистрирована.`);
      }
      await execute(entry.job, entry.moduleName);
    },
  };
}
