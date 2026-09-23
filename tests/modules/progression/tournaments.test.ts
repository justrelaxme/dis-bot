import { describe, expect, it, vi } from 'vitest';
import {
  THREE_PEAT,
  onRankChanged,
  onTournamentFinished,
  onTournamentStarted,
} from '../../../src/modules/progression/tournaments.js';

/**
 * Награды за турниры и ранги. Четыре достижения и два источника опыта были объявлены, но не
 * выдавались никогда: условие было, а события, на котором его проверить, — нет.
 */

function progressionFake(wins = 1) {
  return {
    award: vi.fn(async () => ({ profile: {} as never, levelsGained: [] })),
    grantAchievement: vi.fn(async () => null),
    countEvents: vi.fn(async () => wins),
  };
}

const codes = (fake: ReturnType<typeof progressionFake>): string[] =>
  fake.grantAchievement.mock.calls.map((call) => (call as unknown as [string, string, string])[2]);

describe('турнир стартовал', () => {
  it('каждому участнику — опыт за участие и «Дебют»', async () => {
    const fake = progressionFake();

    await onTournamentStarted(fake, {
      guildId: 'g',
      tournamentId: 1,
      entrants: 2,
      participantUserIds: ['u1', 'u2'],
      captainUserIds: [],
    });

    expect(fake.award).toHaveBeenCalledTimes(2);
    expect(fake.award).toHaveBeenCalledWith('g', 'u1', expect.any(Number), 'tournament-play', { tournamentId: 1 });
    expect(codes(fake)).toEqual(['first-tournament', 'first-tournament']);
  });

  it('капитанам команд, собранных руками, — «Капитан»', async () => {
    const fake = progressionFake();

    await onTournamentStarted(fake, {
      guildId: 'g',
      tournamentId: 1,
      entrants: 1,
      participantUserIds: ['u1'],
      captainUserIds: ['u1'],
    });

    expect(codes(fake)).toContain('captain');
  });

  it('отказ награды одному не срывает остальных', async () => {
    const fake = progressionFake();
    fake.award.mockRejectedValueOnce(new Error('база моргнула'));

    await onTournamentStarted(fake, {
      guildId: 'g',
      tournamentId: 1,
      entrants: 2,
      participantUserIds: ['u1', 'u2'],
      captainUserIds: [],
    });

    expect(fake.award).toHaveBeenCalledTimes(2);
  });
});

describe('турнир закончился', () => {
  const finished = { guildId: 'g', tournamentId: 1, winnerEntrantId: 5, winnerUserIds: ['u1'] };

  it('победителю — опыт и «Чемпион»', async () => {
    const fake = progressionFake(1);

    await onTournamentFinished(fake, finished);

    expect(fake.award).toHaveBeenCalledWith('g', 'u1', expect.any(Number), 'tournament-win', { tournamentId: 1 });
    expect(codes(fake)).toEqual(['champion']);
  });

  it('третий титул — «Серия»', async () => {
    const fake = progressionFake(THREE_PEAT);

    await onTournamentFinished(fake, finished);

    expect(codes(fake)).toEqual(['champion', 'three-peat']);
  });

  it('второй титул — ещё не «Серия»', async () => {
    const fake = progressionFake(THREE_PEAT - 1);

    await onTournamentFinished(fake, finished);

    expect(codes(fake)).not.toContain('three-peat');
  });
});

describe('ранг изменился', () => {
  const change = {
    userId: 'u1',
    provider: 'steam',
    mode: 'dota-mmr',
    previous: { tier: 'Legend', division: '2' },
    current: { tier: 'Legend', division: '3' },
  };

  it('вырос — опыт и «Растёт» на каждом сервере человека', async () => {
    const fake = progressionFake();

    await onRankChanged(fake, ['g1', 'g2'], { ...change, climbed: true });

    expect(fake.award).toHaveBeenCalledTimes(2);
    expect(codes(fake)).toEqual(['rank-climber', 'rank-climber']);
  });

  it('упал или впервые записан — ничего', async () => {
    const fake = progressionFake();

    await onRankChanged(fake, ['g1'], { ...change, climbed: false });

    expect(fake.award).not.toHaveBeenCalled();
    expect(fake.grantAchievement).not.toHaveBeenCalled();
  });
});
