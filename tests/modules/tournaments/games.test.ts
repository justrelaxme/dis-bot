import { describe, expect, it } from 'vitest';
import { TOURNAMENT_GAME_LABELS, TOURNAMENT_GAMES } from '../../../src/modules/tournaments/games.js';

describe('TOURNAMENT_GAMES', () => {
  // Порядок здесь — не косметика: индекс дисциплины в этом списке совпадает с номером
  // ответа в голосовании Discord. Новая дисциплина поэтому дописывается в конец, иначе
  // уже поданные голоса начали бы значить другое.
  it('перечисляет дисциплины в фиксированном порядке, новые — в конце', () => {
    expect(TOURNAMENT_GAMES).toEqual(['dota2', 'lol', 'tft', 'valorant', 'genshin']);
  });

  it('даёт человеческую подпись каждой дисциплине', () => {
    expect(TOURNAMENT_GAME_LABELS.dota2).toBe('Dota 2');
    expect(TOURNAMENT_GAME_LABELS.lol).toBe('League of Legends');
    expect(TOURNAMENT_GAME_LABELS.tft).toBe('Teamfight Tactics');
    expect(TOURNAMENT_GAME_LABELS.valorant).toBe('Valorant');
    expect(TOURNAMENT_GAME_LABELS.genshin).toBe('Genshin Impact');
  });

  it('содержит подпись ровно для каждой дисциплины из списка', () => {
    const labelKeys = Object.keys(TOURNAMENT_GAME_LABELS).sort();
    expect(labelKeys).toEqual([...TOURNAMENT_GAMES].sort());
  });
});
