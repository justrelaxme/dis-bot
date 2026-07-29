import { TOURNAMENT_GAME_LABELS } from './games.js';
import type { TournamentGame } from './schema.js';

export interface GameTally {
  game: TournamentGame;
  voteCount: number;
}

export type PollOutcome =
  | { kind: 'winner'; game: TournamentGame; tally: readonly GameTally[] }
  | { kind: 'tie'; games: readonly TournamentGame[]; tally: readonly GameTally[] }
  | { kind: 'no-votes'; tally: readonly GameTally[] };

/**
 * Победитель определяется числом голосов, а не порядком в tally. Порядок вариантов
 * голосования Discord ничего не гарантирует про число голосов за них (сам порядок
 * случаен для игрока), поэтому "вернуть первый элемент массива" — это не
 * приемлемый запасной вариант, а баг: он объявил бы неверную дисциплину в любом
 * голосовании, где реальный победитель оказался не первым в списке.
 *
 * Ничья (два и больше вариантов набрали одинаковый максимум) — штатный исход, а
 * не ошибка: она возвращается отдельным вариантом kind: 'tie' со списком ВСЕХ
 * дисциплин, входящих в неё, а не молча решается в пользу одной по порядку.
 *
 * Ноль голосов — тоже законный, отдельно различимый исход (kind: 'no-votes'), а
 * не вырожденный случай "ничьей между всеми": даже если бы у всех вариантов был
 * одинаковый (нулевой) максимум, называть это "ничьей" было бы вводящим в
 * заблуждение — на самом деле никто вообще не проголосовал.
 */
export function determineOutcome(tally: readonly GameTally[]): PollOutcome {
  const totalVotes = tally.reduce((sum, entry) => sum + entry.voteCount, 0);
  if (totalVotes === 0) {
    return { kind: 'no-votes', tally };
  }

  const maxVotes = Math.max(...tally.map((entry) => entry.voteCount));
  const top = tally.filter((entry) => entry.voteCount === maxVotes);
  const [onlyWinner] = top;

  if (top.length === 1 && onlyWinner) {
    return { kind: 'winner', game: onlyWinner.game, tally };
  }

  return { kind: 'tie', games: top.map((entry) => entry.game), tally };
}

/** Согласование слова «голос» с числом по правилам русского языка. */
export function pluralizeVotes(count: number): string {
  const hundredRemainder = count % 100;
  if (hundredRemainder >= 11 && hundredRemainder <= 14) return 'голосов';

  const tenRemainder = count % 10;
  if (tenRemainder === 1) return 'голос';
  if (tenRemainder >= 2 && tenRemainder <= 4) return 'голоса';
  return 'голосов';
}

function totalOf(tally: readonly GameTally[]): number {
  return tally.reduce((sum, entry) => sum + entry.voteCount, 0);
}

/** Человеческий текст объявления итога — победитель, ничья или отсутствие голосов. */
export function renderOutcomeMessage(outcome: PollOutcome): string {
  if (outcome.kind === 'no-votes') {
    return (
      'Голосование по дисциплине турнира завершено: никто не проголосовал. ' +
      'Организатору нужно выбрать дисциплину самостоятельно или запустить голосование заново.'
    );
  }

  if (outcome.kind === 'tie') {
    const maxVotes = Math.max(...outcome.tally.map((entry) => entry.voteCount));
    const names = outcome.games.map((game) => `**${TOURNAMENT_GAME_LABELS[game]}**`).join(' и ');
    return (
      `Голосование по дисциплине турнира завершено вничью между ${names} — ` +
      `по ${maxVotes} ${pluralizeVotes(maxVotes)} у каждой дисциплины. Организатору нужно выбрать дисциплину самостоятельно.`
    );
  }

  const winnerVotes = outcome.tally.find((entry) => entry.game === outcome.game)?.voteCount ?? 0;
  const total = totalOf(outcome.tally);
  return (
    `Голосование по дисциплине турнира завершено! Победила игра **${TOURNAMENT_GAME_LABELS[outcome.game]}** — ` +
    `${winnerVotes} из ${total} ${pluralizeVotes(total)}.`
  );
}
