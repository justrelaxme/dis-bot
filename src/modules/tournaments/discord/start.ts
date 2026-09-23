import type { Guild } from 'discord.js';
import type { Database } from '../../../core/db/client.js';
import { BRACKET_FORMAT_LABELS, EVENT_SIZE_LABELS, eventSize } from '../bracket.js';
import { createTournamentRooms, type PlayDeps } from '../commands/play.js';
import { entrantStrengths } from '../services/strength.js';
import type { BracketView } from '../services/tournaments.js';

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

export async function startTournament(
  deps: StartDeps,
  guild: Guild,
  tournamentId: number,
): Promise<StartedTournament> {
  const tournament = await deps.tournaments.byId(tournamentId);

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

  // Комнаты — после того, как сетка уже в базе: отказ Discord не должен отменять построенную
  // сетку. Недостающее догонит синхронизатор.
  await createTournamentRooms(deps, guild, tournamentId);

  if (deps.events && view.tournament.scheduledEventId) {
    await deps.events.begin(guild, view.tournament.scheduledEventId);
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
