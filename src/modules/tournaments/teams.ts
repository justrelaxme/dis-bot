/**
 * Сбор команд из одиночек: люди записались по одному, а играть надо составами.
 *
 * Раздача «змейкой» по силе, а не случайная. Случайная жеребьёвка одинаково часто даёт и
 * ровные команды, и состав из пяти сильнейших против пяти слабейших — а второй случай это
 * испорченный вечер для десяти человек, и переиграть его нельзя. Змейка (сильнейший в первую
 * команду, второй во вторую, а на обратном проходе наоборот) выравнивает суммы почти всегда, и
 * это свойство проверяется тестом, а не берётся на веру.
 *
 * Смысл имеет только командный турнир: в матче один на один делить нечего.
 */

export interface Signup {
  /** Участник турнира, созданный при записи одиночкой. */
  entrantId: number;
  userId: string;
  /** Сила по рангу привязки. `null` — ранга нет, и такой игрок считается средним. */
  strength: number | null;
}

export interface FormedTeam {
  /** Игроки состава, сильнейший первым. Первый становится капитаном. */
  members: Signup[];
  /** Сумма силы состава: по ней видно, ровно ли получилось. */
  strength: number;
}

export interface Formation {
  teams: FormedTeam[];
  /**
   * Кто не попал ни в один состав. Остаток неизбежен: из семи человек команды по пять не
   * собрать, и выдумывать шестую команду из двоих нельзя — она проиграла бы механически.
   */
  benched: Signup[];
}

/**
 * Сколько полных команд выйдет. Неполных не бывает намеренно: состав из трёх против состава
 * из пяти это не турнир, а обида.
 */
export function fullTeams(signupCount: number, teamSize: number): number {
  if (teamSize < 1) return 0;
  return Math.floor(signupCount / teamSize);
}

/**
 * Средняя сила по тем, у кого ранг есть. Игрок без ранга получает её вместо нуля: ноль
 * означал бы «слабейший», а на самом деле означает «неизвестно», и такой игрок утягивал бы
 * свою команду вниз без причины.
 */
function averageStrength(signups: readonly Signup[]): number {
  const known = signups.map((signup) => signup.strength).filter((value): value is number => value !== null);
  if (known.length === 0) return 0;
  return known.reduce((sum, value) => sum + value, 0) / known.length;
}

/**
 * Раскладывает записавшихся по составам. Порядок раздачи — змейкой по убыванию силы.
 *
 * Лишние остаются вне сетки, и это честнее, чем добрать команду до размера кем попало: место
 * в неполном составе выглядит участием, а на деле им не является.
 */
