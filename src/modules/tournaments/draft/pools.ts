import type { TournamentGame } from '../schema.js';

/**
 * Что вообще выбирают перед матчем. Три разные вещи под одним словом «драфт»:
 *
 * - **Карты Valorant.** Вне игры это единственный способ их поделить: в кастомном матче
 *   Riot никакого вето не предлагает, и командам приходится договариваться словами. Здесь
 *   договорённость получает протокол, который нельзя переписать задним числом.
 * - **Агенты Valorant.** В самой игре агентов не делят: обе команды могут взять одного и
 *   того же, и запрета нет. Значит, это **правило сервера**, а не правило Riot, — и оно
 *   держится на честности участников ровно так же, как драфт героев Dota: воспроизвести
 *   его в лобби никто не заставит, зато спорить «мы такого не банили» больше не о чем.
 * - **Герои Dota.** Внутри клиента есть Captains Mode, и он делает это лучше. Смысл
 *   внешнего драфта тот же: он остаётся записью.
 *
 * Поэтому пул героев и агентов тянется из справочников, а не лежит константой: списки
 * меняются с патчами, и захардкоженные имена устарели бы к первому же обновлению игры.
 * Карты — исключение: их семь, и меняются они раз в несколько месяцев.
 */

export type DraftKind = 'ban' | 'pick';
export type DraftSide = 'a' | 'b';

/**
 * Из какого набора выбирают. У Valorant драфт идёт в две фазы — сначала карты, потом
 * агенты, — и без этой пометки шаг не знал бы, что ему предлагать.
 *
 * Пометка необязательна: у драфтов, заведённых до появления фаз, её нет, и там она
 * восстанавливается из `subject` строки драфта. Так прошлые записи остаются читаемыми — а
 * они и есть то, ради чего драфт заводился.
 */
export type DraftGroup = 'maps' | 'heroes' | 'agents';

export interface DraftStep {
  side: DraftSide;
  kind: DraftKind;
  group?: DraftGroup;
}

export interface DraftOption {
  /** Устойчивый идентификатор: по нему приходит выбор из браузера. */
  id: string;
  label: string;
  /** Крупная картинка для плитки. Карты, герои и агенты — вещи зрительные. */
  imageUrl?: string;
  /**
   * Мелкая картинка — там, где нужна размером с букву: в плашках забаненного и выбранного.
   * У карты это схема сверху, у героя и агента — иконка. Схема карты попадает сюда не для
   * красоты: на плитке она открывается по наведению, а по планировке карту и выбирают.
   */
  iconUrl?: string;
  group?: DraftGroup;
}

/**
 * Считается ли уцелевшее итогом фазы.
 *
 * У карт — да: банят до последней оставшейся, и она и есть решающая, её никто не выбирал.
 * У героев и агентов — нет, и это принципиально. Забанили четырёх из ста двадцати семи
 * героев, взяли десять — «итогом» остальные сто тринадцать не являются ни в каком смысле.
 */
export function survivorsAreResult(group: DraftGroup): boolean {
  return group === 'maps';
}

const VALORANT_MEDIA = 'https://media.valorant-api.com/maps';

/**
 * Идентификаторы карт в данных Riot — постоянные UUID, поэтому ссылки на картинки стоят
 * здесь константами, а не запрашиваются справочником: сетевой вызов ради данных, которые не
 * меняются, добавил бы только ещё один способ не показать картинку.
 *
 * Берётся `listviewicon` (66 КБ), а не `splash` (2,3 МБ): вето — это семь плиток на одном
 * экране, и полноразмерные всплески означали бы шестнадцать мегабайт на выбор одной карты.
 */
function valorantMap(id: string, label: string, uuid: string): DraftOption {
  return {
    id,
    label,
    group: 'maps',
    imageUrl: `${VALORANT_MEDIA}/${uuid}/listviewicon.png`,
    iconUrl: `${VALORANT_MEDIA}/${uuid}/displayicon.png`,
  };
}

/**
 * Соревновательный пул карт Valorant. Константа, а не настройка, и это осознанный размен:
 * Riot меняет пул раз в несколько месяцев, и правка одной строки в коде дешевле, чем
 * ещё одна команда настройки, которую администратор всё равно заполнит один раз.
 *
 * Если пул разошёлся с актуальным — правится здесь, и это единственное место.
 */
export const VALORANT_MAPS: readonly DraftOption[] = [
  valorantMap('ascent', 'Ascent', '7eaecc1b-4337-bbf6-6ab9-04b8f06b3319'),
  valorantMap('bind', 'Bind', '2c9d57ec-4431-9c5e-2939-8f9ef6dd5cba'),
  valorantMap('haven', 'Haven', '2bee0dc9-4ffe-519b-1cbd-7fbe763a6047'),
  valorantMap('icebox', 'Icebox', 'e2ad5c54-4114-a870-9641-8ea21279579a'),
  valorantMap('lotus', 'Lotus', '2fe4ed3a-450a-948b-6d6b-e89a78e680a9'),
  valorantMap('split', 'Split', 'd960549e-485c-e861-8d71-aa9d1aed12a2'),
  valorantMap('sunset', 'Sunset', '92584fbe-486a-b1b2-9faa-39b0f486b498'),
];

