import type { Guild } from 'discord.js';
import type { Logger } from '../../../core/logger.js';
import { advanceTournamentRooms, closeTournamentRooms, type PlayDeps } from '../commands/play.js';
import { closeTournamentPublic } from './closing.js';

/**
 * Синхронизатор турнира: приводит Discord к тому, что записано в базе.
 *
 * Появился из дефекта, и дефект был того же рода, что и все прошлые: у турнира пять путей
 * закрыть матч — кнопка соперника, молчание, решение организатора, неявка и проверка по
 * данным Dota, — и каждый путь сам решал, что делать дальше. Проверка Dota не решала ничего:
 * матч закрывался, а следующий оставался без ветки и драфта, и финал, закрытый так, не убирал
 * комнаты и не объявлял победителя. Итог в канал объявлений уходил только с одного пути из
 * пяти.
 *
 * Теперь пути ничего не решают — они зовут синхронизатор, а он смотрит на состояние:
 * - турнир идёт — у каждого играбельного матча должны быть ветка и драфт;
 * - турнир доигран и ещё не закрыт — убрать комнаты, объявить итог, снять афишу, ровно один
 *   раз (`claimCloseOut`).
 *
 * Функция идемпотентна: повторный вызов добирает то, что не вышло в прошлый раз, и не делает
 * лишнего. Поэтому её же раз в минуту зовёт джоба — страховка от путей, которые до неё не
 * дошли: перезапуск бота посреди закрытия, отказ Discord, код, который забыл позвать.
 */

export type SyncDeps = PlayDeps;

export type SyncOutcome = 'advanced' | 'closed' | 'idle';

/**
 * Очередь по турниру. Кнопка и джоба могут прийти к одному турниру одновременно, и обе
 * увидели бы матч без ветки — получилось бы две ветки на матч. Прогоны одного турнира идут
 * по одному; разные турниры друг друга не ждут.
 */
const queues = new Map<number, Promise<unknown>>();

export function syncTournament(
  deps: SyncDeps,
  guild: Guild,
  tournamentId: number,
  logger: Logger,
): Promise<SyncOutcome> {
  const previous = queues.get(tournamentId) ?? Promise.resolve();
  const run = previous.then(
    () => syncOnce(deps, guild, tournamentId, logger),
    () => syncOnce(deps, guild, tournamentId, logger),
  );
  const settled = run.catch(() => undefined);
  queues.set(tournamentId, settled);
  void settled.then(() => {
    // Хвост очереди — этот прогон: больше никто не ждёт, запись можно забыть.
    if (queues.get(tournamentId) === settled) queues.delete(tournamentId);
  });
  return run;
}

async function syncOnce(deps: SyncDeps, guild: Guild, tournamentId: number, logger: Logger): Promise<SyncOutcome> {
  const tournament = await deps.tournaments.byId(tournamentId);

  if (tournament.state === 'running') {
    await advanceTournamentRooms(deps, guild, tournamentId);
    return 'advanced';
  }

  if (tournament.state !== 'finished') return 'idle';

  // Сперва занять, потом делать: повторное объявление итога хуже неубранной комнаты —
  // комнату догонит уборка руками, а второй «🏆 итог» в канале уже не отменишь.
  const claimed = await deps.tournaments.claimCloseOut(tournamentId);
  if (!claimed) return 'idle';

  await closeTournamentRooms(deps, guild, tournamentId, logger);
  await closeTournamentPublic(deps, guild, claimed, logger);
  return 'closed';
}
