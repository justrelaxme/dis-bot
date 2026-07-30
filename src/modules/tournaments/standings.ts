import { lowerRounds, type MatchBracket } from './bracket.js';

/**
 * Места по итогам турнира. Выводятся из сетки, а не хранятся: сетка и есть протокол, и
 * второй список мест рядом с ней однажды разошёлся бы с матчами, которые его породили.
 *
 * Третье место честно есть только при двойном устранении: там его занимает проигравший
 * финала нижней сетки — человек, который выиграл больше всех, кроме двоих. На выбывание
 * третьего места нет вообще: два проигравших полуфинала не сыграли между собой, и назначать
 * одного из них третьим значило бы выдумать результат. Поэтому они возвращаются как
 * полуфиналисты — оба, без номера.
 */

export interface StandingMatch {
  bracket: MatchBracket;
  round: number;
  slot: number;
  entrantAId: number | null;
  entrantBId: number | null;
  winnerEntrantId: number | null;
  state: string;
}

export interface Standings {
  championId: number | null;
  runnerUpId: number | null;
  /** Третье место — только при двойном устранении. */
  thirdId: number | null;
  /** Полуфиналисты при выбывании: место у них общее, и делить его нечем. */
  semifinalistIds: number[];
}

const EMPTY: Standings = {
  championId: null,
  runnerUpId: null,
  thirdId: null,
  semifinalistIds: [],
};

function loserOf(match: StandingMatch | undefined): number | null {
  if (!match || match.winnerEntrantId === null) return null;
  const loser = match.entrantAId === match.winnerEntrantId ? match.entrantBId : match.entrantAId;
  return loser;
}

export function standingsOf(matches: readonly StandingMatch[]): Standings {
  if (matches.length === 0) return EMPTY;

  const upper = matches.filter((match) => match.bracket === 'upper');
  const grand = matches.find((match) => match.bracket === 'grand');
  const upperRounds = upper.reduce((max, match) => Math.max(max, match.round), 0);
  const size = 2 ** upperRounds;

  if (grand) {
    const lowerFinalRound = lowerRounds(size);
    const lowerFinal = matches.find(
      (match) => match.bracket === 'lower' && match.round === lowerFinalRound,
    );

    return {
      championId: grand.winnerEntrantId,
      runnerUpId: loserOf(grand),
      thirdId: loserOf(lowerFinal),
      semifinalistIds: [],
    };
  }

  const final = upper.find((match) => match.round === upperRounds && match.slot === 0);
  const semifinals = upper.filter((match) => match.round === upperRounds - 1);

  return {
    championId: final?.winnerEntrantId ?? null,
    runnerUpId: loserOf(final),
    thirdId: null,
    // Оба полуфиналиста, а не один: между собой они не играли.
    semifinalistIds: semifinals
      .map((match) => loserOf(match))
      .filter((id): id is number => id !== null),
  };
}
