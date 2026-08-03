import { ChannelType, type Guild } from 'discord.js';
import type { Logger } from '../../../core/logger.js';
import { standingsOf } from '../standings.js';
import type { TournamentRow } from '../schema.js';
import type { TournamentsService } from '../services/tournaments.js';
import type { TournamentEventsGateway } from './events.js';

/**
 * Что бот говорит, когда турнир закончился сам.
 *
 * Отдельным файлом, потому что закрыться турнир может двумя путями: соперник нажал
 * «Подтвердить» — тогда отвечает обработчик кнопки, — или соперник промолчал час, и результат
 * приняла джоба. Второй путь на ежедневном турнире встречается чаще первого, и до этой правки
 * он заканчивался молча: ни весть о победителе, ни уборка комнат не выполнялись, потому что
 * жили в обработчике команды.
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
    lines.push(
      '',
      // Оговорка обязательна: результат приняли не игроки, а часы, и знать об этом надо.
      'Последний результат принят по молчанию соперника. Если он неверен — `/match resolve` к организатору.',
      `Сетка и места: ${deps.publicBaseUrl}/t/${tournament.id}`,
    );

    await channel.send(lines.join('\n'));
  } catch (error) {
    logger.warn({ err: error, tournamentId: tournament.id }, 'не удалось объявить итог турнира');
  }
}
