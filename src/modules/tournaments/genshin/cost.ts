/**
 * Стоимость состава Genshin: чем измерять вложения в аккаунт, чтобы турнир был честным.
 *
 * Задача, которую это решает, у сообщества Genshin главная и старше самого бота. Игра
 * одиночная, аккаунты разные, и «кто прошёл Бездну быстрее» сравнивает не умение, а суммы
 * потраченного: C6 с сигнатурным оружием проходит этаж быстрее C0 при любом игроке. Поэтому
 * соревнуются не по времени, а по времени **при равных вложениях**, и вложения считают очками.
 *
 * Система взята готовой, а не придумана: её используют в спидран-турнирах по Бездне, и её же
 * ждут игроки, которые в таких турнирах участвовали.
 *
 *   Персонаж:  4★ — 0 очков всегда. Стандартный 5★ — (созвездие + 1) × 0.5.
 *              Лимитированный 5★ — созвездие + 1. Путешественник — 0.
 *   Оружие:    4★ и ниже — 0 всегда. Стандартное 5★ — огранка × 0.5.
 *              Лимитированное 5★ — огранка.
 *
 * Два следствия из этих правил стоит понимать заранее, потому что они неочевидны и оба
 * намеренные:
 *
 * - **Четырёхзвёздочные бесплатны совсем.** Не «дешевле», а ноль — при любом созвездии. Это
 *   и делает формат с бюджетом интересным: состав из четвёрок не стоит ничего, и вопрос в том,
 *   сумеешь ли ты собрать им этаж.
 * - **Артефакты не стоят ничего.** Это не пробел: артефакты фармятся временем, а не деньгами,
 *   и доступны всем одинаково. Оценивать их значило бы наказывать за то, что человек играл.
 *
 * Источники:
 *   https://www.stygian.moe/guide/genshin-team-cost-guide — сама система очков
 *   https://spiralabyss.org/leaderboards?event=floor12 — категории турниров сообщества
 */

/**
 * Стандартные пятизвёздочные персонажи: те, что выпадают в постоянной молитве. Их вложение
 * стоит вдвое дешевле, потому что достаются они и без охоты за баннером.
 *
 * Идентификаторы сверены со справочником по русским именам, а не взяты по памяти. Список
 * пополняется редко — HoYoverse добавляет в постоянную молитву персонажа раз в год-полтора, и
 * тогда сюда надо дописать строку.
 *
 * Незнакомый пятизвёздочный считается лимитированным, то есть дороже. Ошибка в эту сторону
 * безопасна: состав выглядит дороже, чем он есть, и это видно организатору — а не наоборот,
 * когда дорогой аккаунт незаметно проходит по бюджету.
 */
export const STANDARD_FIVE_STAR_IDS: readonly string[] = [
  '10000003', // Джинн
  '10000016', // Дилюк
  '10000035', // Ци Ци
  '10000041', // Мона
  '10000042', // Кэ Цин
  '10000069', // Тигнари
  '10000079', // Дэхья
];

/**
 * Стандартное пятизвёздочное оружие — десять штук из постоянной молитвы. Сверять их с
 * машинным справочником оказалось не с чем: выгрузки оружия Enka не публикует, а найденные
 * наборы данных недоступны. Поэтому список по именам, сразу на двух языках: бот просит у
 * HoYoLAB русскую локализацию, но язык — настройка, и однажды она может оказаться другой.
 *
 * Набор не менялся с выхода игры: новое пятизвёздочное оружие HoYoverse добавляет только
 * лимитированным. Незнакомое пятизвёздочное считается лимитированным — та же безопасная
 * сторона ошибки, что и у персонажей.
 */
const STANDARD_FIVE_STAR_WEAPONS: readonly string[] = [
  'меч фавония',
  'aquila favonia',
  'небесное крыло',
  'skyward blade',
  'небесная гордость',
  'skyward pride',
  'могильщик волков',
  "wolf's gravestone",
  'нефритовое копьё',
  'primordial jade winged-spear',
  'небесная ось',
  'skyward spine',
  'небесный атлас',
  'skyward atlas',
  'потерянная молитва священным ветрам',
  'lost prayer to the sacred winds',
  'лук амоса',
  "amos' bow",
  'небесное крыло амоса',
  'небесная песня',
  'skyward harp',
];

