import { ChannelType, PermissionFlagsBits, type Client, type Guild, type TextChannel } from 'discord.js';
import type { Database } from '../../../core/db/client.js';
import type { Logger } from '../../../core/logger.js';
import { TOURNAMENT_GAME_LABELS } from '../games.js';
import type { ScheduleRow, TournamentGame } from '../schema.js';
import { checkinReminder, registrationPanel } from '../discord/onboarding.js';
import { eventLabel, localParts, parseClock, type CycleService } from './cycle.js';
import type { MessagesService } from './messages.js';
import type { PollsService } from './polls.js';
import { entrantStrengths } from './strength.js';
import type { TournamentsService } from './tournaments.js';

export interface RunnerDeps {
  db: Database;
  cycles: CycleService;
  polls: PollsService;
  tournaments: TournamentsService;
  publicBaseUrl: string;
  /**
   * Учёт отправленных сообщений — чтобы после турнира убрать сор и оставить летопись.
   * Необязателен: без него цикл идёт как раньше, только сор в канале остаётся.
   */
  messages?: MessagesService;
  /** Создание комнат: голосовые командам и ветки матчам. */
  onStarted(guild: Guild, tournamentId: number): Promise<void>;
}

const POLL_QUESTION = 'По какой дисциплине проводим турнир сегодня?';

/** За сколько минут до старта напоминать неотметившимся. */
const REMINDER_LEAD_MINUTES = 15;

async function announceChannel(client: Client, schedule: ScheduleRow): Promise<TextChannel | null> {
  if (!schedule.announceChannelId) return null;
  const channel = await client.channels.fetch(schedule.announceChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return null;
  return channel as TextChannel;
}

/**
 * Куда сказать, что день не состоялся, когда канал объявлений не задан или недоступен.
 *
 * Без этого автомат вёл себя худшим из возможных способов: включённое расписание каждый день
 * молча пропускало турнир, а причина уходила только в лог, которого никто не читает. Со
 * стороны это выглядело так, будто бот сломался, — и именно так и было доложено.
 *
 * Берём системный канал сервера, а если писать в него нельзя — первый текстовый, где у бота
 * есть право на сообщение. Написать не туда, куда хотелось бы, лучше, чем не написать вовсе:
 * сообщение говорит, что делать, и адресовано организатору.
 */
async function fallbackChannel(guild: Guild): Promise<TextChannel | null> {
  const me = guild.members.me;
  if (!me) return null;

  const writable = (channel: TextChannel | null | undefined): TextChannel | null =>
    channel && channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) ? channel : null;

  const system = writable(guild.systemChannel);
  if (system) return system;

  const channels = await guild.channels.fetch().catch(() => null);
  if (!channels) return null;
  for (const channel of channels.values()) {
    if (channel?.type !== ChannelType.GuildText) continue;
    const usable = writable(channel as TextChannel);
    if (usable) return usable;
  }
  return null;
}

/**
 * Суточный цикл: бот ведёт день сам, организатор ничего не нажимает.
 *
 * Вызывается тиком планировщика (каждые несколько минут), поэтому обязан быть
 * **идемпотентным**: за один день должно случиться одно голосование, один турнир и один
 * старт, сколько бы раз тик ни сработал. Это обеспечивает не проверка «а не делали ли мы
 * это уже», а уникальность `(guildId, cycleDate)` в базе и переходы стадий вперёд.
 *
 * Порядок дня: в pollAt — голосование; когда джоба финализации записала итог — объявление
 * условий и открытая регистрация; в startAt — жеребьёвка, сетка, комнаты.
 */
export async function runCycleTick(deps: RunnerDeps, client: Client, logger: Logger, now: Date): Promise<void> {
  for (const schedule of await deps.cycles.enabledSchedules()) {
    try {
      await runGuild(deps, client, logger, now, schedule);
    } catch (error) {
      // Сбой на одном сервере не должен обрывать остальные.
      logger.error({ err: error, guildId: schedule.guildId }, 'суточный цикл турниров упал');
    }
  }
}

