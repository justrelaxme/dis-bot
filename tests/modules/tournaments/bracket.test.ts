import { describe, expect, it } from 'vitest';
import {
  arrivalPlan,
  assignSeeds,
  bracketSize,
  buildBracket,
  effectiveFormat,
  eventSize,
  loserTarget,
  lowerRoundMatches,
  lowerRounds,
  positionKey,
  seedOrder,
  totalRounds,
  upperRoundMatches,
  winnerTarget,
  type AdvanceTarget,
  type BracketFormat,
  type MatchBracket,
  type MatchPosition,
} from '../../../src/modules/tournaments/bracket.js';

/**
 * Сетка — самое опасное место проекта: ошибка здесь не падает, а молча портит живой
 * турнир, который нельзя переиграть. Поэтому кроме проверок отдельных функций тут есть
 * прогон целиком: сетка строится, разыгрывается до конца и проверяется на инварианты.
 * Именно он нашёл настоящие дефекты в спуске проигравших, когда движок писался.
 */

const BRACKET_RANK: Record<MatchBracket, number> = { upper: 0, lower: 1, grand: 2 };

interface Sim {
  pos: MatchPosition;
  a: number | null;
  b: number | null;
  winner: number | null;
  state: 'pending' | 'ready' | 'void' | 'done' | 'walkover';
}

interface Outcome {
  champion: number | null;
  played: number;
  walkovers: number;
  voids: number;
  /** Сколько поражений у каждого участника. */
  losses: Map<number, number>;
  /** Сколько реально сыгранных матчей у каждого участника. */
  playedBy: Map<number, number>;
  unresolved: string[];
  /** Пары, встретившиеся дважды подряд (кроме гранд-финала). */
  immediateRematches: string[];
  slotConflicts: string[];
}

/**
 * Разыгрывает турнир целиком: побеждает всегда старший сеяный, поэтому итог предсказуем и
 * инварианты можно проверять точными равенствами, а не диапазонами.
 *
 * Повторяет логику сервиса (доставка в слот, проход без игры при единственном прибытии,
 * определение финала по отсутствию цели) — но на объектах в памяти, без базы. Расхождение
 * между этой моделью и сервисом поймают интеграционные тесты переходов матчей.
 */
