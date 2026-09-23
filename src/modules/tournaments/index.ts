import type { Database } from '../../core/db/client.js';
import type { Cache } from '../../core/cache.js';
import type { EventBus } from '../../core/events/bus.js';
import type { FetchClient } from '../../core/http/fetch-client.js';
import type { Logger } from '../../core/logger.js';
import type { BotModule } from '../../core/module.js';
import type { RateLimiter } from '../../core/rate-limit.js';
import { createHoyolabChronicle } from '../identity/providers/hoyolab.js';
import { createManageCommand } from './commands/manage.js';
import {
  createButtonHandler,
  createCheckinCommand,
  createMatchCommand,
  createTeamCommand,
  closeTournamentRooms,
} from './commands/play.js';
import { refreshMatchCard } from './discord/match-card.js';
import { createMatchFlowHandler, runMatchFlow } from './discord/match-flow.js';
import { closeDueRegistrations } from './discord/registration.js';
import { startTournament } from './discord/start.js';
import { staffAlert } from './discord/staff.js';
import { syncTournament } from './discord/sync.js';
import { createFormatAutocomplete, createMatchAutocomplete } from './discord/autocomplete.js';
import { createTournamentEventsGateway } from './discord/events.js';
import { createTournamentPollCommand } from './commands/poll.js';
import { createCastCommand } from './commands/cast.js';
import { createRosterCommand } from './commands/roster.js';
import { createSeasonCommand } from './commands/season.js';
import { createStatsCommand } from './commands/stats.js';
import { createChannelsGateway } from './discord/channels.js';
import { createDiscordPollGateway } from './discord/poll-gateway.js';
import { createCycleService } from './services/cycle.js';
import { createFormatsService } from './services/formats.js';
import { createRostersService } from './services/rosters.js';
import { createCircuitService } from './services/circuit.js';
import { createTournamentSettingsService } from './services/settings.js';
import { createMessagesService } from './services/messages.js';
import { createDotaVerifier } from './services/dota-verify.js';
import { createDraftsService } from './services/drafts.js';
import { createPollFinalizer } from './services/finalizer.js';
import { createPollsService } from './services/polls.js';
import { runCycleTick } from './services/runner.js';
import { genshinUidOfEntrant } from './services/strength.js';
import { createTournamentsService } from './services/tournaments.js';

/** Раз в 5 минут: достаточно быстро для голосования на несколько часов и не бьёт по Discord API. */
const POLL_FINALIZE_CRON = '*/5 * * * *';
const POLL_FINALIZE_BATCH_SIZE = 20;

/** Автоподтверждение результатов проверяется тем же тиком, что и голосования. */
const AUTO_CONFIRM_CRON = '*/5 * * * *';
const AUTO_CONFIRM_BATCH_SIZE = 20;

/**
 * Страховочный прогон синхронизатора — раз в минуту. Он дешёвый: идущий турнир на сервере
 * один, и прогон по нему это два запроса «кому нужна ветка» и «кому нужен драфт».
 */
const RECONCILE_CRON = '* * * * *';

/**
 * Ручные регистрации проверяются каждую минуту: напоминание и старт привязаны к минуте, и при
 * тике реже старт съезжал бы вперёд, а напоминание могло бы не случиться вовсе.
 */
const REGISTRATION_CLOSE_CRON = '* * * * *';

