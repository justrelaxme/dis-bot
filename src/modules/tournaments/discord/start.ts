import type { Guild } from 'discord.js';
import type { Database } from '../../../core/db/client.js';
import { UserError } from '../../../core/errors.js';
import type { Logger } from '../../../core/logger.js';
import { BRACKET_FORMAT_LABELS, EVENT_SIZE_LABELS, eventSize } from '../bracket.js';
import type { PlayDeps } from '../commands/play.js';
import { entrantStrengths } from '../services/strength.js';
import type { BracketView } from '../services/tournaments.js';
import { syncTournament } from './sync.js';

/**
 * Старт турнира: автосбор, жеребьёвка, сетка, комнаты, афиша «идёт».
 *
 * Путей к старту три — команда организатора, суточное расписание и наступившее время
 * регистрации, — и пока каждый собирал старт сам, они разошлись: ручной путь не переводил
 * афишу во вкладке «События» в «идёт», а объявление первого круга у расписания и у команды
 * говорили разное. Теперь последовательность одна, и текст объявления тоже один.
 */

export interface StartDeps extends PlayDeps {
  db: Database;
  logger: Logger;
}

export interface Assembled {
  teams: number;
  /** Кого не хватило на полный состав: в сетку они не попали. */
  benched: string[];
}

export interface StartedTournament {
  view: BracketView;
  assembled: Assembled;
}

/**
 * Один старт турнира за раз. Команда организатора и автостарт по времени могут прийти в одну
 * минуту, и тогда автосбор составов — цепочка отдельных записей — шёл бы дважды навстречу
 * себе: жеребьёвка увидела бы составы, собранные наполовину. Бот — один процесс, поэтому
 * замка в памяти достаточно; сетку от второго построения дополнительно держит CAS в базе.
 */
const starting = new Map<number, Promise<unknown>>();

export function startTournament(deps: StartDeps, guild: Guild, tournamentId: number): Promise<StartedTournament> {
  const previous = starting.get(tournamentId) ?? Promise.resolve();
  const run = previous.then(
    () => startOnce(deps, guild, tournamentId),
    () => startOnce(deps, guild, tournamentId),
  );
  const settled = run.catch(() => undefined);
  starting.set(tournamentId, settled);
  void settled.then(() => {
    if (starting.get(tournamentId) === settled) starting.delete(tournamentId);
  });
  return run;
}

async function startOnce(deps: StartDeps, guild: Guild, tournamentId: number): Promise<StartedTournament> {
  const tournament = await deps.tournaments.byId(tournamentId);
  // Проверка под замком: второй старт, дождавшийся первого, видит уже идущий турнир и не
  // начинает автосбор заново.
  if (tournament.state !== 'registration') throw new UserError('Этот турнир уже стартовал.');

  // Автосбор: одиночки превращаются в составы до жеребьёвки. Силу после этого считаем заново —
  // она теперь у команд, а не у отдельных людей, и старая карта указывала бы на участников,
  // которых больше нет.
  let assembled: Assembled = { teams: 0, benched: [] };
  if (tournament.autoTeams) {
    const before = await entrantStrengths(deps.db, tournamentId, tournament.game);
    assembled = await deps.tournaments.assembleTeams(tournamentId, before);
  }

  const strengths = await entrantStrengths(deps.db, tournamentId, tournament.game);
  const view = await deps.tournaments.start(tournamentId, strengths);

  // Всё дальше — уже после того, как сетка в базе, и старт отменить не может: отказ здесь
  // только записывается, а комнаты достроит страховочная джоба синхронизатора. Раньше сбой
  // на этом шаге обрывал весь старт — и объявление первого круга не уходило вовсе.
  //
  // Комнаты — через очередь синхронизатора, а не напрямую: иначе джоба, увидев идущий турнир,
  // заводила бы ветки тем же матчам одновременно со стартом.
  await syncTournament(deps, guild, tournamentId, deps.logger).catch((error: unknown) => {
    deps.logger.error({ err: error, tournamentId }, 'турнир стартовал, но комнаты не создались — достроит синхронизатор');
  });

  if (deps.events && view.tournament.scheduledEventId) {
    await deps.events.begin(guild, view.tournament.scheduledEventId).catch((error: unknown) => {
      deps.logger.warn({ err: error, tournamentId }, 'афиша не перешла в «идёт»');
    });
  }

  return { view, assembled };
}

/** Объявление старта: первый круг, пропуски, формат и что делать дальше. */
export function startAnnouncement(started: StartedTournament, publicBaseUrl: string): string {
  const { view, assembled } = started;
  const active = view.entrants.filter((entrant) => entrant.withdrawnAt === null && entrant.seed !== null);
  const nameOf = (id: number | null): string => view.entrants.find((entrant) => entrant.id === id)?.displayName ?? '?';

  // Только верхняя сетка: у нижней в момент старта соперников ещё нет — они появятся из
  // проигравших, а первый круг объявления это про то, кто играет сейчас.
  const firstRound = view.matches.filter((match) => match.bracket === 'upper' && match.round === 1);
  const pairs = firstRound
    .filter((match) => match.entrantAId !== null && match.entrantBId !== null)
    .map((match) => `• ${nameOf(match.entrantAId)} — ${nameOf(match.entrantBId)}`);
  const byes = firstRound
    .filter((match) => match.state === 'walkover')
    .map((match) => `• ${nameOf(match.winnerEntrantId)} проходит без игры`);

  // Формат берётся из турнира после старта: при двух отметившихся двойное устранение
  // выродилось в выбывание, и обещать второй шанс, которого не будет, нельзя.
  const doubleElim = view.tournament.format === 'double-elim';
  const draw = view.tournament.seeding === 'random' ? 'жеребьёвка случайная' : 'жеребьёвка по силе состава';

  return [
    `## ${view.tournament.name} — старт`,
    `${EVENT_SIZE_LABELS[eventSize(active.length)]} · ${active.length} участников · ${BRACKET_FORMAT_LABELS[view.tournament.format]} · ${draw}`,
    ...(assembled.teams > 0
      ? [
          '',
          `Составы собрал бот: ${assembled.teams} по ${view.tournament.teamSize}, раздача по силе, чтобы вышло ровно.`,
          ...(assembled.benched.length > 0
            ? [
                `Не хватило на полный состав: ${assembled.benched.map((id) => `<@${id}>`).join(', ')} — в сетку не попали. Играть неполной командой против полной — не турнир.`,
              ]
            : []),
        ]
      : []),
    '',
    '**Первый круг:**',
    ...pairs,
    ...(byes.length > 0 ? ['', ...byes] : []),
    '',
    doubleElim
      ? 'Проигравший не уходит: он попадает в нижнюю сетку и может дойти до финала оттуда. Выбывание — со второго поражения.'
      : 'Одно поражение — и всё: сетка на выбывание.',
    'Победитель матча пишет `/match report`, соперник подтверждает кнопкой. Молчание час — результат принимается сам.',
    `Сетка: ${publicBaseUrl}/t/${view.tournament.id}`,
  ].join('\n');
}