function playOut(entrantCount: number, requested: BracketFormat): Outcome {
  const format = effectiveFormat(entrantCount, requested);
  const size = bracketSize(entrantCount);

  // strength убывает вместе с номером, поэтому entrantId совпадает с сидом.
  const seeded = assignSeeds(
    Array.from({ length: entrantCount }, (_, index) => ({
      entrantId: index + 1,
      strength: entrantCount - index,
    })),
  );

  const matches = new Map<string, Sim>();
  for (const match of buildBracket(seeded, format)) {
    matches.set(positionKey(match), {
      pos: { bracket: match.bracket, round: match.round, slot: match.slot },
      a: match.entrantAId,
      b: match.entrantBId,
      winner: null,
      state: 'pending',
    });
  }

  const occupancy: number[] = [];
  for (let slot = 0; slot * 2 < size; slot += 1) {
    const match = matches.get(positionKey({ bracket: 'upper', round: 1, slot }));
    if (!match) throw new Error(`нет матча upper:1:${slot}`);
    occupancy.push((match.a === null ? 0 : 1) + (match.b === null ? 0 : 1));
  }
  const arrivals = arrivalPlan(occupancy, format);
  const arrivalsOf = (pos: MatchPosition): number => arrivals.get(positionKey(pos)) ?? 0;

  const losses = new Map<number, number>();
  const playedBy = new Map<number, number>();
  const lastOpponent = new Map<number, number>();
  const immediateRematches: string[] = [];
  const slotConflicts: string[] = [];
  const bump = (map: Map<number, number>, key: number): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  function place(target: AdvanceTarget | null, entrantId: number): void {
    if (!target) return;
    const match = matches.get(positionKey(target));
    if (!match) {
      slotConflicts.push(`нет матча ${positionKey(target)}`);
      return;
    }
    if (target.side === 'a') {
      if (match.a !== null) slotConflicts.push(`слот a занят в ${positionKey(target)}`);
      match.a = entrantId;
    } else {
      if (match.b !== null) slotConflicts.push(`слот b занят в ${positionKey(target)}`);
      match.b = entrantId;
    }
    if (arrivalsOf(target) === 1 && match.winner === null) settle(match, entrantId);
  }

  function settle(match: Sim, winner: number): void {
    const loser = match.a === winner ? match.b : match.a;
    match.winner = winner;
    match.state = loser === null ? 'walkover' : 'done';

    if (loser !== null) {
      bump(losses, loser);
      bump(playedBy, winner);
      bump(playedBy, loser);

      // Гранд-финал исключён: его переигровка неустранима по определению формата —
      // финалист верхней сетки последним играл именно финал верхней.
      if (
        match.pos.bracket !== 'grand' &&
        (lastOpponent.get(winner) === loser || lastOpponent.get(loser) === winner)
      ) {
        immediateRematches.push(`${Math.min(winner, loser)}-${Math.max(winner, loser)}`);
      }
      lastOpponent.set(winner, loser);
      lastOpponent.set(loser, winner);

      place(loserTarget(size, format, match.pos), loser);
    }
    place(winnerTarget(size, format, match.pos), winner);
  }

  // Старт: состояния и пропуски в порядке зависимостей — вся верхняя сетка, потом нижняя.
  const order = [...matches.values()]
    .map((match) => match.pos)
    .sort(
      (x, y) =>
        BRACKET_RANK[x.bracket] - BRACKET_RANK[y.bracket] || x.round - y.round || x.slot - y.slot,
    );

  for (const pos of order) {
    const match = matches.get(positionKey(pos));
    if (!match || match.winner !== null) continue;
    const here = (match.a === null ? 0 : 1) + (match.b === null ? 0 : 1);
    const expected = arrivalsOf(pos);
    if (expected === 0) {
      match.state = 'void';
      continue;
    }
    if (expected === 1 && here === 1) {
      settle(match, (match.a ?? match.b) as number);
      continue;
    }
    if (here === 2) match.state = 'ready';
  }

  for (let guard = 0; guard < 10_000; guard += 1) {
    const next = [...matches.values()].find(
      (match) => match.winner === null && match.state !== 'void' && match.a !== null && match.b !== null,
    );
    if (!next) break;
    settle(next, Math.min(next.a as number, next.b as number));
  }

  const finalPos: MatchPosition =
    format === 'double-elim'
      ? { bracket: 'grand', round: 1, slot: 0 }
      : { bracket: 'upper', round: totalRounds(size), slot: 0 };

  return {
    champion: matches.get(positionKey(finalPos))?.winner ?? null,
    played: [...matches.values()].filter((match) => match.state === 'done').length,
    walkovers: [...matches.values()].filter((match) => match.state === 'walkover').length,
    voids: [...matches.values()].filter((match) => match.state === 'void').length,
    losses,
    playedBy,
    unresolved: [...matches.values()]
      .filter((match) => match.winner === null && match.state !== 'void')
      .map((match) => positionKey(match.pos)),
    immediateRematches,
    slotConflicts,
  };
}

describe('размер сетки и круги', () => {
  it('округляет число участников вверх до степени двойки', () => {
    expect(bracketSize(2)).toBe(2);
    expect(bracketSize(3)).toBe(4);
    expect(bracketSize(5)).toBe(8);
    expect(bracketSize(8)).toBe(8);
    expect(bracketSize(9)).toBe(16);
  });

  it('меньше двух участников — сетки нет', () => {
    expect(bracketSize(1)).toBe(0);
    expect(bracketSize(0)).toBe(0);
    expect(totalRounds(0)).toBe(0);
  });

  it('кругов ровно log2 от размера', () => {
    expect(totalRounds(4)).toBe(2);
    expect(totalRounds(16)).toBe(4);
    expect(upperRoundMatches(16, 1)).toBe(8);
    expect(upperRoundMatches(16, 4)).toBe(1);
    expect(upperRoundMatches(16, 5)).toBe(0);
  });
});

