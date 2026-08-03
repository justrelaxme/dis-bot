import type { Database } from '../../core/db/client.js';
import type { Cache } from '../../core/cache.js';
import type { EventBus } from '../../core/events/bus.js';
import type { FetchClient } from '../../core/http/fetch-client.js';
import type { Logger } from '../../core/logger.js';
import type { BotModule } from '../../core/module.js';
import type { RateLimiter } from '../../core/rate-limit.js';
import { createManageCommand } from './commands/manage.js';
import {
  createButtonHandler,
  createCheckinCommand,
  createMatchCommand,
  createTeamCommand,
  closeTournamentRooms,
  createTournamentRooms,
} from './commands/play.js';
import { announceFinish } from './discord/closing.js';
import { createTournamentPollCommand } from './commands/poll.js';
import { createStatsCommand } from './commands/stats.js';
import { createChannelsGateway } from './discord/channels.js';
import { createDiscordPollGateway } from './discord/poll-gateway.js';
import { createCycleService } from './services/cycle.js';
import { createDotaVerifier } from './services/dota-verify.js';
import { createDraftsService } from './services/drafts.js';
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

/**
 * Через сколько безделья турнир считается брошенным. Шесть часов — с запасом больше самого
 * долгого вечера: восемь команд в двойном устранении это шесть волн матчей, то есть около
 * четырёх часов. Проверка каждые полчаса: спешить некуда, а лишние запросы к базе ни к чему.
 */
const ABANDON_AFTER_MS = 6 * 60 * 60 * 1_000;
const ABANDON_CRON = '*/30 * * * *';

/**
 * Таймауты драфта проверяются каждые двадцать секунд — шесть полей в выражении, а не пять:
 * ход длится минуту, и минутная гранулярность растянула бы ожидание вдвое.
 */
const DRAFT_TIMEOUT_CRON = '*/20 * * * * *';
const DRAFT_TIMEOUT_BATCH = 20;

export interface TournamentsModuleDeps {
  db: Database;
  logger: Logger;
  /** Шина: по завершении турнира публикуется победитель, чтобы прогрессия начислила награду. */
  bus: EventBus;
  /** Публичный адрес витрины: в объявлениях даём ссылку на сетку. */
  publicBaseUrl: string;
  /**
   * Клиент и квота для OpenDota: по ним проверяется результат матча Dota. Оба
   * необязательны — без них работает обычный путь с подтверждением соперника, и это
   * штатное состояние, а не деградация.
   */
  fetchClientFor?: (provider: string) => FetchClient;
  rateLimiter?: RateLimiter;
  /** Кэш: в нём живёт справочник героев Dota для драфта. */
  cache: Cache;
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

  const dotaVerifier =
    deps.fetchClientFor && deps.rateLimiter
      ? createDotaVerifier({
          db: deps.db,
          client: deps.fetchClientFor('opendota'),
          rateLimiter: deps.rateLimiter,
        })
      : undefined;

  const drafts = createDraftsService({
    db: deps.db,
    cache: deps.cache,
    logger: deps.logger,
    // Два справочника — два клиента: у каждого свой предохранитель, и недоступный OpenDota
    // не должен закрывать список агентов Valorant вместе с собой.
    ...(deps.fetchClientFor
      ? {
          dotaClient: deps.fetchClientFor('opendota'),
          valorantClient: deps.fetchClientFor('valorant-api'),
        }
      : {}),
  });

  const play = {
    tournaments,
    channels,
    drafts,
    publicBaseUrl: deps.publicBaseUrl,
    ...(dotaVerifier ? { dotaVerifier } : {}),
  };

  const poll = createTournamentPollCommand({ polls });