/**
 * Последовательность вето карт. Для одной карты — чередующиеся баны до последней
 * оставшейся: она и есть выбранная, и никто не выбирал её сам, поэтому спорить не о чем.
 *
 * Для трёх карт — банят, выбирают, банят: две выбранные командами плюс решающая из
 * остатка. Порядок «первый банит — второй выбирает» уравнивает первый ход: право
 * первого бана компенсируется правом первого пика.
 */
export function mapVetoSequence(poolSize: number, bestOf: number): DraftStep[] {
  if (poolSize < 2) return [];
  const step = (side: DraftSide, kind: DraftKind): DraftStep => ({ side, kind, group: 'maps' });

  if (bestOf >= 3) {
    const steps: DraftStep[] = [
      step('a', 'ban'),
      step('b', 'ban'),
      step('a', 'pick'),
      step('b', 'pick'),
    ];
    // Дальше добиваем банами до единственной оставшейся — она станет решающей картой.
    let left = poolSize - 4;
    let side: DraftSide = 'a';
    while (left > 1) {
      steps.push(step(side, 'ban'));
      side = side === 'a' ? 'b' : 'a';
      left -= 1;
    }
    return steps;
  }

  const steps: DraftStep[] = [];
  let side: DraftSide = 'a';
  for (let left = poolSize; left > 1; left -= 1) {
    steps.push(step(side, 'ban'));
    side = side === 'a' ? 'b' : 'a';
  }
  return steps;
}

/**
 * Порядок пиков «змейкой»: один, потом по два, и последний снова один — A, BB, AA, BB, AA, B.
 *
 * Змейка нужна, чтобы право первого пика не превращалось в преимущество: у кого первый
 * пик, у того второй и третий — последние. Схема сама уравнивает стороны при любом числе
 * пиков, и это проверяется тестом, а не считается на глаз.
 */
function snakePicks(perSide: number): DraftSide[] {
  const total = perSide * 2;
  const order: DraftSide[] = [];
  let side: DraftSide = 'a';
  // Первый блок — один пик, дальше по два: это и делает порядок змейкой.
  let block = 1;
  while (order.length < total) {
    for (let taken = 0; taken < block && order.length < total; taken += 1) order.push(side);
    side = side === 'a' ? 'b' : 'a';
    block = 2;
  }
  return order;
}

/**
 * Последовательность банов и пиков для героев или агентов: сначала баны по очереди, потом
 * пики змейкой. Не копия Captains Mode: Valve меняет его порядок патчами, и обещать
 * совпадение значило бы обещать то, что сломается само.
 *
 * Число пиков равно размеру команды, а не зашито пятёркой. Драфт на пять героев в турнире
 * один на один выдавал бы игроку четырёх лишних — а именно так и было, пока размер команды
 * здесь не учитывался.
 */
export function pickBanSequence(
  group: Exclude<DraftGroup, 'maps'>,
  picksPerSide: number,
  bansPerSide: number,
): DraftStep[] {
  if (picksPerSide < 1) return [];

  const steps: DraftStep[] = [];
  for (let round = 0; round < bansPerSide; round += 1) {
    steps.push({ side: 'a', kind: 'ban', group }, { side: 'b', kind: 'ban', group });
  }
  for (const side of snakePicks(picksPerSide)) {
    steps.push({ side, kind: 'pick', group });
  }
  return steps;
}

/**
 * Сколько банов на сторону. Два в командном матче и один в одиночном: бан отнимает вариант
 * у обоих, и четыре бана при двух пиках оставили бы драфт без выбора.
 */
export function bansFor(teamSize: number): number {
  return teamSize > 1 ? 2 : 1;
}

/** Драфт героев Dota на пятёрку — тот порядок, что был до появления форматов. */
export const DOTA_DRAFT_SEQUENCE: readonly DraftStep[] = pickBanSequence('heroes', 5, 2);

/**
 * Хватает ли набора на такую последовательность. Пул из трёх агентов при четырёх банах
 * оставил бы драфт в состоянии, из которого нет выхода: банить есть что, а выбирать нечего.
 */
export function poolFits(poolSize: number, steps: readonly DraftStep[], group: DraftGroup): boolean {
  const needed = steps.filter((step) => (step.group ?? group) === group).length;
  return poolSize >= needed;
}

/**
 * Что драфтится в этой дисциплине. `null` — драфт не предусмотрен.
 *
 * Для Valorant это первая фаза: карты. Агенты идут после них, и в последовательности они
 * помечены своим набором.
 */
export function draftSubject(game: TournamentGame): 'heroes' | 'maps' | null {
  if (game === 'dota2') return 'heroes';
  if (game === 'valorant') return 'maps';
  // LoL и TFT: у LoL свой драфт в клиенте и он обязателен, у TFT соперников восемь и
  // делить нечего. Обещать драфт там, где он не нужен, — лишняя кнопка.
  return null;
}

export const SUBJECT_LABELS: Record<'heroes' | 'maps', { one: string; many: string }> = {
  heroes: { one: 'герой', many: 'герои' },
  maps: { one: 'карта', many: 'карты' },
};

/** Как называть набор на странице. Родительный падеж — он нужен в «бан карты», «пик героя». */
export const GROUP_LABELS: Record<DraftGroup, { many: string; one: string; of: string }> = {
  maps: { many: 'Карты', one: 'карта', of: 'карту' },
  heroes: { many: 'Герои', one: 'герой', of: 'героя' },
  agents: { many: 'Агенты', one: 'агент', of: 'агента' },
};