describe('расстановка сеяных', () => {
  it('для восьмёрки даёт документированный порядок', () => {
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  it('разводит первого и второго сеяных по разным половинам на любом размере', () => {
    for (const size of [4, 8, 16, 32, 64]) {
      const order = seedOrder(size);
      const half = size / 2;
      const firstHalf = order.slice(0, half);
      expect(firstHalf).toContain(1);
      // Второй сеяный обязан быть во второй половине: иначе они встретятся до финала и
      // сеяние теряет смысл целиком.
      expect(firstHalf).not.toContain(2);
    }
  });

  it('каждый сид встречается ровно один раз', () => {
    const order = seedOrder(16);
    expect(new Set(order).size).toBe(16);
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });
});

describe('жеребьёвка', () => {
  it('сильнейший получает первый сид, порядок воспроизводим при равной силе', () => {
    const seeded = assignSeeds([
      { entrantId: 10, strength: 100 },
      { entrantId: 20, strength: 300 },
      { entrantId: 30, strength: 100 },
    ]);

    expect(seeded.map((entrant) => entrant.entrantId)).toEqual([20, 10, 30]);
    expect(seeded.map((entrant) => entrant.seed)).toEqual([1, 2, 3]);
  });
});

describe('нижняя сетка', () => {
  it('кругов вдвое больше одного от кругов верхней', () => {
    expect(lowerRounds(4)).toBe(2);
    expect(lowerRounds(8)).toBe(4);
    expect(lowerRounds(16)).toBe(6);
    // На двоих нижней сетки нет: устранять со второго поражения некого.
    expect(lowerRounds(2)).toBe(0);
  });

  it('круги идут парами одинаковой длины', () => {
    expect([1, 2, 3, 4, 5, 6].map((round) => lowerRoundMatches(16, round))).toEqual([4, 4, 2, 2, 1, 1]);
  });

  it('всего матчей 2n-2 на полной сетке', () => {
    for (const size of [4, 8, 16, 32]) {
      const upper = size - 1;
      let lower = 0;
      for (let round = 1; round <= lowerRounds(size); round += 1) lower += lowerRoundMatches(size, round);
      expect(upper + lower + 1).toBe(2 * size - 2);
    }
  });
});

describe('маршруты победителя и проигравшего', () => {
  it('соседние пары верхней сетки схлопываются в одну', () => {
    expect(winnerTarget(8, 'single-elim', { bracket: 'upper', round: 1, slot: 0 })).toEqual({
      bracket: 'upper',
      round: 2,
      slot: 0,
      side: 'a',
    });
    expect(winnerTarget(8, 'single-elim', { bracket: 'upper', round: 1, slot: 1 })).toEqual({
      bracket: 'upper',
      round: 2,
      slot: 0,
      side: 'b',
    });
  });

  it('победителю финала при выбывании идти некуда', () => {
    expect(winnerTarget(8, 'single-elim', { bracket: 'upper', round: 3, slot: 0 })).toBeNull();
  });

  it('при двойном устранении финал верхней ведёт в гранд-финал', () => {
    expect(winnerTarget(8, 'double-elim', { bracket: 'upper', round: 3, slot: 0 })).toEqual({
      bracket: 'grand',
      round: 1,
      slot: 0,
      side: 'a',
    });
    expect(winnerTarget(8, 'double-elim', { bracket: 'lower', round: 4, slot: 0 })).toEqual({
      bracket: 'grand',
      round: 1,
      slot: 0,
      side: 'b',
    });
    expect(winnerTarget(8, 'double-elim', { bracket: 'grand', round: 1, slot: 0 })).toBeNull();
  });

  it('при выбывании проигравший не идёт никуда', () => {
    expect(loserTarget(8, 'single-elim', { bracket: 'upper', round: 1, slot: 0 })).toBeNull();
  });

  it('проигравшие первого круга садятся в нижнюю парами', () => {
    expect(loserTarget(8, 'double-elim', { bracket: 'upper', round: 1, slot: 0 })).toEqual({
      bracket: 'lower',
      round: 1,
      slot: 0,
      side: 'a',
    });
    expect(loserTarget(8, 'double-elim', { bracket: 'upper', round: 1, slot: 1 })).toEqual({
      bracket: 'lower',
      round: 1,
      slot: 0,
      side: 'b',
    });
  });

  /**
   * Главное свойство спуска и причина, по которой он вообще устроен сложно. Проигравший
   * матча s второго круга только что обыграл кого-то из слотов 2s и 2s+1 первого круга — а
   * они сидят в матче s первого круга нижней. Без переворота он получил бы переигровку с
   * тем, кого только что выбил, и нижняя сетка стала бы повтором первого круга.
   */
  it('спуск со второго круга переворачивает слоты и не даёт переигровки', () => {
    const size = 16;
    const count = upperRoundMatches(size, 2);
    for (let slot = 0; slot < count; slot += 1) {
      const target = loserTarget(size, 'double-elim', { bracket: 'upper', round: 2, slot });
      expect(target).not.toBeNull();
      expect(target?.slot).toBe(count - 1 - slot);
      expect(target?.side).toBe('b');
      // Тот, кого он победил, попал бы в матч nownumber `slot` — а он едет в другой.
      expect(target?.slot).not.toBe(slot);
    }
  });

  it('нижняя сетка не сужается из нечётного круга в чётный и сужается из чётного в нечётный', () => {
    expect(winnerTarget(16, 'double-elim', { bracket: 'lower', round: 1, slot: 3 })).toEqual({
      bracket: 'lower',
      round: 2,
      slot: 3,
      side: 'a',
    });
    expect(winnerTarget(16, 'double-elim', { bracket: 'lower', round: 2, slot: 3 })).toEqual({
      bracket: 'lower',
      round: 3,
      slot: 1,
      side: 'b',
    });
  });
});

describe('построение сетки', () => {
  it('на выбывание строит size-1 матчей и только верхнюю сетку', () => {
    const seeded = assignSeeds(
      Array.from({ length: 8 }, (_, index) => ({ entrantId: index + 1, strength: 8 - index })),
    );
    const matches = buildBracket(seeded, 'single-elim');

    expect(matches).toHaveLength(7);
    expect(matches.every((match) => match.bracket === 'upper')).toBe(true);
  });

  it('двойное устранение строит 2n-2 матчей, включая гранд-финал', () => {
    const seeded = assignSeeds(
      Array.from({ length: 8 }, (_, index) => ({ entrantId: index + 1, strength: 8 - index })),
    );
    const matches = buildBracket(seeded, 'double-elim');

    expect(matches).toHaveLength(14);
    expect(matches.filter((match) => match.bracket === 'lower')).toHaveLength(6);
    expect(matches.filter((match) => match.bracket === 'grand')).toHaveLength(1);
  });

  it('пропуски достаются старшим сеяным', () => {
    // Пятеро в сетке на восемь: сеяные 1, 2, 3 стоят в парах с отсутствующими 8, 7, 6.
    const seeded = assignSeeds(
      Array.from({ length: 5 }, (_, index) => ({ entrantId: index + 1, strength: 5 - index })),
    );
    const first = buildBracket(seeded, 'single-elim').filter(
      (match) => match.bracket === 'upper' && match.round === 1,
    );

    const alone = first
      .filter((match) => (match.entrantAId === null) !== (match.entrantBId === null))
      .map((match) => match.entrantAId ?? match.entrantBId);

    expect(alone.sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2, 3]);
  });
});

describe('план прибытий', () => {
  it('на полной сетке каждый матч получает двоих', () => {
    const plan = arrivalPlan([2, 2, 2, 2], 'double-elim');
    for (const count of plan.values()) expect(count).toBe(2);
  });

  /**
   * Отсутствие ключа в плане означает ноль прибытий — именно так его и читает сервис,
   * через `?? 0`. Тест закрепляет этот контракт: если план начнёт заводить явные нули или
   * наоборот перестанет покрывать живые матчи, сломается здесь, а не в живом турнире.
   */
  it('пропуск в верхней сетке оставляет матч нижней без единого участника', () => {
    // Пятеро из восьми: реально играет только один матч первого круга, значит вниз
    // спускается один проигравший, и части матчей нижней сетки прийти некому.
    const seeded = assignSeeds(
      Array.from({ length: 5 }, (_, index) => ({ entrantId: index + 1, strength: 5 - index })),
    );
    const built = buildBracket(seeded, 'double-elim');
    const occupancy = built
      .filter((match) => match.bracket === 'upper' && match.round === 1)
      .sort((a, b) => a.slot - b.slot)
      .map((match) => (match.entrantAId === null ? 0 : 1) + (match.entrantBId === null ? 0 : 1));

    expect(occupancy).toEqual([1, 2, 1, 1]);

    const plan = arrivalPlan(occupancy, 'double-elim');
    const arrivalsOf = (match: (typeof built)[number]): number => plan.get(positionKey(match)) ?? 0;

    const dead = built.filter((match) => arrivalsOf(match) === 0);
    expect(dead.length).toBeGreaterThan(0);
    expect(dead.every((match) => match.bracket === 'lower')).toBe(true);

    // А верхняя сетка и гранд-финал получают своих всегда: пропуск даёт победителя, даже
    // если играть было не с кем.
    expect(built.filter((match) => match.bracket !== 'lower').every((match) => arrivalsOf(match) > 0)).toBe(
      true,
    );
  });
});

describe('вырождение формата', () => {
  it('на двоих двойное устранение превращается в выбывание', () => {
    expect(effectiveFormat(2, 'double-elim')).toBe('single-elim');
    expect(effectiveFormat(3, 'double-elim')).toBe('double-elim');
  });

  it('выбывание никогда не превращается в двойное', () => {
    expect(effectiveFormat(16, 'single-elim')).toBe('single-elim');
  });
});

describe('названия события по числу участников', () => {
  it('различает шоуматч, мини-турнир и турнир', () => {
    expect(eventSize(1)).toBe('none');
    expect(eventSize(2)).toBe('showmatch');
    expect(eventSize(4)).toBe('mini');
    expect(eventSize(5)).toBe('tournament');
  });
});

/**
 * Прогон целиком. Именно эти проверки нашли настоящие дефекты в спуске проигравших, когда
 * движок писался, — на каждом размере от двух до тридцати трёх участников.
 */
describe('прогон сетки до конца', () => {
  const counts = Array.from({ length: 32 }, (_, index) => index + 2);

  it.each(counts)('выбывание, %i участников: чемпион — первый сеяный, повисших матчей нет', (n) => {
    const outcome = playOut(n, 'single-elim');

    expect(outcome.champion).toBe(1);
    expect(outcome.unresolved).toEqual([]);
    expect(outcome.slotConflicts).toEqual([]);
    // На выбывание выбывает каждый, кроме одного, и ровно с одного поражения.
    expect([...outcome.losses.values()].filter((count) => count >= 1)).toHaveLength(n - 1);
    expect([...outcome.losses.values()].every((count) => count === 1)).toBe(true);
  });

  it.each(counts)('двойное устранение, %i участников: инварианты формата держатся', (n) => {
    const outcome = playOut(n, 'double-elim');

    expect(outcome.champion).toBe(1);
    expect(outcome.unresolved).toEqual([]);
    expect(outcome.slotConflicts).toEqual([]);

    if (effectiveFormat(n, 'double-elim') === 'single-elim') return;

    // Никто не выбывает раньше двух поражений, и выбывают все, кроме чемпиона.
    expect([...outcome.losses.values()].every((count) => count <= 2)).toBe(true);
    expect([...outcome.losses.values()].filter((count) => count === 2)).toHaveLength(n - 1);

    // Смысл формата: сыгравших ровно один матч не остаётся.
    expect([...outcome.playedBy.values()].every((count) => count >= 2)).toBe(true);
  });

  it('полная сетка двойного устранения играет ровно 2n-2 матчей', () => {
    for (const size of [4, 8, 16, 32]) {
      expect(playOut(size, 'double-elim').played).toBe(2 * size - 2);
    }
  });

  it('немедленных переигровок не возникает, кроме неустранимого случая на трёх участниках', () => {
    for (const n of counts) {
      const outcome = playOut(n, 'double-elim');
      // На трёх участниках финал нижней сетки — это единственная возможная пара, и
      // переигровка там неизбежна: третьему играть больше не с кем.
      if (n === 3) continue;
      expect(outcome.immediateRematches, `${n} участников`).toEqual([]);
    }
  });
});
