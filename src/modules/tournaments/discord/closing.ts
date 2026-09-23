import { ChannelType, type Guild } from 'discord.js';
import type { Logger } from '../../../core/logger.js';
import { standingsOf } from '../standings.js';
import type { TournamentRow } from '../schema.js';
import type { SettleAction, TournamentsService } from '../services/tournaments.js';
import type { TournamentEventsGateway } from './events.js';

/**
 * Что бот говорит, когда турнир закончился.
 *
 * Отдельным файлом, потому что закрыться турнир может пятью путями: кнопкой соперника,
 * молчанием, решением организатора, неявкой и проверкой по данным Dota. Вызывает это всё
 * синхронизатор (`sync.ts`) — один раз на турнир, какой бы путь его ни закрыл.
 */

export interface ClosingDeps {
  tournaments: TournamentsService;
  publicBaseUrl: string;
  /** Афиша во вкладке «События»: её надо закрыть, иначе турнир остаётся «идущим» навсегда. */
  events?: TournamentEventsGateway;
}

/**
 * Победитель турнира по его сетке. Отдельно от объявления, потому что нужен и афише: она
 * остаётся в списке прошедших событий, и без победителя не отвечает на единственный вопрос,
 * который к ней потом приходят.
 */
export async function championOf(
  deps: Pick<ClosingDeps, 'tournaments'>,
  tournamentId: number,
): Promise<string | null> {
  const view = await deps.tournaments.bracket(tournamentId);
  const places = standingsOf(view.matches);
  if (places.championId === null) return null;
  return view.entrants.find((entrant) => entrant.id === places.championId)?.displayName ?? null;
}

/**
 * Закрывает турнир снаружи: объявляет итог и снимает афишу. Вызывается и обработчиком кнопки,
 * и джобой автоподтверждения — у турнира два пути закрыться, и оба обязаны выглядеть одинаково.
 */
export async function closeTournamentPublic(
  deps: ClosingDeps,
  guild: Guild,
  tournament: TournamentRow,
  logger: Logger,
): Promise<void> {
  const champion = await championOf(deps, tournament.id);
  await announceFinish(deps, guild, tournament, logger);
  if (deps.events && tournament.scheduledEventId) {
    await deps.events.finish(guild, tournament.scheduledEventId, champion);
  }
}

/**
 * Оговорка под итогом — как именно закрылся финал. Раньше под каждым итогом стояло «принято
 * по молчанию соперника», хотя так закрывалась лишь часть финалов: подтверждённый кнопкой
 * результат выглядел спорным, а решение организатора — чужим.
 */
export function closureNote(action: SettleAction | null): string | null {
  switch (action) {
    case 'auto-confirm':
      // Результат приняли не игроки, а часы, и знать об этом надо.
      return 'Финал принят по молчанию соперника. Если результат неверен — напишите организатору.';
    case 'resolve':
      return 'Финал решил организатор.';
    case 'walkover':
      return 'Финал присуждён организатором без игры.';
    case 'verified':
      return 'Результат финала сверен с данными матча.';
    case 'confirm':
    case null:
      return null;
  }
}

/**
 * Объявляет победителя в канале объявлений турнира. Если канал не задан или недоступен, молча
 * не объявляем: это не повод считать закрытие турнира неудавшимся.
 */
export async function announceFinish(
  deps: ClosingDeps,
  guild: Guild,
  tournament: TournamentRow,
  logger: Logger,
): Promise<void> {
  if (!tournament.announceChannelId) return;

  try {
    const channel = await guild.channels.fetch(tournament.announceChannelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return;

    const view = await deps.tournaments.bracket(tournament.id);
    const places = standingsOf(view.matches);
    const nameOf = (id: number | null): string | null =>
      id === null ? null : (view.entrants.find((entrant) => entrant.id === id)?.displayName ?? null);

    const champion = nameOf(places.championId);
    if (!champion) return;

    const runnerUp = nameOf(places.runnerUpId);
    const third = nameOf(places.thirdId);

    const lines = [`## ${tournament.name} — итог`, `🏆 **${champion}**`];
    if (runnerUp) lines.push(`2. ${runnerUp}`);
    // Третье место есть только там, где оно честно определено — при двойном устранении.
    if (third) lines.push(`3. ${third}`);
    const note = closureNote(await deps.tournaments.finalClosure(tournament.id));
    lines.push('', ...(note ? [note] : []), `Сетка и места: ${deps.publicBaseUrl}/t/${tournament.id}`);

    await channel.send(lines.join('\n'));
  } catch (error) {
    logger.warn({ err: error, tournamentId: tournament.id }, 'не удалось объявить итог турнира');
  }
}
