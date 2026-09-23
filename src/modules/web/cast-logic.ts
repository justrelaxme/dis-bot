import type { MatchBracket } from '../tournaments/bracket.js';
import type { TournamentState } from '../tournaments/schema.js';

/**
 * Что показывать на трансляции. Чистые функции: всё решение — по состоянию турнира и матчей,
 * и проверять его надо без Discord и без базы.
 *
 * Трансляция на сервере — это окно браузера, показанное через Go Live в голосовом канале.
 * Кастера за пультом может не быть вовсе, поэтому по умолчанию сцена выбирается сама: до
 * старта — «скоро начало», идёт драфт главного матча — драфт, матч начался — табло матча,
 * между матчами — сетка, после финала — пьедестал. Пульт нужен, только чтобы это переопределить.
 */

export const CAST_SCENES = ['soon', 'bracket', 'draft', 'match', 'podium'] as const;
export type CastScene = (typeof CAST_SCENES)[number];

/** Запрошенная сцена: конкретная или `auto` — пусть решает бот. */
export type CastSceneRequest = CastScene | 'auto';

export function isCastSceneRequest(value: unknown): value is CastSceneRequest {
  return value === 'auto' || (typeof value === 'string' && (CAST_SCENES as readonly string[]).includes(value));
}

/** Матч в объёме, нужном для выбора главного. */
export interface CastMatch {
  id: number;
  bracket: MatchBracket;
  round: number;
  state: string;
  entrantAId: number | null;
  entrantBId: number | null;
  liveAt: Date | null;
}

const BRACKET_WEIGHT: Record<MatchBracket, number> = { upper: 0, lower: 0, grand: 100 };

/**
 * Главный матч — тот, на который смотрят. Из идущих — самый поздний по сетке: финал важнее
 * четвертьфинала, и если их играют одновременно, трансляция показывает финал. Идущих нет —
 * готовый к игре, потом ждущий подтверждения. Никакого — `null`, и сцена матча не нужна.
 */
export function pickFeatured(matches: readonly CastMatch[]): CastMatch | null {
  const playable = matches.filter((match) => match.entrantAId !== null && match.entrantBId !== null);
  const weight = (match: CastMatch): number => BRACKET_WEIGHT[match.bracket] + match.round;
  const best = (list: CastMatch[]): CastMatch | null =>
    list.reduce<CastMatch | null>((top, match) => (top === null || weight(match) > weight(top) ? match : top), null);

  return (
    best(playable.filter((match) => match.state === 'ready' && match.liveAt !== null)) ??
    best(playable.filter((match) => match.state === 'ready')) ??
    best(playable.filter((match) => match.state === 'reported' || match.state === 'disputed')) ??
    null
  );
}

export interface AutoSceneInput {
  tournamentState: TournamentState;
  featured: { live: boolean; draftActive: boolean } | null;
}

/** Сцена, которую выбрал бы кастер, если бы он был. */
export function autoScene(input: AutoSceneInput): CastScene {
  if (input.tournamentState === 'draft' || input.tournamentState === 'registration') return 'soon';
  if (input.tournamentState === 'finished') return 'podium';
  if (input.tournamentState !== 'running' || !input.featured) return 'bracket';
  if (input.featured.draftActive) return 'draft';
  if (input.featured.live) return 'match';
  return 'bracket';
}

/**
 * Итоговая сцена: запрошенная, если она осмысленна сейчас, иначе автоматическая. Пьедестал до
 * конца турнира или табло без матча показали бы пустой экран — трансляции это хуже, чем сцена,
 * которую не просили.
 */
export function resolveScene(requested: CastSceneRequest, input: AutoSceneInput): CastScene {
  if (requested === 'auto') return autoScene(input);
  if (requested === 'podium' && input.tournamentState !== 'finished') return autoScene(input);
  if ((requested === 'match' || requested === 'draft') && !input.featured) return autoScene(input);
  return requested;
}

/** Подпись круга для табло: «Финал», «Полуфинал», «Нижняя сетка · круг 2». */
export function roundLabel(match: Pick<CastMatch, 'bracket' | 'round'>, upperRounds: number, lowerRounds: number): string {
  if (match.bracket === 'grand') return 'Гранд-финал';
  if (match.bracket === 'lower') return match.round === lowerRounds ? 'Финал нижней сетки' : `Нижняя сетка · круг ${match.round}`;
  if (match.round === upperRounds) return lowerRounds > 0 ? 'Финал верхней сетки' : 'Финал';
  if (match.round === upperRounds - 1) return 'Полуфинал';
  if (match.round === upperRounds - 2) return 'Четвертьфинал';
  return `Круг ${match.round}`;
}