export function formTeams(signups: readonly Signup[], teamSize: number): Formation {
  const count = fullTeams(signups.length, teamSize);
  if (count === 0) return { teams: [], benched: [...signups] };

  const fallback = averageStrength(signups);
  // Сортировка устойчивая: при равной силе порядок задаёт идентификатор, а не случай. Иначе
  // два прогона на одних данных давали бы разные команды, и объяснить это было бы нечем.
  const ranked = [...signups].sort((a, b) => {
    const left = a.strength ?? fallback;
    const right = b.strength ?? fallback;
    return right - left || a.entrantId - b.entrantId;
  });

  const taken = ranked.slice(0, count * teamSize);
  const benched = ranked.slice(count * teamSize);

  /**
   * Раздача жадная: каждый следующий по силе игрок идёт в самый слабый из недобранных
   * составов.
   *
   * Змейка здесь не годится, и это выяснилось тестом, а не рассуждением. При нечётном числе
   * кругов (например пять составов по три) первый состав получает первый выбор дважды —
   * на прямом проходе и на третьем, — и накапливает преимущество: на линейно убывающей силе
   * разброс выходил в четыре шага вместо одного. Жадная раздача сама выравнивает суммы, потому
   * что смотрит на текущее положение, а не на заранее заданный порядок.
   */
  const buckets: Signup[][] = Array.from({ length: count }, () => []);
  const sums = new Array<number>(count).fill(0);

  for (const signup of taken) {
    let target = -1;
    for (let bucket = 0; bucket < count; bucket += 1) {
      if ((buckets[bucket] as Signup[]).length >= teamSize) continue;
      // Строгое сравнение — значит при равных суммах берётся меньший номер. Так раздача
      // повторяема: два прогона на одних данных дают одни составы.
      if (target === -1 || (sums[bucket] as number) < (sums[target] as number)) target = bucket;
    }

    (buckets[target] as Signup[]).push(signup);
    sums[target] = (sums[target] as number) + (signup.strength ?? fallback);
  }

  /**
   * Доводка обменами. Одного прохода мало по структурной причине: в последнем круге раздачи
   * составы уже почти равны, и распределить между ними последнюю пятёрку соседних по силе
   * игроков без перекоса нельзя — сильнейший из остатка обязательно куда-то попадёт.
   * Обмен игроками между сильнейшим и слабейшим составом это исправляет: он смотрит на
   * готовое положение, а не на порядок раздачи.
   *
   * Обмен принимается только если разница сокращается, поэтому цикл сходится, а предел шагов
   * стоит на случай, когда сокращать больше нечем.
   */
  const value = (signup: Signup): number => signup.strength ?? fallback;
  for (let pass = 0; pass < count * teamSize * 4; pass += 1) {
    let strongest = 0;
    let weakest = 0;
    for (let bucket = 1; bucket < count; bucket += 1) {
      if ((sums[bucket] as number) > (sums[strongest] as number)) strongest = bucket;
      if ((sums[bucket] as number) < (sums[weakest] as number)) weakest = bucket;
    }

    const gap = (sums[strongest] as number) - (sums[weakest] as number);
    if (gap === 0) break;

    let bestGain = 0;
    let from = -1;
    let to = -1;
    const strong = buckets[strongest] as Signup[];
    const weak = buckets[weakest] as Signup[];
    for (let i = 0; i < strong.length; i += 1) {
      for (let j = 0; j < weak.length; j += 1) {
        const delta = value(strong[i] as Signup) - value(weak[j] as Signup);
        if (delta <= 0) continue;
        // После обмена разница станет |gap - 2*delta|. Берём обмен, который сокращает её больше.
        const gain = gap - Math.abs(gap - 2 * delta);
        if (gain > bestGain) {
          bestGain = gain;
          from = i;
          to = j;
        }
      }
    }

    if (bestGain <= 0) break;
    const moved = strong[from] as Signup;
    const back = weak[to] as Signup;
    strong[from] = back;
    weak[to] = moved;
    sums[strongest] = (sums[strongest] as number) - value(moved) + value(back);
    sums[weakest] = (sums[weakest] as number) - value(back) + value(moved);
  }

  return {
    teams: buckets.map((members) => ({
      // Сильнейший первым: он же становится капитаном, и выбирать его надо не случайно.
      members: [...members].sort((a, b) => value(b) - value(a) || a.entrantId - b.entrantId),
      strength: members.reduce((sum, member) => sum + value(member), 0),
    })),
    benched,
  };
}

/**
 * Названия автосоставов. Даются ботом, потому что давать их некому: капитана до раздачи нет.
 * Имена короткие и различимые на слух — их будут произносить в голосовом канале.
 */
export const AUTO_TEAM_NAMES: readonly string[] = [
  'Альфа',
  'Браво',
  'Сигма',
  'Дельта',
  'Эхо',
  'Фокстрот',
  'Гамма',
  'Гидра',
  'Кобальт',
  'Оникс',
  'Пирит',
  'Квант',
];

/** Имя составу по его номеру. За пределами списка нумеруем — лучше «Состав 13», чем повтор. */
export function autoTeamName(index: number): string {
  return AUTO_TEAM_NAMES[index] ?? `Состав ${index + 1}`;
}
