import { ChannelType, type Client, type Guild, type TextChannel } from 'discord.js';
import type { Database } from '../../../core/db/client.js';
import type { Logger } from '../../../core/logger.js';
import { TOURNAMENT_GAME_LABELS } from '../games.js';
import type { ScheduleRow, TournamentGame } from '../schema.js';
import { announcementText, eventLabel, localParts, parseClock, type CycleService } from './cycle.js';
import type { PollsService } from './polls.js';
import { entrantStrengths } from './strength.js';
import type { TournamentsService } from './tournaments.js';

export interface RunnerDeps {
  db: Database;
  cycles: CycleService;
  polls: PollsService;
  tournaments: TournamentsService;
  publicBaseUrl: string;
  /** Создание комнат: голосовые командам и ветки матчам. */
  onStarted(guild: Guild, tournamentId: number): Promise<void>;
}

const POLL_QUESTION = 'По какой дисциплине проводим турнир сегодня?';

async function announceChannel(client: Client, schedule: ScheduleRow): Promise<TextChannel | null> {
  if (!schedule.announceChannelId) return null;
  const channel = await client.channels.fetch(schedule.announceChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return null;
  return channel as TextChannel;
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
      const channel = await announceChannel(client, schedule);
      await channel?.send(
        `Сегодняшний турнир не начинаем: не закрыт предыдущий — «${unfinished.name}». Закройте его, и завтра цикл пойдёт как обычно.`,
      );
      return;
    }

    const channel = await announceChannel(client, schedule);
    if (!channel) {
      await deps.cycles.skipDay(cycle.id, 'не задан канал объявлений');
      logger.warn({ guildId: schedule.guildId }, 'расписание включено, но канал объявлений не задан');
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
      entryMode: schedule.entryMode,
      teamSize: schedule.teamSize,
      maxEntrants: schedule.maxEntrants,
      seeding: 'rank',
      bestOf: schedule.bestOf,
      requireVerified: schedule.requireVerified,
      createdBy: client.user?.id ?? 'system',
      ...(schedule.announceChannelId ? { announceChannelId: schedule.announceChannelId } : {}),
      ...(schedule.teamCategoryId ? { teamCategoryId: schedule.teamCategoryId } : {}),
      ...(schedule.matchParentId ? { matchParentId: schedule.matchParentId } : {}),
    });

    await deps.tournaments.openRegistration(tournament.id, startsAt);
    await deps.cycles.updateCycle(cycle.id, { stage: 'registration', tournamentId: tournament.id });

    const channel = await announceChannel(client, schedule);
    await channel?.send(
      announcementText({
        name: tournament.name,
        game,
        entryMode: schedule.entryMode,
        teamSize: schedule.teamSize,
        maxEntrants: schedule.maxEntrants,
        startsAtUnix: Math.floor(startsAt.getTime() / 1_000),
        bracketUrl: `${deps.publicBaseUrl}/t/${tournament.id}`,
      }),
    );
    return;
  }

  // Шаг 3: время старта — жеребьёвка, сетка, комнаты.
  if (cycle.stage === 'registration') {
    if (minutes < startAt) return;
    if (cycle.tournamentId === null) return;

    const entrants = await deps.tournaments.activeEntrants(cycle.tournamentId);
    const ready = entrants.filter((entrant) => entrant.checkedInAt !== null);
    const channel = await announceChannel(client, schedule);

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

    await channel?.send(
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
