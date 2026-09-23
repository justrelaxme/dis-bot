import type { StandingMatch } from './standings.js';

/**
 * Места всех участников доигранного турнира — полосами, а не только тройка призёров.
 *
 * Нужны сезонной серии: очки получает каждый, кто играл, и получает по тому, как далеко прошёл.
 * Место выводится из сетки, как и пьедестал в `standings.ts`: сетка — протокол, и отдельный
 * список мест рядом с ней однажды разошёлся бы с матчами.
 *
 * Места — полосы, потому что сетка их честно не различает: два проигравших полуфинала на
 * выбывание делят 3–4 место, четверо проигравших первого круга — 5–8. Выдумывать, кто из них
 * «третий», значило бы присудить результат, которого не было.
 *
 * Как считается. Каждый участник выбывает ровно один раз: на выбывание — в любом проигранном
 * матче, при двойном устранении — только в нижней сетке или в гранд-финале (проигрыш в
 * верхней отправляет вниз, а не домой). Выбывших раскладываем по этапам от последнего к
 * первому: кто выбыл позже, тот выше. Этап — это круг: все, кто выбыл в одном круге, делят
 * одну полосу мест.
 */

export interface Placement {
  entrantId: number;
  /** Лучшее место полосы: у проигравших полуфинала — 3. */
  place: number;
  /** Худшее место полосы: у них же — 4. У чемпиона и одиночных мест совпадает с `place`. */
  placeTo: number;
}

/** Порядок этапа: чем позже выбыл, тем больше. Гранд-финал — всегда последний. */
function stageOf(match: StandingMatch): number {
  if (match.bracket === 'grand') return 10_000;
  return match.round;
}

export function placementsOf(matches: readonly StandingMatch[]): Placement[] {
  if (matches.length === 0) return [];
  const doubleElim = matches.some((match) => match.bracket === 'grand');
  const decisive = matches.filter(
    (match) =>
      match.winnerEntrantId !== null &&
      match.entrantAId !== null &&
      match.entrantBId !== null &&
      (!doubleElim || match.bracket !== 'upper'),
  );

  // Финал: гранд-финал при двойном устранении, иначе матч последнего круга верхней сетки.
  const lastUpper = Math.max(0, ...matches.filter((match) => match.bracket === 'upper').map((match) => match.round));
  const final = doubleElim
    ? matches.find((match) => match.bracket === 'grand')
    : matches.find((match) => match.bracket === 'upper' && match.round === lastUpper);
  if (!final || final.winnerEntrantId === null) return [];

  const byStage = new Map<number, number[]>();
  for (const match of decisive) {
    const loser = match.entrantAId === match.winnerEntrantId ? match.entrantBId : match.entrantAId;
    if (loser === null) continue;
    const stage = stageOf(match);
    byStage.set(stage, [...(byStage.get(stage) ?? []), loser]);
  }

  const placements: Placement[] = [{ entrantId: final.winnerEntrantId, place: 1, placeTo: 1 }];
  let next = 2;
  for (const stage of [...byStage.keys()].sort((a, b) => b - a)) {
    const losers = byStage.get(stage) ?? [];
    for (const entrantId of losers) placements.push({ entrantId, place: next, placeTo: next + losers.length - 1 });
    next += losers.length;
  }
  return placements;
}

/** Очко за каждого, кто остался ниже, плюс одно за участие и пять сверху — за титул. */
export const TITLE_BONUS = 5;

/**
 * Очки серии за место. Считаются от того, скольких участников человек оставил позади: так
 * очки сами растут с размером поля, и победа в турнире на шестнадцать стоит больше победы в
 * турнире на четверых. Это не рейтинг и не оценка силы — это счёт того, кто сколько прошёл, и
 * его можно пересчитать руками по сетке.
 *
 * Полоса считается по худшему месту: «3–4 из 8» оставили позади четверых, а не пятерых.
 */
export function circuitPoints(placement: Pick<Placement, 'place' | 'placeTo'>, fieldSize: number): number {
  const beaten = Math.max(0, fieldSize - placement.placeTo);
  return beaten + 1 + (placement.place === 1 ? TITLE_BONUS : 0);
}
