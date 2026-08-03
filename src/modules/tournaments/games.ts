import type { TournamentGame } from './schema.js';

/**
 * Порядок фиксированный и используется как есть при построении вариантов
 * нативного голосования Discord: индекс дисциплины здесь совпадает с индексом
 * ответа опроса (answer_id Discord — это индекс + 1), и на этом позиционном
 * соответствии держится сопоставление голосов с дисциплинами в finalizer.ts.
 */
export const TOURNAMENT_GAMES: readonly TournamentGame[] = [
  'dota2',
  'lol',
  'tft',
  'valorant',
  // Новая дисциплина дописывается в конец, а не вставляется в середину: индекс здесь совпадает
  // с индексом ответа в опросе Discord, и сдвиг переписал бы смысл уже отданных голосов.
  'genshin',
];

export const TOURNAMENT_GAME_LABELS: Record<TournamentGame, string> = {
  dota2: 'Dota 2',
  lol: 'League of Legends',
  tft: 'Teamfight Tactics',
  valorant: 'Valorant',
  genshin: 'Genshin Impact',
};
