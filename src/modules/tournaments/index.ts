import type { Database } from '../../core/db/client.js';
import type { EventBus } from '../../core/events/bus.js';
import type { Logger } from '../../core/logger.js';
import type { BotModule } from '../../core/module.js';
import { createManageCommand } from './commands/manage.js';
import {
  createButtonHandler,
  createCheckinCommand,
  createMatchCommand,
  createTeamCommand,
  createTournamentRooms,
} from './commands/play.js';
import { createTournamentPollCommand } from './commands/poll.js';
import { createChannelsGateway } from './discord/channels.js';
import { createDiscordPollGateway } from './discord/poll-gateway.js';
import { createCycleService } from './services/cycle.js';
import { createPollFinalizer } from './services/finalizer.js';
import { createPollsService } from './services/polls.js';
import { runCycleTick } from './services/runner.js';
import { createTournamentsService } from './services/tournaments.js';

/** Раз в 5 минут: достаточно быстро для голосования на несколько часов и не бьёт по Discord API. */
const POLL_FINALIZE_CRON = '*/5 * * * *';
const POLL_FINALIZE_BATCH_SIZE = 20;

/** Автоподтверждение результатов проверяется тем же тиком, что и голосования. */
const AUTO_CONFIRM_CRON = '*/5 * * * *';
const AUTO_CONFIRM_BATCH_SIZE = 20;

/**
 * Суточный цикл проверяется каждую минуту: шаги привязаны к «14:00» и «20:00» в часовом
 * поясе сервера, и при тике раз в пять минут старт мог бы съехать на пять минут вперёд.
 * Тик дешёвый — один запрос за включёнными расписаниями, которых обычно одно.
 */
const CYCLE_CRON = '* * * * *';

export interface TournamentsModuleDeps {
  db: Database;
  logger: Logger;
  /** Шина: по завершении турнира публикуется победитель, чтобы прогрессия начислила награду. */
  bus: EventBus;
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
  const tournaments = createTournamentsService({ db: deps.db, bus: deps.bus });
  const cycles = createCycleService({ db: deps.db, logger: deps.logger });
  const channels = createChannelsGateway(deps.logger);
  const play = { tournaments, channels, publicBaseUrl: deps.publicBaseUrl };

  const poll = createTournamentPollCommand({ polls });

  return {
    name: 'tournaments',

    commands: [
      createManageCommand({ ...play, cycles }, poll.execute),
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
        // Суточный цикл: голосование, условия, регистрация, старт — без организатора.
        // Тик частый, потому что шаги привязаны ко времени в часовом поясе сервера, а
        // сама функция идемпотентна: за день случается одно голосование и один старт,
        // сколько бы раз тик ни сработал.
        name: 'tournaments:cycle',
        cron: CYCLE_CRON,
        async run(ctx): Promise<void> {
          await runCycleTick(
            {
              db: deps.db,
              cycles,
              polls,
              tournaments,
              publicBaseUrl: deps.publicBaseUrl,
              onStarted: async (guild, tournamentId) => {
                await createTournamentRooms(play, guild, tournamentId);
              },
            },
            ctx.client,
            ctx.logger,
            new Date(),
          );
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