/** Оружие персонажа в том виде, в каком его отдаёт Летопись. Может не прийти вовсе. */
export interface CostedWeapon {
  name: string;
  rarity: number;
  /** Огранка, от 1 до 5. У HoYoLAB это `affix_level`. */
  refinement: number;
}

export interface CostedCharacter {
  /** Тот же идентификатор, что в справочнике Enka и в пуле драфта. */
  id: string;
  name: string;
  rarity: number;
  constellation: number;
  weapon?: CostedWeapon | undefined;
}

export interface CharacterCost {
  /** Сколько стоит сам персонаж со своим созвездием. */
  character: number;
  /** Сколько стоит его оружие с огранкой. Ноль, если оружие неизвестно или четырёхзвёздочное. */
  weapon: number;
  total: number;
}

/** Путешественник бесплатен на любом созвездии: он есть у каждого по определению. */
function isTraveler(id: string): boolean {
  return id.startsWith('10000005') || id.startsWith('10000007');
}

function clampConstellation(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(6, Math.max(0, Math.trunc(value)));
}

function clampRefinement(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(5, Math.max(1, Math.trunc(value)));
}

/** Сколько стоит персонаж со своим созвездием. */
export function characterCost(character: Pick<CostedCharacter, 'id' | 'rarity' | 'constellation'>): number {
  if (character.rarity < 5) return 0;
  if (isTraveler(character.id)) return 0;

  const steps = clampConstellation(character.constellation) + 1;
  return STANDARD_FIVE_STAR_IDS.includes(character.id) ? steps * 0.5 : steps;
}

/** Сколько стоит оружие с его огранкой. */
export function weaponCost(weapon: CostedWeapon | undefined): number {
  if (!weapon || weapon.rarity < 5) return 0;

  const refinement = clampRefinement(weapon.refinement);
  const standard = STANDARD_FIVE_STAR_WEAPONS.includes(weapon.name.trim().toLowerCase());
  return standard ? refinement * 0.5 : refinement;
}

export function costOf(character: CostedCharacter): CharacterCost {
  const own = characterCost(character);
  const arms = weaponCost(character.weapon);
  // Очки бывают половинными, и сумма половин иногда даёт хвост из-за двоичных дробей.
  // Округление до десятых убирает «2.9999999999999996» в отчёте, ничего не меняя по сути.
  return { character: own, weapon: arms, total: round(own + arms) };
}

/** Половинные очки складываются в двоичные хвосты — приводим к одной десятой. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface TeamCost {
  total: number;
  /** По персонажу — чтобы было видно, кто именно съел бюджет, а не только итог. */
  perCharacter: { id: string; name: string; cost: CharacterCost }[];
}

export function teamCost(characters: readonly CostedCharacter[]): TeamCost {
  const perCharacter = characters.map((character) => ({
    id: character.id,
    name: character.name,
    cost: costOf(character),
  }));
  return {
    total: round(perCharacter.reduce((sum, entry) => sum + entry.cost.total, 0)),
    perCharacter,
  };
}

export interface BudgetVerdict {
  /** Влезает ли состав в потолок. Без потолка — влезает всегда. */
  fits: boolean;
  /** На сколько превышен потолок. Ноль, если влезает. */
  over: number;
  cap: number | null;
  spent: number;
}

/**
 * Влезает ли состав в бюджет. Потолок `null` означает «без ограничения» — обычный турнир, где
 * играют чем есть.
 */
export function budgetVerdict(spent: number, cap: number | null): BudgetVerdict {
  if (cap === null) return { fits: true, over: 0, cap: null, spent };
  const over = round(Math.max(0, spent - cap));
  return { fits: over === 0, over, cap, spent };
}

/** Очки словами: половинки пишем как есть, целые — без хвоста. */
export function formatCost(value: number): string {
  const rounded = round(value);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
