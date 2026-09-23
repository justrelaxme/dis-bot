import { ChannelType, type Client, type Guild, type TextChannel } from 'discord.js';
import type { Logger } from '../../../core/logger.js';
import { closeTournamentRooms } from '../commands/play.js';
import type { TournamentRow } from '../schema.js';
import { checkinReminder } from './onboarding.js';
import { startAnnouncement, startTournament, type StartDeps } from './start.js';

/**
 * Время регистрации ручного турнира наступило — турнир стартует сам.
 *
 * Раньше время старта на панели регистрации было обещанием, которое никто не исполнял:
 * `registrationClosesAt` записывался и не читался. Турнир стоял в регистрации, пока
 * организатор не вспомнит про `/tournament start`, а стоящая регистрация к тому же блокировала
 * суточный автомат — он не начинает новый день, пока прошлый турнир не закрыт.
 *
 * Отметившихся меньше двоих — сразу не отменяем: организатор мог назначить время с запасом, а
 * люди ещё подходят. Предупреждаем в момент старта и ждём два часа; за это время хватит и
 * отметиться, и стартовать руками. Дальше — отмена: висящая регистрация хуже отменённой.
 */

/** За сколько до старта напоминать неотметившимся — как у суточного автомата. */
export const REMINDER_LEAD_MS = 15 * 60 * 1_000;

/** Сколько ждать после назначенного старта, если играть некому. */
export const EMPTY_GRACE_MS = 2 * 60 * 60 * 1_000;

/** Тик джобы — минута: шаги, привязанные к моменту, срабатывают в первую минуту окна. */
const TICK_MS = 60 * 1_000;

export type RegistrationStep = 'wait' | 'remind' | 'start' | 'warn' | 'cancel';

/**
 * Что делать с регистрацией сейчас. Чистая функция: всё решение — арифметика времени и числа
 * отметившихся, и проверять его надо без Discord.
 *
 * Разовые шаги («напомнить», «предупредить») привязаны к первой минуте своего окна: джоба
 * тикает раз в минуту, и так каждый шаг случается ровно один раз без отдельной отметки в базе.
 */
export function registrationStep(closesAt: Date, now: Date, checkedIn: number): RegistrationStep {
  const lead = closesAt.getTime() - now.getTime();

  if (lead > 0) {
    return lead <= REMINDER_LEAD_MS && lead > REMINDER_LEAD_MS - TICK_MS ? 'remind' : 'wait';
  }
  if (checkedIn >= 2) return 'start';

  const overdue = -lead;
  if (overdue >= EMPTY_GRACE_MS) return 'cancel';
  return overdue < TICK_MS ? 'warn' : 'wait';
}

export interface RegistrationDeps extends StartDeps {
  client: Client;
  logger: Logger;
}

async function announceChannel(client: Client, tournament: TournamentRow): Promise<TextChannel | null> {
  if (!tournament.announceChannelId) return null;
  const channel = await client.channels.fetch(tournament.announceChannelId).catch(() => null);
  return channel && channel.type === ChannelType.GuildText ? channel : null;
}

async function remember(
  deps: RegistrationDeps,
  tournamentId: number,
  message: { channelId: string; id: string } | undefined,
  transient: boolean,
): Promise<void> {
  if (!message) return;
  await deps.messages
    ?.remember(tournamentId, { channelId: message.channelId, messageId: message.id }, { transient })
    .catch((error: unknown) => deps.logger.warn({ err: error, tournamentId }, 'сообщение не записано для уборки'));
}

/** Один проход джобы: все ручные регистрации, у которых наступило или вот-вот наступит время. */
export async function closeDueRegistrations(deps: RegistrationDeps, now: Date): Promise<void> {
  const due = await deps.tournaments.manualRegistrationsClosingBy(new Date(now.getTime() + REMINDER_LEAD_MS));

  for (const tournament of due) {
    if (!tournament.registrationClosesAt) continue;
    try {
      const guild = deps.client.guilds.cache.get(tournament.guildId);
      if (!guild) continue;
      await stepFor(deps, guild, tournament, tournament.registrationClosesAt, now);
    } catch (error) {
      deps.logger.error({ err: error, tournamentId: tournament.id }, 'закрыть регистрацию турнира не удалось');
    }
  }
}

async function stepFor(
  deps: RegistrationDeps,
  guild: Guild,
  tournament: TournamentRow,
  closesAt: Date,
  now: Date,
): Promise<void> {
  const entrants = await deps.tournaments.activeEntrants(tournament.id);
  const checked = entrants.filter((entrant) => entrant.checkedInAt !== null);
  const step = registrationStep(closesAt, now, checked.length);
  if (step === 'wait') return;

  const channel = await announceChannel(deps.client, tournament);

  if (step === 'remind') {
    const waiting = entrants.filter((entrant) => entrant.checkedInAt === null);
    if (waiting.length === 0) return;
    // Напоминание живёт четверть часа и после старта не значит ничего — это сор.
    await remember(deps, tournament.id, await channel?.send(checkinReminder(waiting, 15)), true);
    return;
  }

  if (step === 'start') {
    const started = await startTournament(deps, guild, tournament.id);
    // Пары первого круга — запись: по ним потом восстанавливают, кто с кем играл.
    await remember(deps, tournament.id, await channel?.send(startAnnouncement(started, deps.publicBaseUrl)), false);
    deps.logger.info({ tournamentId: tournament.id }, 'турнир стартовал сам по времени регистрации');
    return;
  }

  const deadline = Math.floor((closesAt.getTime() + EMPTY_GRACE_MS) / 1_000);

  if (step === 'warn') {
    const sent = await channel?.send(
      [
        `**Время старта «${tournament.name}», а отметилось ${checked.length} — играть пока некому.**`,
        `Жду до <t:${deadline}:t>: кто записан — жмите **Я готов**, организатор может стартовать руками \`/tournament start\`. Если к этому времени отметятся двое, турнир начнётся сам; нет — отменится.`,
      ].join('\n'),
    );
    await remember(deps, tournament.id, sent, true);
    return;
  }

  // Отмена: та же уборка, что у ручной отмены, — панель регистрации с живыми кнопками иначе
  // осталась бы висеть, приглашая в турнир, которого уже нет.
  if (deps.events && tournament.scheduledEventId) {
    await deps.events.cancel(guild, tournament.scheduledEventId);
  }
  await closeTournamentRooms(deps, guild, tournament.id, deps.logger, 'delete');
  await deps.tournaments.cancel(tournament.id);
  await channel?.send(
    `«${tournament.name}» отменён: за два часа после назначенного старта отметилось ${checked.length}, а нужно хотя бы двое.`,
  );
}
