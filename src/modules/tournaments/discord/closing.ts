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
 * Итог турнира, собранный заранее: текст объявления и победитель для афиши.
 *
 * Сборка отделена от отправки ради повторов. Всё, что может упасть на базе, случается здесь —
 * до того, как синхронизатор займёт отметку о закрытии, — и упавшая сборка просто повторится
 * через минуту. А отправка идёт уже после отметки и ровно один раз: второй «итог» в канале не
 * отменишь.
 */
export interface PreparedClosing {
  /** Текст итога; `null` — объявлять нечего (нет канала или не определился победитель). */
  message: string | null;
  champion: string | null;
}

export async function prepareClosing(deps: ClosingDeps, tournament: TournamentRow): Promise<PreparedClosing> {
  const view = await deps.tournaments.bracket(tournament.id);
  const places = standingsOf(view.matches);
  const nameOf = (id: number | null): string | null =>
    id === null ? null : (view.entrants.find((entrant) => entrant.id === id)?.displayName ?? null);

  const champion = nameOf(places.championId);
  if (!champion || !tournament.announceChannelId) return { message: null, champion };

  const runnerUp = nameOf(places.runnerUpId);
  const third = nameOf(places.thirdId);
  const lines = [`## ${tournament.name} — итог`, `🏆 **${champion}**`];
  if (runnerUp) lines.push(`2. ${runnerUp}`);
  // Третье место есть только там, где оно честно определено — при двойном устранении.
  if (third) lines.push(`3. ${third}`);

  const note = closureNote(await deps.tournaments.finalClosure(tournament.id));
  lines.push('', ...(note ? [note] : []), `Сетка и места: ${deps.publicBaseUrl}/t/${tournament.id}`);
  return { message: lines.join('\n'), champion };
}

/**
 * Отправляет собранный итог и закрывает афишу. Только Discord, никаких чтений базы: отказ
 * здесь не повторяется, поэтому пишется в лог, а не бросается.
 */
export async function publishClosing(
  deps: ClosingDeps,
  guild: Guild,
  tournament: TournamentRow,
  prepared: PreparedClosing,
  logger: Logger,
): Promise<void> {
  if (prepared.message && tournament.announceChannelId) {
    try {
      const channel = await guild.channels.fetch(tournament.announceChannelId).catch(() => null);
      if (channel && channel.type === ChannelType.GuildText) await channel.send(prepared.message);
    } catch (error) {
      logger.warn({ err: error, tournamentId: tournament.id }, 'не удалось объявить итог турнира');
    }
  }
  if (deps.events && tournament.scheduledEventId) {
    await deps.events.finish(guild, tournament.scheduledEventId, prepared.champion);
  }
}
