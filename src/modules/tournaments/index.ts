import type { Database } from '../../core/db/client.js';
import type { Logger } from '../../core/logger.js';
import type { BotModule } from '../../core/module.js';
import { createManageCommand } from './commands/manage.js';
import { createButtonHandler, createCheckinCommand, createMatchCommand, createTeamCommand } from './commands/play.js';
import { createTournamentPollCommand } from './commands/poll.js';
import { createChannelsGateway } from './discord/channels.js';
import { createDiscordPollGateway } from './discord/poll-gateway.js';
import { createPollFinalizer } from './services/finalizer.js';
import { createPollsService } from './services/polls.js';
import { createTournamentsService } from './services/tournaments.js';

/** Раз в 5 минут: достаточно быстро для голосования на несколько часов и не бьёт по Discord API. */
const POLL_FINALIZE_CRON = '*/5 * * * *';
const POLL_FINALIZE_BATCH_SIZE = 20;

/** Автоподтверждение результатов проверяется тем же тиком, что и голосования. */
const AUTO_CONFIRM_CRON = '*/5 * * * *';
const AUTO_CONFIRM_BATCH_SIZE = 20;

export interface TournamentsModuleDeps {
  db: Database;
  logger: Logger;
  /** Публичный адрес витрины: в объявлениях даём ссылку на сетку. */
  publicBaseUrl: string;
}

/**
 * Модуль турниров: голосование по дисциплине, сетка, регистрация, сбор составов,
 * репорт результатов с подтверждением соперника и разбор споров.
 *
 * Discord-клиент не приходит зависимостью конструктора: джобы получают живой ctx.client
 * на каждый тик планировщика, а команды — на каждый вызов, поэтому шлюзы строятся из него
 * на месте. Своих соединений модуль не держит, значит и teardown ему не нужен.
 *
 * Все подкоманды `/tournament` объявлены одним билдером в manage.ts: Discord допускает
 * только одну команду с этим именем, поэтому голосование подмешивается туда своим
 * execute, а не заводит второй `/tournament`.
 */
export function createTournamentsModule(deps: TournamentsModuleDeps): BotModule {
  const polls = createPollsService({ db: deps.db });
  const tournaments = createTournamentsService({ db: deps.db });
  const channels = createChannelsGateway(deps.logger);
  const play = { tournaments, channels, publicBaseUrl: deps.publicBaseUrl };

  const poll = createTournamentPollCommand({ polls });

  return {
    name: 'tournaments',

    commands: [
      createManageCommand(play, poll.execute),
      createTeamCommand(play),
      createMatchCommand(play),
      createCheckinCommand(play),
    ],

    events: [createButtonHandler(play)],

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
      {
        // Соперник молчит час — результат принимается. Без этого один неотвечающий игрок
        // останавливает всю сетку, и турнир упирается в присутствие организатора ровно
        // так же, как если бы результаты вбивал он сам.
        name: 'tournaments:auto-confirm',
        cron: AUTO_CONFIRM_CRON,
        async run(ctx): Promise<void> {
          const settled = await tournaments.autoConfirmDue(new Date(), AUTO_CONFIRM_BATCH_SIZE);
          if (settled.length > 0) {
            ctx.logger.info({ count: settled.length }, 'результаты приняты по молчанию соперника');
          }
        },
      },
    ],
  };
}
