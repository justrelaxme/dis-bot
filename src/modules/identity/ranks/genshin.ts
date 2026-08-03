import type { RankInfo } from '../providers/provider.js';

/**
 * Витая Бездна вместо ранга.
 *
 * У Genshin рейтинга нет вовсе: игра одиночная, соревновательного режима в ней не
 * предусмотрено, и «ранг» здесь пришлось выбрать. Выбрана Бездна, потому что это
 * единственное в игре, что измеряет силу отряда одинаковой для всех линейкой: этажи идут по
 * возрастанию, двенадцатый проходят не все, и «12-3» на сервере значит ровно то же, что
 * значит у любого другого игрока. Ранг приключений считает только сыгранные часы, а
 * уровень мира вообще выставляется вручную.
 *
 * Этаж — тир, зал — дивизион. Звёзды в шкалу не идут: их отдаёт не тот ответ Enka, что
 * этаж, и добавлять к «12-3» ещё одно измерение значило бы разделять игроков по мелочи,
 * которая к проходимости этажа отношения не имеет.
 */

/** Порядок значим: индекс — числовая шкала в compare.ts. Этажей в Бездне двенадцать. */
export const ABYSS_FLOORS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'] as const;

/** Залов на этаже три. Совпадает с DIVISION_ORDER в compare.ts, где '1' ниже '3'. */
export const ABYSS_CHAMBERS = ['1', '2', '3'] as const;

export const GENSHIN_ABYSS_MODE = 'genshin-abyss';

/** То, что Enka отдаёт про Бездну. Обоих полей может не быть: Бездну проходят не все. */
export interface EnkaTowerProgress {
  towerFloorIndex?: number | null | undefined;
  towerLevelIndex?: number | null | undefined;
}

/**
 * Прогресс Бездны в общий вид ранга. `null` означает «Бездна не пройдена» — законное
 * состояние нового аккаунта, а не сбой: этаж открывается с двадцатого ранга приключений.
 *
 * Enka нумерует этаж с единицы, а зал — тоже с единицы, но только пока этаж пройден
 * целиком; на недопройденном этаже зал показывает последний взятый. Поэтому зал
 * ограничивается тремя: значение вне диапазона означало бы зал, которого на этаже нет.
 */
export function normalizeAbyssRank(progress: EnkaTowerProgress): RankInfo | null {
  const floor = progress.towerFloorIndex;
  if (floor === null || floor === undefined) return null;

  const tier = ABYSS_FLOORS[floor - 1];
  if (!tier) return null;

  const level = progress.towerLevelIndex ?? 1;
  const division = ABYSS_CHAMBERS[Math.min(Math.max(level, 1), ABYSS_CHAMBERS.length) - 1] ?? '1';

  return {
    mode: GENSHIN_ABYSS_MODE,
    scale: 'genshin-abyss',
    tier,
    division,
    points: null,
    source: 'api',
    raw: { towerFloorIndex: floor, towerLevelIndex: progress.towerLevelIndex ?? null },
  };
}

/** Как Бездну пишут игроки: «12-3». Ни этаж, ни зал по отдельности ничего не значат. */
export function formatAbyss(rank: RankInfo): string {
  return rank.division ? `${rank.tier ?? '?'}-${rank.division}` : `${rank.tier ?? '?'} этаж`;
}
