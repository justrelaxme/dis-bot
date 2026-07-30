/**
 * Движок сетки: single elimination и double elimination. Здесь только арифметика — ни
 * базы, ни Discord.
 *
 * Сетка сводит **участников** — а участник это либо один игрок, либо команда. Поэтому
 * весь этот файл ничего не знает про режим турнира: и 16 команд, и 16 одиночек идут по
 * одному и тому же коду.
 */

/** Колонка формата турнира. Значение, а не enum: Swiss добавится сюда же. */
export type BracketFormat = 'single-elim' | 'double-elim';

/**
 * Верхняя сетка, нижняя сетка, гранд-финал. У single elimination есть только `upper` —
 * тогда финал верхней сетки и есть финал турнира.
 */
export type MatchBracket = 'upper' | 'lower' | 'grand';

/** Размер сетки — ближайшая сверху степень двойки. Меньше двух участников играть нельзя. */
export function bracketSize(entrantCount: number): number {
  if (entrantCount < 2) return 0;
  let size = 2;
  while (size < entrantCount) size *= 2;
  return size;
}

/** Сколько кругов в верхней сетке такого размера. */
export function totalRounds(size: number): number {
  if (size < 2) return 0;
  return Math.log2(size);
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

export interface MatchPosition {
  bracket: MatchBracket;
  round: number;
  slot: number;
}

export interface AdvanceTarget extends MatchPosition {
  side: 'a' | 'b';
}

/** Ключ позиции для словарей: позиция матча уникальна в пределах турнира. */
export function positionKey(position: MatchPosition): string {
  return `${position.bracket}:${position.round}:${position.slot}`;
}

/** Матчей в круге верхней сетки: круг r сводит 2^(k-r+1) участников в 2^(k-r) пар. */
export function upperRoundMatches(size: number, round: number): number {
  const k = totalRounds(size);
  if (round < 1 || round > k) return 0;
  return 2 ** (k - round);
}

/**
 * Кругов в нижней сетке — вдвое меньше одного от числа кругов верхней, умноженное на два:
 * 2(k-1). Круги чередуются: в чётные спускаются проигравшие очередного круга верхней
 * сетки, в нечётные (кроме первого) играют между собой те, кто уже упал.
 *
 * Проверим на восьмёрке (k=3): 4 круга. Первый — четыре проигравших первого круга в двух
 * матчах. Второй — два выживших против двух проигравших второго круга верхней. Третий —
 * два выживших между собой. Четвёртый — выживший против проигравшего финала верхней сетки.
 * Итого нижняя сетка даёт size-2 матчей, верхняя size-1, плюс гранд-финал: 2·size-2.
 */
export function lowerRounds(size: number): number {
  const k = totalRounds(size);
  return k < 2 ? 0 : 2 * (k - 1);
}

/** Матчей в круге нижней сетки. Круги идут парами: 2^(k-1-⌈r/2⌉). */
export function lowerRoundMatches(size: number, round: number): number {
  const k = totalRounds(size);
  if (round < 1 || round > lowerRounds(size)) return 0;
  return 2 ** (k - 1 - Math.ceil(round / 2));
}

/**
 * Куда идёт победитель. Вычисляется, а не хранится: ссылка на родителя в базе была бы
 * вторым источником истины о форме сетки, и однажды эти два источника разошлись бы.
 *
 * Верхняя сетка: матч круга `r`, слот `s` ведёт в круг `r + 1`, слот `s / 2` нацело, в
 * сторону `a` при чётном `s` и `b` при нечётном. Проверим на обеих чётностях: слоты 0 и 1
 * ведут в слот 0 следующего круга — нулевой в сторону `a`, первый в `b`; слоты 2 и 3 ведут
 * в слот 1. То есть соседние пары схлопываются в одну, как и должно быть на выбывание.
 *
 * Нижняя сетка: из нечётного круга в чётный число матчей не меняется, поэтому слот
 * сохраняется, и выживший всегда встаёт в сторону `a` — сторона `b` в чётных кругах
 * закреплена за тем, кто спустился сверху. Из чётного круга в нечётный число матчей
 * уменьшается вдвое, и слоты схлопываются как в верхней сетке.
 *
 * `null` — победителю идти некуда, то есть этот матч и был последним.
 */
export function winnerTarget(
  size: number,
  format: BracketFormat,
  position: MatchPosition,
): AdvanceTarget | null {
  if (position.bracket === 'grand') return null;

  if (position.bracket === 'upper') {
    const k = totalRounds(size);
    if (position.round < k) {
      return {
        bracket: 'upper',
        round: position.round + 1,
        slot: Math.floor(position.slot / 2),
        side: position.slot % 2 === 0 ? 'a' : 'b',
      };
    }
    // Финал верхней сетки. При double elimination его победитель ждёт в гранд-финале.
    if (format === 'double-elim' && lowerRounds(size) > 0) {
      return { bracket: 'grand', round: 1, slot: 0, side: 'a' };
    }
    return null;
  }

  if (position.round >= lowerRounds(size)) {
    return { bracket: 'grand', round: 1, slot: 0, side: 'b' };
  }

  return position.round % 2 === 1
    ? { bracket: 'lower', round: position.round + 1, slot: position.slot, side: 'a' }
    : {
        bracket: 'lower',
        round: position.round + 1,
        slot: Math.floor(position.slot / 2),
        side: position.slot % 2 === 0 ? 'a' : 'b',
      };
}

/**
 * Куда идёт проигравший. При single elimination — никуда, он выбыл.
 *
 * Проигравшие первого круга верхней сетки садятся в нижнюю парами: слоты 0 и 1 дают
 * матч 0, слоты 2 и 3 — матч 1. Двое, проигравшие в разных матчах, между собой ещё не
 * играли, поэтому здесь ничего переставлять не нужно.
 *
 * А вот со второго круга порядок слотов **переворачивается**, и это не косметика.
 * Проигравший матча `s` второго круга верхней сетки только что обыграл кого-то из слотов
 * `2s` и `2s+1` первого круга — а именно они и сидят в матче `s` первого круга нижней.
 * Спусти его в слот `s` — и он сразу получит переигровку с тем, кого только что выбил,
 * то есть нижняя сетка перестанет быть вторым шансом и станет повтором первого.
 * Переворот отправляет его в другую половину, где таких соперников нет.
 */
export function loserTarget(
  size: number,
  format: BracketFormat,
  position: MatchPosition,
): AdvanceTarget | null {
  if (format !== 'double-elim') return null;
  if (position.bracket !== 'upper') return null;
  if (lowerRounds(size) === 0) return null;

  if (position.round === 1) {
    return {
      bracket: 'lower',
      round: 1,
      slot: Math.floor(position.slot / 2),
      side: position.slot % 2 === 0 ? 'a' : 'b',
    };
  }

  const count = upperRoundMatches(size, position.round);
  return {
    bracket: 'lower',
    round: 2 * (position.round - 1),
    slot: count - 1 - position.slot,
    side: 'b',
  };
}

export interface PlannedMatch extends MatchPosition {
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
export function buildBracket(
  seeded: SeededEntrant[],
  format: BracketFormat = 'single-elim',
): PlannedMatch[] {
  const size = bracketSize(seeded.length);
  if (size === 0) return [];

  const bySeed = new Map<number, number>();
  for (const entrant of seeded) bySeed.set(entrant.seed, entrant.entrantId);

  const order = seedOrder(size);
  const matches: PlannedMatch[] = [];

  // Первый круг верхней сетки: пары идут по расстановке сеяных, по два сида на матч.
  for (let slot = 0; slot * 2 < size; slot += 1) {
    const seedA = order[slot * 2];
    const seedB = order[slot * 2 + 1];
    matches.push({
      bracket: 'upper',
      round: 1,
      slot,
      entrantAId: seedA === undefined ? null : (bySeed.get(seedA) ?? null),
      entrantBId: seedB === undefined ? null : (bySeed.get(seedB) ?? null),
    });
  }

  // Остальные круги верхней сетки: пустые, заполнятся продвижением победителей.
  const k = totalRounds(size);
  for (let round = 2; round <= k; round += 1) {
    for (let slot = 0; slot < upperRoundMatches(size, round); slot += 1) {
      matches.push({ bracket: 'upper', round, slot, entrantAId: null, entrantBId: null });
    }
  }

  const lower = format === 'double-elim' ? lowerRounds(size) : 0;
  for (let round = 1; round <= lower; round += 1) {
    for (let slot = 0; slot < lowerRoundMatches(size, round); slot += 1) {
      matches.push({ bracket: 'lower', round, slot, entrantAId: null, entrantBId: null });
    }
  }
  if (lower > 0) {
    matches.push({ bracket: 'grand', round: 1, slot: 0, entrantAId: null, entrantBId: null });
  }

  return matches;
}

/**
 * Сколько участников матч получит **за всё время**: 0, 1 или 2.
 *
 * Это единственный способ отличить «слот пуст, потому что предыдущий матч ещё не сыгран»
 * от «слот пуст навсегда». Разница есть только при неполной сетке и только в нижней:
 * пропуск в верхней сетке не даёт проигравшего, значит место, куда он должен был
 * спуститься, не заполнится никогда. Матч, ждущий соперника, который не придёт, повесил бы
 * нижнюю сетку намертво.
 *
 * Считается обходом сетки в порядке зависимостей — сначала вся верхняя, потом нижняя по
 * кругам, — и **только по занятости первого круга**, а не по числу участников турнира.
 * Это важно: в сетку идут отметившиеся, а зарегистрированных может быть больше, и любая
 * арифметика от числа регистраций разошлась бы с реально построенной сеткой.
 */
export function arrivalPlan(
  firstRoundOccupancy: number[],
  format: BracketFormat,
): Map<string, number> {
  const size = firstRoundOccupancy.length * 2;
  const counts = new Map<string, number>();
  if (size < 2) return counts;

  const add = (target: AdvanceTarget | null): void => {
    if (!target) return;
    const key = positionKey(target);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };

  firstRoundOccupancy.forEach((occupancy, slot) => {
    counts.set(positionKey({ bracket: 'upper', round: 1, slot }), occupancy);
  });

  const k = totalRounds(size);
  for (let round = 1; round <= k; round += 1) {
    for (let slot = 0; slot < upperRoundMatches(size, round); slot += 1) {
      const position: MatchPosition = { bracket: 'upper', round, slot };
      const arrivals = counts.get(positionKey(position)) ?? 0;
      // Победитель есть у любого матча, куда пришёл хотя бы один: одинокий проходит
      // без игры. А проигравший появляется только там, где реально играли двое.
      if (arrivals >= 1) add(winnerTarget(size, format, position));
      if (arrivals === 2) add(loserTarget(size, format, position));
    }
  }

  const lower = format === 'double-elim' ? lowerRounds(size) : 0;
  for (let round = 1; round <= lower; round += 1) {
    for (let slot = 0; slot < lowerRoundMatches(size, round); slot += 1) {
      const position: MatchPosition = { bracket: 'lower', round, slot };
      const arrivals = counts.get(positionKey(position)) ?? 0;
      if (arrivals >= 1) add(winnerTarget(size, format, position));
    }
  }

  return counts;
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

export const BRACKET_FORMAT_LABELS: Record<BracketFormat, string> = {
  'single-elim': 'на выбывание',
  'double-elim': 'двойное устранение',
};

/**
 * Формат, которым турнир реально сыграется. Двойное устранение на двух участниках
 * выродилось бы в «победитель ждёт проигравшего в гранд-финале», то есть в ту же пару
 * во второй раз, — поэтому на двоих играем на выбывание, что бы ни было выбрано.
 */
export function effectiveFormat(entrantCount: number, requested: BracketFormat): BracketFormat {
  if (requested !== 'double-elim') return requested;
  return lowerRounds(bracketSize(entrantCount)) > 0 ? 'double-elim' : 'single-elim';
}
