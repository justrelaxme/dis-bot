import { describe, expect, it } from 'vitest';
import {
  determineOutcome,
  pluralizeVotes,
  renderOutcomeMessage,
  type GameTally,
} from '../../../src/modules/tournaments/outcome.js';

describe('determineOutcome', () => {
  it('выбирает победителя по числу голосов, а не по порядку в массиве', () => {
    // Порядок массива намеренно не совпадает с порядком по голосам: dota2 первый
    // элемент, но valorant набрал больше всех. Реализация, которая молча возвращает
    // tally[0], а не вариант с максимумом голосов, здесь обязана упасть — это и есть
    // мутационная проверка №2 из отчёта.
    const tally: GameTally[] = [
      { game: 'dota2', voteCount: 2 },
      { game: 'lol', voteCount: 5 },
      { game: 'tft', voteCount: 1 },
      { game: 'valorant', voteCount: 9 },
    ];

    expect(determineOutcome(tally)).toEqual({ kind: 'winner', game: 'valorant', tally });
  });

  it('единственный голос за один вариант — уверенная победа, а не ничья', () => {
    const tally: GameTally[] = [
      { game: 'dota2', voteCount: 0 },
      { game: 'lol', voteCount: 1 },
      { game: 'tft', voteCount: 0 },
      { game: 'valorant', voteCount: 0 },
    ];

    expect(determineOutcome(tally)).toEqual({ kind: 'winner', game: 'lol', tally });
  });

  it('признаёт ничью, когда у двух дисциплин поровну голосов и это максимум', () => {
    const tally: GameTally[] = [
      { game: 'dota2', voteCount: 7 },
      { game: 'lol', voteCount: 3 },
      { game: 'tft', voteCount: 7 },
      { game: 'valorant', voteCount: 1 },
    ];

    const outcome = determineOutcome(tally);
    expect(outcome.kind).toBe('tie');
    expect(outcome.kind === 'tie' ? [...outcome.games].sort() : null).toEqual(['dota2', 'tft']);
  });

  it('признаёт ничью между всеми вариантами, если голоса поровну у всех', () => {
    const tally: GameTally[] = [
      { game: 'dota2', voteCount: 4 },
      { game: 'lol', voteCount: 4 },
      { game: 'tft', voteCount: 4 },
      { game: 'valorant', voteCount: 4 },
    ];

    const outcome = determineOutcome(tally);
    expect(outcome.kind).toBe('tie');
    expect(outcome.kind === 'tie' ? [...outcome.games].sort() : null).toEqual(['dota2', 'lol', 'tft', 'valorant']);
  });

  it('признаёт нулевые голоса отдельным исходом, а не ничьей и не победой', () => {
    const tally: GameTally[] = [
      { game: 'dota2', voteCount: 0 },
      { game: 'lol', voteCount: 0 },
      { game: 'tft', voteCount: 0 },
      { game: 'valorant', voteCount: 0 },
    ];

    expect(determineOutcome(tally)).toEqual({ kind: 'no-votes', tally });
  });
});

describe('pluralizeVotes', () => {
  it('согласует «голос» с числом по правилам русского языка', () => {
    expect(pluralizeVotes(1)).toBe('голос');
    expect(pluralizeVotes(2)).toBe('голоса');
    expect(pluralizeVotes(3)).toBe('голоса');
    expect(pluralizeVotes(4)).toBe('голоса');
    expect(pluralizeVotes(5)).toBe('голосов');
    expect(pluralizeVotes(11)).toBe('голосов');
    expect(pluralizeVotes(12)).toBe('голосов');
    expect(pluralizeVotes(14)).toBe('голосов');
    expect(pluralizeVotes(21)).toBe('голос');
    expect(pluralizeVotes(0)).toBe('голосов');
  });
});

describe('renderOutcomeMessage', () => {
  function votesWord(text: string): string {
    const match = /(\d+) из \d+ (голос[а-я]*)/.exec(text);
    if (!match) throw new Error(`не нашёл упоминание голосов в тексте: ${text}`);
    return match[2] ?? '';
  }

  it('объявляет победителя с числом голосов из общего числа', () => {
    const tally: GameTally[] = [
      { game: 'dota2', voteCount: 2 },
      { game: 'lol', voteCount: 5 },
      { game: 'tft', voteCount: 1 },
      { game: 'valorant', voteCount: 9 },
    ];
    const text = renderOutcomeMessage(determineOutcome(tally));

    expect(text).toContain('Valorant');
    expect(text).toContain('9 из 17');
  });

  it('сообщает о ничьей и называет все дисциплины, входящие в неё, но не остальные', () => {
    const tally: GameTally[] = [
      { game: 'dota2', voteCount: 7 },
      { game: 'lol', voteCount: 3 },
      { game: 'tft', voteCount: 7 },
      { game: 'valorant', voteCount: 1 },
    ];
    const text = renderOutcomeMessage(determineOutcome(tally));

    expect(text).toContain('Dota 2');
    expect(text).toContain('Teamfight Tactics');
    expect(text).not.toContain('League of Legends');
    expect(text.toLowerCase()).toContain('ничь');
  });

  it('сообщает человеческим текстом, что никто не проголосовал', () => {
    const tally: GameTally[] = [
      { game: 'dota2', voteCount: 0 },
      { game: 'lol', voteCount: 0 },
      { game: 'tft', voteCount: 0 },
      { game: 'valorant', voteCount: 0 },
    ];
    const text = renderOutcomeMessage(determineOutcome(tally));

    expect(text.toLowerCase()).toContain('никто не проголосовал');
  });

  it('согласует слово «голос» с числом в самом тексте объявления', () => {
    const winnerWith = (voteCount: number) =>
      renderOutcomeMessage(
        determineOutcome([
          { game: 'dota2', voteCount },
          { game: 'lol', voteCount: 0 },
          { game: 'tft', voteCount: 0 },
          { game: 'valorant', voteCount: 0 },
        ]),
      );

    expect(votesWord(winnerWith(1))).toBe('голос');
    expect(votesWord(winnerWith(2))).toBe('голоса');
    expect(votesWord(winnerWith(5))).toBe('голосов');
    expect(votesWord(winnerWith(11))).toBe('голосов');
    expect(votesWord(winnerWith(21))).toBe('голос');
  });
});
