/**
 * Движок сетки single elimination. Здесь только арифметика: ни базы, ни Discord.
 *
 * Сетка сводит **участников** — а участник это либо один игрок, либо команда. Поэтому
 * весь этот файл ничего не знает про режим турнира: и 16 команд, и 16 одиночек идут по
 * одному и тому же коду.
 */

/** Размер сетки — ближайшая сверху степень двойки. Меньше двух участников играть нельзя. */
export function bracketSize(entrantCount: number): number {
  if (entrantCount < 2) return 0;
  let size = 2;
  while (size < entrantCount) size *= 2;
  return size;
}

/**
 * Порядок сеяных по слотам первого круга.
 *
 * Строится удвоением: на каждом шаге каждый сеяный s заменяется парой (s, sum - s),
 * где sum — на единицу больше нового размера. Для 8 получается
 * `[1, 8, 4, 5, 2, 7, 3, 6]`, то есть пары первого круга (1-8), (4-5), (2-7), (3-6).
 *
 * Это не украшение. Проверим на восьмёрке, что даёт такая расстановка: верхняя половина
 * — сеяные 1, 8, 4, 5, нижняя — 2, 7, 3, 6. Значит первый и второй сеяные встретятся
 * только в финале, первый и четвёртый — не раньше полуфинала. Наивная расстановка
 * «по порядку» (1-2, 3-4, …) сводила бы первого со вторым в первом же круге, и смысл
 * сеяния исчезал бы целиком.
 */
export function seedOrder(size: number): number[] {
  if (size < 2) return [];
  let order = [1];
  while (order.length < size) {
    const sum = order.length * 2 + 1;
    const next: number[] = [];
    for (const seed of order) {
      next.push(seed);
      next.push(sum - seed);
    }
    order = next;
  }
  return order;
}

export interface SeededEntrant {
  entrantId: number;
  seed: number;
  score: number;
}

/**
 * Раскладывает участников по сидам. `strength` — сила участника (для команды это средний
 * `rankScore` состава); чем больше, тем выше сид. При равной силе порядок берётся из
 * `tiebreak`, чтобы жеребьёвка была воспроизводима: одинаковый вход даёт одинаковую сетку,
 * и её можно показать, обсудить и перепроверить.
 *
 * Случайная жеребьёвка — это тот же код, только сила у всех нулевая, а `tiebreak` заранее
 * перемешан вызывающим. Так у случайной и рейтинговой жеребьёвки одна дорога, а не две.
 */
export function assignSeeds(entrants: { entrantId: number; strength: number }[]): SeededEntrant[] {
  const ordered = [...entrants]
    .map((entrant, index) => ({ ...entrant, tiebreak: index }))
    .sort((a, b) => (b.strength - a.strength) || (a.tiebreak - b.tiebreak));

  return ordered.map((entrant, index) => ({
    entrantId: entrant.entrantId,
    seed: index + 1,
    score: entrant.strength,
  }));
}

export interface PlannedMatch {
  round: number;
  slot: number;
  entrantAId: number | null;
  entrantBId: number | null;
}

/**
 * Строит все матчи сетки, включая пустые матчи поздних кругов: их участники станут
 * известны, когда сыграют предыдущие. Пустые слоты первого круга — это **пропуски**
 * (bye), и достаются они старшим сеяным автоматически: сеяный 1 стоит в паре с сеяным
 * `size`, которого при неполной сетке просто нет.
 *
 * Отдавать пропуск случайному участнику значило бы обесценить жеребьёвку: пропуск — это
 * преимущество, и оно должно достаться тому, кто его заслужил силой.
 */
export function buildBracket(seeded: SeededEntrant[]): PlannedMatch[] {
  const size = bracketSize(seeded.length);
  if (size === 0) return [];

  const bySeed = new Map<number, number>();
  for (const entrant of seeded) bySeed.set(entrant.seed, entrant.entrantId);

  const order = seedOrder(size);
  const matches: PlannedMatch[] = [];

  // Первый круг: пары идут по расстановке сеяных, по два сида на матч.
  for (let slot = 0; slot * 2 < size; slot += 1) {
    const seedA = order[slot * 2];
    const seedB = order[slot * 2 + 1];
    matches.push({
      round: 1,
      slot,
      entrantAId: seedA === undefined ? null : (bySeed.get(seedA) ?? null),
      entrantBId: seedB === undefined ? null : (bySeed.get(seedB) ?? null),
    });
  }

  // Остальные круги: пустые, заполнятся продвижением победителей.
  let matchesInRound = size / 2;
  let round = 1;
  while (matchesInRound > 1) {
    matchesInRound /= 2;
    round += 1;
    for (let slot = 0; slot < matchesInRound; slot += 1) {
      matches.push({ round, slot, entrantAId: null, entrantBId: null });
    }
  }

  return matches;
}

export interface AdvanceTarget {
  round: number;
  slot: number;
  side: 'a' | 'b';
}

/**
 * Куда ведёт матч. Вычисляется, а не хранится: ссылка на родителя в базе была бы вторым
 * источником истины о форме сетки, и однажды эти два источника разошлись бы.
 *
 * Матч круга `r`, слот `s` ведёт в круг `r + 1`, слот `s / 2` нацело, в сторону `a` при
 * чётном `s` и `b` при нечётном. Проверим на обеих чётностях: слоты 0 и 1 первого круга
 * ведут в слот 0 второго — нулевой в сторону `a`, первый в сторону `b`; слоты 2 и 3 ведут
 * в слот 1 — второй в `a`, третий в `b`. То есть соседние пары схлопываются в одну, как и
 * должно быть в сетке на выбывание.
 */
export function advanceTarget(round: number, slot: number): AdvanceTarget {
  return {
    round: round + 1,
    slot: Math.floor(slot / 2),
    side: slot % 2 === 0 ? 'a' : 'b',
  };
}

/** Сколько всего кругов в сетке такого размера. */
export function totalRounds(size: number): number {
  if (size < 2) return 0;
  return Math.log2(size);
}

export type EventSize = 'none' | 'showmatch' | 'mini' | 'tournament';

/**
 * Как называть событие по числу участников. Порога «меньше четырёх — отменяем» нет: при
 * полном автомате бот проводит то, что собралось, а не отказывает пришедшим. Меняется
 * только слово, которым он это называет, — механика одна и та же, потому что два разных
 * движка ради двух команд это два места, где поведение может разойтись, вместо одного.
 */
export function eventSize(entrantCount: number): EventSize {
  if (entrantCount < 2) return 'none';
  if (entrantCount === 2) return 'showmatch';
  if (entrantCount <= 4) return 'mini';
  return 'tournament';
}

export const EVENT_SIZE_LABELS: Record<EventSize, string> = {
  none: 'не проводится',
  showmatch: 'шоуматч',
  mini: 'мини-турнир',
  tournament: 'турнир',
};