  return {
    name: 'tournaments',

    commands: [
      createManageCommand({ ...play, cycles }, poll.execute),
      createTeamCommand(play),
      createMatchCommand(play),
      createCheckinCommand(play),
      createStatsCommand({ db: deps.db, publicBaseUrl: deps.publicBaseUrl }),
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
          if (settled.length === 0) return;
          ctx.logger.info({ count: settled.length }, 'результаты приняты по молчанию соперника');

          // Последний матч турнира чаще всего закрывается именно здесь, а не кнопкой. Значит,
          // и убирать за турниром обязана эта джоба: пока она этого не делала, голосовые
          // комнаты команд оставались на сервере навсегда.
          for (const { match, finished } of settled) {
            if (!finished) continue;
            try {
              const tournament = await tournaments.byId(match.tournamentId);
              const guild = await ctx.client.guilds.fetch(tournament.guildId).catch(() => null);
              if (!guild) continue;
              await closeTournamentRooms(play, guild, tournament.id, ctx.logger);
              await announceFinish(play, guild, tournament, ctx.logger);
            } catch (error) {
              // Сбой уборки одного турнира не должен обрывать остальные принятые результаты.
              ctx.logger.error(
                { err: error, matchId: match.id },
                'турнир закрылся по молчанию, но убрать за ним не удалось',
              );
            }
          }
        },
      },
      {
        /**
         * Просроченный ход драфта двигается сам. Без этого закрытый браузер одного капитана
         * останавливал бы матч навсегда — та же болезнь, что у матча без заявленного
         * результата, и лечится так же: решение принимает сервер, а не чьё-то присутствие.
         *
         * Каждые двадцать секунд: ход длится минуту, и ждать лишние полминуты после
         * истечения — значит держать соперника в неизвестности дважды дольше нужного.
         */
        name: 'tournaments:draft-timeout',
        cron: DRAFT_TIMEOUT_CRON,
        async run(ctx): Promise<void> {
          for (const draft of await drafts.overdue(new Date(), DRAFT_TIMEOUT_BATCH)) {
            const state = await drafts.advanceOverdue(draft).catch((error: unknown) => {
              ctx.logger.warn({ err: error, draftId: draft.id }, 'просроченный ход драфта не сдвинулся');
              return null;
            });
            if (!state) continue;

            ctx.logger.info(
              { draftId: draft.id, matchId: draft.matchId, step: state.view.step, done: state.view.done },
              'ход драфта сделан по истечении времени',
            );
          }
        },
      },
      {
        /**
         * Брошенный турнир закрывается сам. Иначе один вечер, когда людям стало неинтересно
         * и они разошлись не дописав результаты, выключал ежедневные турниры навсегда:
         * матч без заявленного результата остаётся играбельным вечно, турнир — running, а
         * автомат намеренно не начинает новый день, пока предыдущий не закрыт.
         *
         * Закрываем отменой, а не присуждением побед: победа тому, кто не играл, — неправда
         * в записи, и она навсегда останется в зале славы. Пропущенный вечер честнее
         * поддельного чемпиона.
         */
        name: 'tournaments:abandon',
        cron: ABANDON_CRON,
        async run(ctx): Promise<void> {
          const stale = await tournaments.staleRunning(new Date(), ABANDON_AFTER_MS);

          for (const { tournament, openMatches } of stale) {
            if (openMatches === 0) {
              // Все матчи закрыты, а турнир нет — это дефект продвижения победителя, а не
              // брошенный вечер. Отмена уничтожила бы уже определённого чемпиона.
              ctx.logger.error(
                { tournamentId: tournament.id },
                'турнир должен был закрыться сам: все матчи закрыты, состояние running — разберитесь вручную, автоматически не отменяю',
              );
              continue;
            }

            const entrants = await tournaments.activeEntrants(tournament.id);
            await tournaments.cancel(tournament.id);

            const guild = ctx.client.guilds.cache.get(tournament.guildId);
            if (guild) {
              for (const entrant of entrants) {
                if (entrant.voiceChannelId) await channels.deleteChannel(guild, entrant.voiceChannelId);
              }
            }

            ctx.logger.warn(
              { tournamentId: tournament.id, openMatches, hours: ABANDON_AFTER_MS / 3_600_000 },
              'турнир закрыт как брошенный: результаты не отмечались',
            );

            if (!tournament.announceChannelId) continue;
            const channel = await ctx.client.channels.fetch(tournament.announceChannelId).catch(() => null);
            if (!channel?.isSendable()) continue;

            await channel
              .send({
                content: [
                  `## «${tournament.name}» закрыт`,
                  `Результаты не отмечались ${ABANDON_AFTER_MS / 3_600_000} часов, поэтому турнир закрыт как брошенный, а комнаты убраны.`,
                  '',
                  'Так сделано нарочно: незакрытый турнир останавливал бы ежедневный цикл, и завтрашнего вечера просто не было бы. Победителя не присуждаем — победа тому, кто не играл, осталась бы в зале славы навсегда.',
                  '',
                  'Чтобы такого не повторялось, победитель матча пишет `/match report` сразу после игры: соперник подтверждает кнопкой, а если молчит час — результат принимается сам.',
                ].join('\n'),
              })
              .catch(() => undefined);
          }
        },
      },
    ],
  };
}
