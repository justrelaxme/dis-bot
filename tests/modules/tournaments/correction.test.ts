import { describe, expect, it } from 'vitest';
import { correctionBlocker, type CorrectionInput } from '../../../src/modules/tournaments/services/correction.js';

/**
 * Когда закрытый результат ещё можно исправить. Откатывать можно только то, что не сыграно:
 * следующие матчи этого исхода не начаты, не заявлены и не задрафтованы.
 */

const input = (over: Partial<CorrectionInput> = {}): CorrectionInput => ({
  tournamentState: 'running',
  match: { state: 'confirmed', winnerEntrantId: 1, entrantAId: 1, entrantBId: 2 },
  bye: false,
  newWinnerId: 2,
  targets: [
    {
      match: {
        id: 20,
        state: 'pending',
        entrantAId: 1,
        entrantBId: null,
        winnerEntrantId: null,
        reportedAt: null,
        liveAt: null,
        threadId: null,
      },
      side: 'a',
      delivered: 1,
      draftMoves: 0,
    },
  ],
  ...over,
});

describe('исправление результата', () => {
  it('следующий матч не начат — можно', () => {
    expect(correctionBlocker(input())).toBeNull();
  });

  it('турнир завершён — нельзя: награды уже выданы', () => {
    expect(correctionBlocker(input({ tournamentState: 'finished' }))).toMatch(/завершён/);
  });

  it('открытый матч исправлять не надо — его решают /match resolve', () => {
    expect(correctionBlocker(input({ match: { state: 'reported', winnerEntrantId: null, entrantAId: 1, entrantBId: 2 } }))).toMatch(
      /resolve/,
    );
  });

  it('проход без игры по пропуску — исправлять нечего', () => {
    expect(correctionBlocker(input({ bye: true }))).toMatch(/пропуску/);
  });

  it('победитель — только один из соперников', () => {
    expect(correctionBlocker(input({ newWinnerId: 99 }))).toMatch(/одним из соперников/);
  });

  it('тот же победитель — нечего исправлять', () => {
    expect(correctionBlocker(input({ newWinnerId: 1 }))).toMatch(/и так победитель/);
  });

  it('следующий матч заявлен — поздно', () => {
    const base = input();
    const target = { ...base.targets[0]!, match: { ...base.targets[0]!.match, state: 'reported' as const } };
    expect(correctionBlocker({ ...base, targets: [target] })).toMatch(/сыгран или заявлен/);
  });

  it('следующий матч начался — поздно', () => {
    const base = input();
    const target = { ...base.targets[0]!, match: { ...base.targets[0]!.match, state: 'ready' as const, liveAt: new Date() } };
    expect(correctionBlocker({ ...base, targets: [target] })).toMatch(/уже начался/);
  });

  it('в следующем матче идёт драфт — поздно', () => {
    const base = input();
    expect(correctionBlocker({ ...base, targets: [{ ...base.targets[0]!, draftMoves: 1 }] })).toMatch(/драфт/);
  });

  it('в слоте уже не тот, кого доставил матч — сетка поменялась', () => {
    const base = input();
    const target = { ...base.targets[0]!, match: { ...base.targets[0]!.match, entrantAId: 7 } };
    expect(correctionBlocker({ ...base, targets: [target] })).toMatch(/поменялась/);
  });
});
