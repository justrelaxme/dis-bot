import { describe, expect, it } from 'vitest';
import { TOURNAMENT_GAME_LABELS, TOURNAMENT_GAMES } from '../../../src/modules/tournaments/games.js';

describe('TOURNAMENT_GAMES', () => {
  it('перечисляет ровно четыре дисциплины в фиксированном порядке', () => {
    expect(TOURNAMENT_GAMES).toEqual(['dota2', 'lol', 'tft', 'valorant']);
  });

  it('даёт человеческую подпись каждой дисциплине', () => {
    expect(TOURNAMENT_GAME_LABELS.dota2).toBe('Dota 2');
    expect(TOURNAMENT_GAME_LABELS.lol).toBe('League of Legends');
    expect(TOURNAMENT_GAME_LABELS.tft).toBe('Teamfight Tactics');
    expect(TOURNAMENT_GAME_LABELS.valorant).toBe('Valorant');
  });

  it('содержит подпись ровно для каждой дисциплины из списка', () => {
    const labelKeys = Object.keys(TOURNAMENT_GAME_LABELS).sort();
    expect(labelKeys).toEqual([...TOURNAMENT_GAMES].sort());
  });
});
