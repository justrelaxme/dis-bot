import type { Database } from '../../core/db/client.js';
import type { BotModule } from '../../core/module.js';
import { createTournamentPollCommand } from './commands/poll.js';
import { createDiscordPollGateway } from './discord/poll-gateway.js';
import { createPollFinalizer } from './services/finalizer.js';
import { createPollsService } from './services/polls.js';

/** Раз в 5 минут: достаточно быстро для голосования на несколько часов и не бьёт по Discord API. */
const POLL_FINALIZE_CRON = '*/5 * * * *';
const POLL_FINALIZE_BATCH_SIZE = 20;

export interface TournamentsModuleDeps {
  db: Database;
}

/**
 * Первый (и пока единственный) кусок подсистемы турниров: голосование по
 * дисциплине. Ни сеток, ни регистрации участников, ни остальных команд турниров
 * здесь нет — это следующие модули, которые будут добавляться отдельно.
 *
 * Discord-клиент не приходит сюда зависимостью конструктора: джоба получает живой
 * ctx.client на каждый тик планировщика (см. src/core/scheduler.ts — run(ctx)
 * вызывается с актуальным ModuleContext), и гейтвей строится заново из него в
 * замыкании run — этого достаточно, транзакции с новыми клиентами Redis для
 * этого модулю не нужны, а значит и teardown() модулю не нужен.
 */
export function createTournamentsModule(deps: TournamentsModuleDeps): BotModule {
  const polls = createPollsService({ db: deps.db });

  return {
    name: 'tournaments',

    commands: [createTournamentPollCommand({ polls })],

    jobs: [
      {
        name: 'tournaments:poll-finalize',
        cron: POLL_FINALIZE_CRON,
        async run(ctx): Promise<void> {
          const gateway = createDiscordPollGateway(ctx.client);
          const finalizer = createPollFinalizer({ polls, gateway, logger: ctx.logger });
          await finalizer.finalizeDue(POLL_FINALIZE_BATCH_SIZE);
        },
      },
    ],
  };
}