async function runGuild(
  deps: RunnerDeps,
  client: Client,
  logger: Logger,
  now: Date,
  schedule: ScheduleRow,
): Promise<void> {
  /**
   * Запоминает отправленное, чтобы после турнира убрать сор. Никогда не роняет отправку:
   * сообщение уже ушло к людям, и падать из-за того, что мы о нём не запомнили, — обмен
   * полезного на аккуратное.
   */
  const remember = async (
    tournamentId: number,
    message: { channelId: string; id: string },
    transient: boolean,
  ): Promise<void> => {
    try {
      await deps.messages?.remember(
        tournamentId,
        { channelId: message.channelId, messageId: message.id },
        { transient },
      );
    } catch (error) {
      logger.warn({ err: error, tournamentId }, 'сообщение отправлено, но не записано для уборки');
    }
  };

  const { date, minutes } = localParts(now, schedule.timezone);
  const pollAt = parseClock(schedule.pollAt);
  const startAt = parseClock(schedule.startAt);
  if (pollAt === null || startAt === null) {
    logger.warn({ guildId: schedule.guildId }, 'в расписании турниров некорректное время, день пропущен');
    return;
  }

  const guild = await client.guilds.fetch(schedule.guildId).catch(() => null);
  if (!guild) return;

  let cycle = await deps.cycles.today(schedule.guildId, date);

  // Шаг 1: время голосования пришло, дня ещё нет.
  if (!cycle) {
    if (minutes < pollAt) return;

    const claimed = await deps.cycles.claimDay(schedule.guildId, date);
    // Пусто означает, что день уже занял другой прогон — это и есть защита от двойного
    // голосования, и это не ошибка.
    if (!claimed) return;
    cycle = claimed;

    // Незакрытый вчерашний турнир: если начать новый, участники окажутся в двух сетках
    // сразу, и по /match report будет не понять, к какому турниру он относится.
    const unfinished = await deps.tournaments.current(schedule.guildId);
    if (unfinished) {
      await deps.cycles.skipDay(cycle.id, `не закрыт турнир «${unfinished.name}»`);
      // Канал объявлений может быть не задан, а сказать об этом надо всё равно: иначе день
      // пропускается молча, и снаружи это выглядит поломкой.
      const channel = (await announceChannel(client, schedule)) ?? (await fallbackChannel(guild));
      await channel?.send(
        [
          `**Сегодняшний турнир не начинаем:** не закрыт предыдущий — «${unfinished.name}».`,
          'Пока он открыт, новый заводить нельзя: участники оказались бы в двух сетках сразу, и по `/match report` было бы не понять, к какому турниру он относится.',
          'Дожмите его результаты или закройте `/tournament manage cancel` — завтра цикл пойдёт как обычно.',
        ].join('\n'),
      );
      return;
    }

    const channel = await announceChannel(client, schedule);
    if (!channel) {
      await deps.cycles.skipDay(cycle.id, 'не задан канал объявлений');
      logger.warn({ guildId: schedule.guildId }, 'расписание включено, но канал объявлений не задан');

      // Говорим об этом людям, а не только логу. Молчаливый пропуск выглядит поломкой бота, и
      // ровно так его и восприняли: расписание включили, а на следующий день «ничего не
      // произошло». Сказать некуда — вот и не сказали.
      const fallback = await fallbackChannel(guild);
      await fallback?.send(
        [
          '**Турнир сегодня не начался: боту некуда объявлять.**',
          'Расписание включено, но канал объявлений не задан — без него бот не может ни открыть регистрацию, ни позвать людей.',
          'Задать канал: `/tournament schedule announce_channel:#канал`. После этого цикл пойдёт со следующего дня сам.',
        ].join('\n'),
      );
      return;
    }

    const games = schedule.games.length > 0 ? schedule.games : (['dota2', 'lol', 'valorant'] as TournamentGame[]);
    const message = await channel.send({
      content: 'Выбираем дисциплину на сегодня.',
      poll: {
        question: { text: POLL_QUESTION },
        answers: games.map((game) => ({ text: TOURNAMENT_GAME_LABELS[game] ?? game })),
        duration: schedule.pollHours,
        allowMultiselect: false,
      },
    });

    const poll = await deps.polls.createPoll({
      guildId: schedule.guildId,
      channelId: message.channelId,
      messageId: message.id,
      options: games,
      closesAt: message.poll?.expiresAt ?? new Date(now.getTime() + schedule.pollHours * 60 * 60 * 1_000),
      createdBy: client.user?.id ?? 'system',
    });

    await deps.cycles.updateCycle(cycle.id, { pollId: poll.id });
    return;
  }

  if (cycle.stage === 'skipped' || cycle.stage === 'finished') return;

  // Шаг 2: голосование закрылось — объявляем условия и открываем регистрацию.
  if (cycle.stage === 'poll') {
    if (cycle.pollId === null) return;
    const poll = await deps.polls.byId(cycle.pollId);
    if (!poll || poll.finalizedAt === null) return;

    // Ничья или ноль голосов: победителя нет, но день не теряем — берём первую из
    // предложенных дисциплин, чтобы турнир всё равно состоялся.
    const game = poll.winnerGame ?? poll.options[0] ?? 'dota2';
    const startMinutes = startAt;
    const startsAt = new Date(now.getTime() + Math.max(startMinutes - minutes, 30) * 60 * 1_000);

    const tournament = await deps.tournaments.create({
      guildId: schedule.guildId,
      name: `${TOURNAMENT_GAME_LABELS[game] ?? game} — ${date}`,
      game,
      format: schedule.format,
      entryMode: schedule.entryMode,
      teamSize: schedule.teamSize,
      maxEntrants: schedule.maxEntrants,
      seeding: 'rank',
      bestOf: schedule.bestOf,
      abilities: schedule.abilities,
      requireVerified: schedule.requireVerified,
      createdBy: client.user?.id ?? 'system',
      ...(schedule.announceChannelId ? { announceChannelId: schedule.announceChannelId } : {}),
      ...(schedule.teamCategoryId ? { teamCategoryId: schedule.teamCategoryId } : {}),
      ...(schedule.matchParentId ? { matchParentId: schedule.matchParentId } : {}),
    });

    await deps.tournaments.openRegistration(tournament.id, startsAt);
    await deps.cycles.updateCycle(cycle.id, { stage: 'registration', tournamentId: tournament.id });

    // Голосование — сор: оно про сегодняшний выбор, а не про итог. Запоминаем его только
    // сейчас, когда турнир наконец есть: на момент отправки привязать его было не к чему.
    await remember(tournament.id, { channelId: poll.channelId, id: poll.messageId }, true);

    const channel = await announceChannel(client, schedule);
    if (channel) {
      // Панель с кнопками, а не инструкция текстом: новичок не должен разбираться, какую
      // команду набрать, — он нажимает «Что мне делать?» и получает свой следующий шаг.
      const panel = registrationPanel(tournament);
      const sent = await channel.send({
        content: [
          panel.content,
          '',
          `Старт <t:${Math.floor(startsAt.getTime() / 1_000)}:t> · сетка: ${deps.publicBaseUrl}/t/${tournament.id}`,
        ].join('\n'),
        components: panel.components,
      });
      // Сор, и самый вредный: по живым кнопкам нажимают через сутки и не понимают, почему
      // ничего не происходит.
      await remember(tournament.id, sent, true);
    }
    return;
  }

  // Шаг 3: время старта — жеребьёвка, сетка, комнаты.
  if (cycle.stage === 'registration') {
    if (cycle.tournamentId === null) return;

    // За четверть часа до старта напоминаем тем, кто не отметился: команда, забывшая
    // нажать «Я готов», узнаёт об этом уже после жеребьёвки, когда её в сетке нет.
    // Условие на точное совпадение минуты, а тик — раз в минуту: напоминание уходит один раз.
    if (minutes === startAt - REMINDER_LEAD_MINUTES) {
      const waiting = (await deps.tournaments.activeEntrants(cycle.tournamentId)).filter(
        (entrant) => entrant.checkedInAt === null,
      );
      if (waiting.length > 0) {
        const channel = await announceChannel(client, schedule);
        const sent = await channel?.send(checkinReminder(waiting, REMINDER_LEAD_MINUTES));
        // Напоминание живёт четверть часа и после старта не значит ничего.
        if (sent) await remember(cycle.tournamentId, sent, true);
      }
    }

    if (minutes < startAt) return;

    const entrants = await deps.tournaments.activeEntrants(cycle.tournamentId);
    const ready = entrants.filter((entrant) => entrant.checkedInAt !== null);
    // Запасной канал и здесь: «никто не отметился» и «расписание на паузе» — как раз те две
    // вещи, из-за которых организатор идёт выяснять, почему бот молчит.
    const channel = (await announceChannel(client, schedule)) ?? (await fallbackChannel(guild));

    // Меньше двух — играть физически некому. Порога «меньше четырёх — отменяем» нет:
    // событие на две команды проводится, просто называется иначе.
    if (ready.length < 2) {
      await deps.tournaments.cancel(cycle.tournamentId);
      await deps.cycles.skipDay(cycle.id, `отметилось ${ready.length}`);
      const empty = await deps.cycles.bumpEmptyDays(schedule.guildId, true);
      await channel?.send(
        ready.length === 0
          ? `Сегодня никто не отметился, турнира не будет.${empty >= 3 ? ' Расписание поставлено на паузу — включить: `/tournament schedule enabled:true`.' : ''}`
          : `Отметился только один участник — играть не с кем, сегодня без турнира.`,
      );
      return;
    }

    await deps.cycles.bumpEmptyDays(schedule.guildId, false);

    // Сила состава считается по рангам этапа 1: сервису турниров про ранги знать не надо,
    // поэтому мост получает базу напрямую.
    const tournament = await deps.tournaments.byId(cycle.tournamentId);
    const strengths = await entrantStrengths(deps.db, cycle.tournamentId, tournament.game);

    const view = await deps.tournaments.start(cycle.tournamentId, strengths);
    await deps.cycles.updateCycle(cycle.id, { stage: 'running' });
    await deps.onStarted(guild, cycle.tournamentId);

    const seeded = view.entrants.filter((entrant) => entrant.seed !== null);
    const pairs = view.matches
      .filter((match) => match.round === 1 && match.entrantAId !== null && match.entrantBId !== null)
      .map((match) => {
        const nameOf = (id: number | null): string =>
          view.entrants.find((entrant) => entrant.id === id)?.displayName ?? '?';
        return `• ${nameOf(match.entrantAId)} — ${nameOf(match.entrantBId)}`;
      });

    const startMessage = await channel?.send(
      [
        `## ${view.tournament.name} — старт`,
        `${eventLabel(seeded.length)} · ${seeded.length} участников · жеребьёвка по силе состава`,
        '',
        '**Первый круг:**',
        ...pairs,
        '',
        'Победитель матча пишет `/match report`, соперник подтверждает кнопкой. Молчание час — результат принимается сам.',
        `Сетка: ${deps.publicBaseUrl}/t/${view.tournament.id}`,
      ].join('\n'),
    );
    // Пары первого круга — запись, а не сор: по ним потом восстанавливают, кто с кем играл.
    if (startMessage) await remember(cycle.tournamentId, startMessage, false);
    return;
  }

  // Шаг 4: турнир закончился — закрываем день.
  if (cycle.stage === 'running' && cycle.tournamentId !== null) {
    const tournament = await deps.tournaments.byId(cycle.tournamentId);
    if (tournament.state === 'finished' || tournament.state === 'cancelled') {
      await deps.cycles.updateCycle(cycle.id, { stage: 'finished' });
    }
  }
}
