import type { MatchRow, TournamentState } from '../schema.js';

/**
 * Можно ли исправить подтверждённый результат — и если нельзя, то почему.
 *
 * Раньше закрытый матч не исправлялся ничем: `settle` отвергал уже закрытые, а итог турнира при
 * этом советовал «/match resolve», который тоже ничего не мог. Опечатка при подтверждении
 * оставалась в сетке и в зале славы навсегда.
 *
 * Исправить — значит откатить продвижение: победитель уже стоит в следующем матче, а при
 * двойном устранении и проигравший — в нижней сетке. Откатывать можно только то, что ещё не
 * сыграно. Поэтому правило простое: следующие матчи этого исхода не должны быть ни начаты, ни
 * заявлены, ни задрафтованы. Всё, что дальше, — уже разбор руками, и сказать об этом надо прямо.
 *
 * Функция чистая: всё, что нужно для решения, приходит аргументами, и проверить её можно без базы.
 */

/** Следующий матч, куда этот матч кого-то доставил. */
export interface CorrectionTarget {
  match: Pick<
    MatchRow,
    'id' | 'state' | 'entrantAId' | 'entrantBId' | 'winnerEntrantId' | 'reportedAt' | 'liveAt' | 'threadId'
  >;
  /** В какой слот доставили. */
  side: 'a' | 'b';
  /** Кого доставил этот матч: прежнего победителя — дальше, прежнего проигравшего — вниз. */
  delivered: number;
  /** Сколько ходов уже сделано в драфте следующего матча. */
  draftMoves: number;
}

export interface CorrectionInput {
  tournamentState: TournamentState;
  match: Pick<MatchRow, 'state' | 'winnerEntrantId' | 'entrantAId' | 'entrantBId'>;
  /** Матч закрыт ботом как пропуск в сетке, а не сыгран. */
  bye: boolean;
  newWinnerId: number;
  targets: readonly CorrectionTarget[];
}

export function correctionBlocker(input: CorrectionInput): string | null {
  const { match } = input;

  if (input.tournamentState !== 'running') {
    return 'Турнир уже завершён: награды, опыт и запись в зале славы уже выданы, и исправить результат после этого нельзя.';
  }
  if (match.state !== 'confirmed' && match.state !== 'walkover') {
    return 'Исправить можно только закрытый матч. Открытый или оспоренный решается `/match resolve`.';
  }
  if (input.bye) return 'Это проход без игры по пропуску в сетке — исправлять в нём нечего.';
  if (input.newWinnerId !== match.entrantAId && input.newWinnerId !== match.entrantBId) {
    return 'Победитель должен быть одним из соперников этого матча.';
  }
  if (input.newWinnerId === match.winnerEntrantId) return 'Этот участник и так победитель матча.';

  for (const target of input.targets) {
    const holder = target.side === 'a' ? target.match.entrantAId : target.match.entrantBId;
    if (holder !== target.delivered) {
      return `Сетка после этого матча уже поменялась (матч №${target.match.id}) — исправить автоматически нельзя.`;
    }
    if (target.match.winnerEntrantId !== null || !['pending', 'ready'].includes(target.match.state)) {
      return `Следующий матч №${target.match.id} уже сыгран или заявлен — исправление сломало бы и его результат.`;
    }
    if (target.match.liveAt !== null || target.match.reportedAt !== null) {
      return `Следующий матч №${target.match.id} уже начался — исправлять поздно.`;
    }
    if (target.draftMoves > 0) {
      return `В следующем матче №${target.match.id} уже идёт драфт — исправлять поздно.`;
    }
  }
  return null;
}
