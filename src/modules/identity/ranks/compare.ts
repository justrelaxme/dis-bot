import type { RankInfo } from '../providers/provider.js';
import { DOTA_MEDALS } from './dota.js';
import { ABYSS_FLOORS } from './genshin.js';
import { RIOT_TIERS, VALORANT_TIERS } from './riot.js';

const DIVISION_ORDER: Record<string, number> = { IV: 0, III: 1, II: 2, I: 3, '1': 0, '2': 1, '3': 2, '4': 3, '5': 4 };

const TIER_POINTS = 1_000;
const DIVISION_POINTS = 100;

function tierIndex(rank: RankInfo): number {
  if (!rank.tier) return -1;

  // Этажи Бездны — своя линейка: «12» в ней двенадцатая ступень, а не тир Riot с таким
  // названием (такого тира нет, и общий indexOf вернул бы -1, то есть «ранга нет» у того,
  // кто прошёл всю Бездну). Считаются они от единицы, а не от нуля: позиция в списке дала бы
  // первому этажу нуль, а нуль здесь означает именно отсутствие ранга — и прошедший 1-1
  // оказался бы неотличим от того, кто Бездну не открывал.
  if (rank.scale === 'genshin-abyss') {
    const floor = ABYSS_FLOORS.indexOf(rank.tier as (typeof ABYSS_FLOORS)[number]);
    return floor < 0 ? -1 : floor + 1;
  }

  const scale = rank.scale === 'dota-mmr' ? DOTA_MEDALS :
                rank.scale === 'valorant-tier' ? VALORANT_TIERS :
                RIOT_TIERS;

  return (scale as readonly string[]).indexOf(rank.tier);
}

/**
 * Сопоставимое число для порогов ролей и лидербордов.
 * Ноль означает «ранга нет» — так порог «Platinum и выше» не пропустит unranked.
 */
export function rankScore(rank: RankInfo): number {
  const tier = tierIndex(rank);
  if (tier < 0) return 0;

  const division = rank.division ? (DIVISION_ORDER[rank.division] ?? 0) : 0;
  const points = rank.points ?? 0;

  // Для dota-mmr очки не учитываются: место в лидерборде — отдельное измерение.
  // Для других шкал очки ограничиваются, чтобы не перескочить следующую ступеньку:
  // - у ранга с дивизионом: следующая ступенька — дивизион, обрезаем в DIVISION_POINTS-1
  // - у ранга без дивизиона: следующая ступенька — тир, обрезаем в TIER_POINTS-1
  const pointsCapped = rank.scale === 'dota-mmr'
    ? 0
    : rank.division !== null
      ? Math.min(points, DIVISION_POINTS - 1)
      : Math.min(points, TIER_POINTS - 1);

  return tier * TIER_POINTS + division * DIVISION_POINTS + pointsCapped;
}

/**
 * Изменением считается смена тира или дивизиона, а у тиров без дивизионов —
 * ещё и сдвиг очков. Дрейф LP внутри дивизиона изменением не является: иначе
 * rank.changed срабатывал бы после каждого матча и перевыдавал роли впустую.
 */
export function hasRankChanged(previous: RankInfo | null, next: RankInfo): boolean {
  if (!previous) return true;
  if (previous.tier !== next.tier) return true;
  if (previous.division !== next.division) return true;
  if (next.division === null && previous.points !== next.points) return true;
  return false;
}