/** Неявки и напоминания — раз в минуту: и то и другое привязано к минутам с начала матча. */
const MATCH_FLOW_CRON = '* * * * *';

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
  /**
   * Cookie HoYoLAB владельца бота: с ними драфт персонажей Genshin помечает, у кого какой
   * персонаж есть. Без них пометок нет, и это штатное состояние.
   */
  hoyolabCookie?: string;
  /**
   * Выдача пропусков в конструктор форматов на сайте. Живёт в веб-модуле, потому что пропуск
   * — про витрину, а не про турниры; сюда приходит зависимостью, чтобы команда `/tournament
   * formats` могла выдать ссылку, не зная, как устроен доступ к сайту.
   */
  grants?: {
    issue(input: {
      guildId: string;
      userId: string;
      scope: 'formats' | 'roster' | 'cast';
    }): Promise<{ token: string; expiresAt: Date }>;
  };
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
  const tournaments = createTournamentsService({ db: deps.db, bus: deps.bus, logger: deps.logger });
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
    bus: deps.bus,
    // Три справочника — три клиента: у каждого свой предохранитель, и недоступный OpenDota
    // не должен закрывать список агентов Valorant вместе с собой.
    ...(deps.fetchClientFor
      ? {
          dotaClient: deps.fetchClientFor('opendota'),
          valorantClient: deps.fetchClientFor('valorant-api'),
          enkaClient: deps.fetchClientFor('enka'),
          riotClient: deps.fetchClientFor('ddragon'),
        }
      : {}),
    // Летопись читается отдельным клиентом: у неё свой предохранитель, и её отказ не должен
    // закрывать справочник персонажей, из которого собирается сам пул.
    ...(deps.fetchClientFor && deps.rateLimiter
      ? {
          chronicle: createHoyolabChronicle({
            client: deps.fetchClientFor('hoyolab'),
            rateLimiter: deps.rateLimiter,
            ...(deps.hoyolabCookie ? { cookie: deps.hoyolabCookie } : {}),
          }),
          genshinUidOf: (entrantId: number) => genshinUidOfEntrant(deps.db, entrantId),
          declaredOf: async (tournamentId: number, entrantId: number) => {
            // Заявка привязана к человеку, а участник в турнире по Genshin — это один человек.
            // У команды заявок нет: этаж Бездны проходят в одиночку.
            const members = await tournaments.membersOf(entrantId);
            const userId = members.length === 1 ? members[0] : undefined;
            if (!userId) return null;
            const roster = await rosters.byPlayer(tournamentId, userId);
            return roster ? { characters: roster.characters, immune: roster.immune } : null;
          },
        }
      : {}),
  });

  const formats = createFormatsService({ db: deps.db });
  const rosters = createRostersService({ db: deps.db });
  const messages = createMessagesService({ db: deps.db });
  const events = createTournamentEventsGateway(deps.logger);

  const settings = createTournamentSettingsService({ db: deps.db });
  const circuit = createCircuitService({ db: deps.db });
  const staff = { settings, cache: deps.cache, logger: deps.logger };

  const play = {
    tournaments,
    channels,
    drafts,
    messages,
    events,
    staff,
    publicBaseUrl: deps.publicBaseUrl,
    ...(dotaVerifier ? { dotaVerifier } : {}),
  };

  const poll = createTournamentPollCommand({ polls });

  return {
    name: 'tournaments',

    commands: [
      createManageCommand(
        { ...play, cycles, formats, settings, ...(deps.grants ? { grants: deps.grants } : {}) },
        poll.execute,
      ),
      createTeamCommand(play),
      createMatchCommand(play),
      createCheckinCommand(play),
      createStatsCommand({ db: deps.db, publicBaseUrl: deps.publicBaseUrl }),
      createSeasonCommand({ circuit, staff, publicBaseUrl: deps.publicBaseUrl }),
      // Заявку собирает участник, а у `/tournament` стоит право «Управление сервером» — поэтому
      // своя команда, доступная всем.
      ...(deps.grants
        ? [
            createRosterCommand({ tournaments, grants: deps.grants, publicBaseUrl: deps.publicBaseUrl }),
            createCastCommand({ tournaments, staff, grants: deps.grants, publicBaseUrl: deps.publicBaseUrl }),
          ]
        : []),
    ],

    events: [
      createButtonHandler(play),
      createMatchFlowHandler(play),
      createFormatAutocomplete({ formats }),
      createMatchAutocomplete({ tournaments }),
    ],

    async setup(ctx): Promise<void> {
      // Турнир доигран — очки сезонной серии всем, кто играл. Без открытого сезона начисление
      // ничего не делает. Имена игроков команд подтягиваются из Discord в фоне: для таблицы
      // на сайте, где упоминания не работают.
      ctx.bus.on('tournament.finished', async ({ tournamentId, guildId }) => {
        const result = await circuit.award(tournamentId).catch((error: unknown) => {
          ctx.logger.error({ err: error, tournamentId }, 'очки сезонной серии не начислены');
          return null;
        });
        if (!result || result.unnamed.length === 0) return;
        const guild = ctx.client.guilds.cache.get(guildId);
        if (!guild) return;
        void (async () => {
          for (const userId of result.unnamed) {
            const member = await guild.members.fetch(userId).catch(() => null);
            if (member) await circuit.nameUnnamed(tournamentId, userId, member.displayName);
          }
        })().catch((error: unknown) => ctx.logger.warn({ err: error, tournamentId }, 'имена для таблицы серии не подтянулись'));
      });

      // Матч начался — пошёл таймер драфта. Слушатель, а не вызов: начать матч может кнопка в
      // ветке, кнопка на странице драфта и организатор, и таймер обязан пойти в любом случае.
      ctx.bus.on('match.live', async (payload) => {
        await drafts.arm(payload.matchId).catch((error: unknown) => {
          ctx.logger.error({ err: error, matchId: payload.matchId }, 'матч начался, но таймер драфта не запустился');
        });
        // Карточка в ветке — в фон: событие публикуется посреди нажатия, а правка сообщения
        // Discord не должна съедать окно ответа.
        const guild = ctx.client.guilds.cache.get(payload.guildId);
        if (guild) {
          void refreshMatchCard(play, guild, payload.matchId).catch((error: unknown) => {
            ctx.logger.warn({ err: error, matchId: payload.matchId }, 'карточка начавшегося матча не перерисовалась');
          });
        }
      });
    },

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
              messages,
              events,
              publicBaseUrl: deps.publicBaseUrl,
              start: (guild, tournamentId) =>
                startTournament({ ...play, db: deps.db, logger: ctx.logger }, guild, tournamentId),
              onCancelled: async (guild, tournamentId) => {
                await closeTournamentRooms(play, guild, tournamentId, ctx.logger, 'delete');
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

          // Матч турнира чаще всего закрывается именно здесь, а не кнопкой — и последний, и
          // любой другой. Что после этого нужно турниру — ветка и драфт следующему матчу или
          // уборка с итогом, — решает синхронизатор, общий для всех путей закрытия матча.
          const touched = new Set(settled.map(({ match }) => match.tournamentId));
          for (const tournamentId of touched) {
            try {
              const tournament = await tournaments.byId(tournamentId);
              const guild = await ctx.client.guilds.fetch(tournament.guildId).catch(() => null);
              if (!guild) continue;
              await syncTournament(play, guild, tournament.id, ctx.logger);
            } catch (error) {
              // Сбой одного турнира не должен обрывать остальные принятые результаты: их
              // догонит джоба tournaments:reconcile через минуту.
              ctx.logger.error(
                { err: error, tournamentId },
                'результат принят по молчанию, но догнать сетку или закрыть турнир не удалось',
              );
            }
          }
        },
      },
      {
        /**
         * Время регистрации ручного турнира наступило — старт сам, как и обещает панель. Раньше
         * это время записывалось и не читалось: турнир ждал `/tournament start`, а висящая
         * регистрация к тому же блокировала суточный автомат. Подробности — в
         * `discord/registration.ts`.
         */
        name: 'tournaments:registration-close',
        cron: REGISTRATION_CLOSE_CRON,
        async run(ctx): Promise<void> {
          await closeDueRegistrations(
            {
              ...play,
              db: deps.db,
              client: ctx.client,
              logger: ctx.logger,
              // Сутки с запасом покрывают и окно напоминания, и два часа ожидания.
              once: async (key) => (await deps.cache.incrementInWindow(key, 24 * 60 * 60 * 1_000)) === 1,
            },
            new Date(),
          );
        },
      },
      {
        /**
         * Ход матча: неявка дольше десяти минут — в штаб с кнопками решения, заявленный и не
         * подтверждённый результат — напоминание сопернику за четверть часа до того, как он
         * примется сам. Подробности — в `discord/match-flow.ts`.
         */
        name: 'tournaments:match-flow',
        cron: MATCH_FLOW_CRON,
        async run(ctx): Promise<void> {
          await runMatchFlow(play, ctx.client, ctx.logger, new Date());
        },
      },
      {
        /**
         * Страховка синхронизатора. Каждый путь закрытия матча зовёт его сам, но путь может не
         * дойти: бот перезапустился посреди закрытия, Discord отказал, новый код забыл позвать.
         * Раз в минуту идущие турниры догоняют ветки и драфты, а доигранные — закрываются, если
         * этого ещё никто не сделал. Повторный прогон ничего не дублирует: синхронизатор
         * идемпотентен, а закрытие занимается отметкой ровно один раз.
         */
        name: 'tournaments:reconcile',
        cron: RECONCILE_CRON,
        async run(ctx): Promise<void> {
          for (const tournament of await tournaments.needingSync()) {
            const guild = ctx.client.guilds.cache.get(tournament.guildId);
            if (!guild) continue;
            try {
              const outcome = await syncTournament(play, guild, tournament.id, ctx.logger);
              if (outcome === 'closed') {
                ctx.logger.info({ tournamentId: tournament.id }, 'доигранный турнир закрыт страховочной джобой');
              }
            } catch (error) {
              ctx.logger.error({ err: error, tournamentId: tournament.id }, 'синхронизация турнира не удалась');
              // Джоба повторит через минуту, но если отказ стойкий (нет прав, удалён канал),
              // повторы ничего не дадут — нужен человек. Раз в час, а не каждую минуту.
              await staffAlert(staff, guild, {
                tournament,
                text: `⚠️ Турнир «${tournament.name}»: не выходит ${tournament.state === 'finished' ? 'закрыть турнир (убрать комнаты и объявить итог)' : 'завести ветки или драфт следующим матчам'} — ${error instanceof Error ? error.message : String(error)}. Бот повторяет каждую минуту; если причина в правах бота, повторы не помогут.`,
                dedupeKey: `sync:${tournament.id}`,
              }).catch(() => undefined);
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

            const guild = ctx.client.guilds.cache.get(tournament.guildId);
            // Уборка до смены состояния и общая со всеми остальными путями: брошенный турнир
            // оставляет за собой то же самое, что отменённый. Ветки удаляются — результат
            // так и не был отмечен, спорить о нём не о чем, а архив копился бы вечно.
            if (guild) {
              await closeTournamentRooms(
                { tournaments, channels, messages },
                guild,
                tournament.id,
                ctx.logger,
                'delete',
              );
            }
            await tournaments.cancel(tournament.id);

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
