import type { TournamentGame } from '../schema.js';

/**
 * Что вообще выбирают перед матчем. Две разные вещи под одним словом «драфт»:
 *
 * - **Valorant — карты.** Вне игры это единственный способ их поделить: в кастомном матче
 *   Riot никакого вето не предлагает, и командам приходится договариваться словами. Здесь
 *   договорённость получает протокол, который нельзя переписать задним числом.
 * - **Dota — герои.** Внутри клиента есть Captains Mode, и он делает это лучше. Смысл
 *   внешнего драфта другой: он остаётся записью. Договорились на сайте — воспроизвели в
 *   лобби на All Pick, и спорить «мы такого не банили» больше не о чем.
 *
 * Поэтому пул героев тянется из OpenDota, а не лежит константой: список меняется с каждым
 * патчем, и захардкоженные 126 имён устарели бы к первому же обновлению игры.
 */

export type DraftKind = 'ban' | 'pick';
export type DraftSide = 'a' | 'b';

export interface DraftStep {
  side: DraftSide;
  kind: DraftKind;
}

export interface DraftOption {
  /** Устойчивый идентификатор: по нему приходит выбор из браузера. */
  id: string;
  label: string;
  /** Картинка, если она есть. Карты и герои — вещи зрительные, списком их не выбирают. */
  imageUrl?: string;
}

/**
 * Соревновательный пул карт Valorant. Константа, а не настройка, и это осознанный размен:
 * Riot меняет пул раз в несколько месяцев, и правка одной строки в коде дешевле, чем
 * ещё одна команда настройки, которую администратор всё равно заполнит один раз.
 *
 * Если пул разошёлся с актуальным — правится здесь, и это единственное место.
 */
export const VALORANT_MAPS: readonly DraftOption[] = [
  { id: 'ascent', label: 'Ascent' },
  { id: 'bind', label: 'Bind' },
  { id: 'haven', label: 'Haven' },
  { id: 'icebox', label: 'Icebox' },
  { id: 'lotus', label: 'Lotus' },
  { id: 'split', label: 'Split' },
  { id: 'sunset', label: 'Sunset' },
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

  if (bestOf >= 3) {
    const steps: DraftStep[] = [
      { side: 'a', kind: 'ban' },
      { side: 'b', kind: 'ban' },
      { side: 'a', kind: 'pick' },
      { side: 'b', kind: 'pick' },
    ];
    // Дальше добиваем банами до единственной оставшейся — она станет решающей картой.
    let left = poolSize - 4;
    let side: DraftSide = 'a';
    while (left > 1) {
      steps.push({ side, kind: 'ban' });
      side = side === 'a' ? 'b' : 'a';
      left -= 1;
    }
    return steps;
  }

  const steps: DraftStep[] = [];
  let side: DraftSide = 'a';
  for (let left = poolSize; left > 1; left -= 1) {
    steps.push({ side, kind: 'ban' });
    side = side === 'a' ? 'b' : 'a';
  }
  return steps;
}

/**
 * Последовательность драфта героев. Не копия текущего Captains Mode: Valve меняет его
 * порядок патчами, и обещать совпадение значило бы обещать то, что сломается само.
 *
 * Здесь честная схема на 5 на 5: по два бана каждому, потом пики «змейкой»
 * (A, BB, AA, BB, AA, B). Змейка нужна, чтобы право первого пика не превращалось в
 * преимущество: у кого первый пик, у того второй и третий — последние.
 */
export const DOTA_DRAFT_SEQUENCE: readonly DraftStep[] = [
  { side: 'a', kind: 'ban' },
  { side: 'b', kind: 'ban' },
  { side: 'a', kind: 'ban' },
  { side: 'b', kind: 'ban' },
  { side: 'a', kind: 'pick' },
  { side: 'b', kind: 'pick' },
  { side: 'b', kind: 'pick' },
  { side: 'a', kind: 'pick' },
  { side: 'a', kind: 'pick' },
  { side: 'b', kind: 'pick' },
  { side: 'b', kind: 'pick' },
  { side: 'a', kind: 'pick' },
  { side: 'a', kind: 'pick' },
  { side: 'b', kind: 'pick' },
];

/** Что драфтится в этой дисциплине. `null` — драфт не предусмотрен. */
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
