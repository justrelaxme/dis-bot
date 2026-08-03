import { ChannelType, type Guild } from 'discord.js';
import type { Logger } from '../../../core/logger.js';
import { standingsOf } from '../standings.js';
import type { TournamentRow } from '../schema.js';
import type { TournamentsService } from '../services/tournaments.js';

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
