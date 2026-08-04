import { describe, expect, it } from 'vitest';
import {
  KNOWN_TOURNAMENT_GAMES,
  TOURNAMENT_GAME_LABELS,
  TOURNAMENT_GAMES,
} from '../../../src/modules/tournaments/games.js';

describe('TOURNAMENT_GAMES', () => {
  it('предлагает только те дисциплины, по которым играют сейчас', () => {
    expect(TOURNAMENT_GAMES).toEqual(['dota2', 'valorant', 'genshin']);
  });

  /**
   * Понимаемых дисциплин больше, чем предлагаемых, и это главное свойство пары списков.
   * В базе лежат прошлые турниры по LoL и TFT, у игроков подтверждённые привязки, в зале
   * славы титулы. Убрать их из понимаемых значит превратить прошлое сервера в «неизвестная
   * дисциплина» — а бот заводился ровно ради того, чтобы это прошлое было.
   */
  it('понимает и те дисциплины, по которым больше не играют', () => {
    for (const game of TOURNAMENT_GAMES) expect(KNOWN_TOURNAMENT_GAMES).toContain(game);
    expect(KNOWN_TOURNAMENT_GAMES).toContain('lol');
    expect(KNOWN_TOURNAMENT_GAMES).toContain('tft');
  });

  it('даёт человеческую подпись каждой дисциплине', () => {
    expect(TOURNAMENT_GAME_LABELS.dota2).toBe('Dota 2');
    expect(TOURNAMENT_GAME_LABELS.lol).toBe('League of Legends');
    expect(TOURNAMENT_GAME_LABELS.tft).toBe('Teamfight Tactics');
    expect(TOURNAMENT_GAME_LABELS.valorant).toBe('Valorant');
    expect(TOURNAMENT_GAME_LABELS.genshin).toBe('Genshin Impact');
  });

  /** Подпись нужна каждой понимаемой, а не каждой предлагаемой: страницу старого турнира
   * тоже надо чем-то подписать. */
  it('содержит подпись ровно для каждой понимаемой дисциплины', () => {
    const labelKeys = Object.keys(TOURNAMENT_GAME_LABELS).sort();
    expect(labelKeys).toEqual([...KNOWN_TOURNAMENT_GAMES].sort());
  });
});
