import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../../src/core/config.js';
import { createLogger } from '../../../../src/core/logger.js';
import { createPollFinalizer, type PollGateway, type PollState } from '../../../../src/modules/tournaments/services/finalizer.js';
import type { PollsService, TournamentPollRow } from '../../../../src/modules/tournaments/services/polls.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

function pollRow(overrides: Partial<TournamentPollRow> = {}): TournamentPollRow {
  return {
    id: 1,
    guildId: '111111111111111111',
    channelId: '222222222222222222',
    messageId: '333333333333333333',
    options: ['dota2', 'lol', 'tft', 'valorant'],
    closesAt: new Date('2026-07-28T18:00:00.000Z'),
    winnerGame: null,
    finalizedAt: null,
    createdBy: '444444444444444444',
    createdAt: new Date('2026-07-28T12:00:00.000Z'),
    updatedAt: new Date('2026-07-28T12:00:00.000Z'),
    ...overrides,
  };
}

function fakePolls(fields: {
  findDue?: PollsService['findDue'];
  claimOutcome?: PollsService['claimOutcome'];
  revertClaim?: PollsService['revertClaim'];
} = {}) {
  return {
    createPoll: vi.fn<PollsService['createPoll']>(async () => {
      throw new Error('createPoll не ожидался в этих тестах');
    }),
    // byId нужен суточному циклу, а не финализатору: если он здесь дёрнется — значит
    // финализатор полез не туда, и падение об этом скажет прямо.
    byId: vi.fn<PollsService['byId']>(async () => {
      throw new Error('byId не ожидался в этих тестах');
    }),
    findDue: vi.fn<PollsService['findDue']>(fields.findDue ?? (async () => [])),
    claimOutcome: vi.fn<PollsService['claimOutcome']>(fields.claimOutcome ?? (async () => null)),
    revertClaim: vi.fn<PollsService['revertClaim']>(fields.revertClaim ?? (async () => {})),
  };
}

function fakeGateway(fields: {
  fetchPollState?: PollGateway['fetchPollState'];
  announce?: PollGateway['announce'];
} = {}) {
  return {
    fetchPollState: vi.fn<PollGateway['fetchPollState']>(fields.fetchPollState ?? (async () => null)),
    announce: vi.fn<PollGateway['announce']>(fields.announce ?? (async () => {})),
  };
}

const finalizedState = (voteCounts: readonly number[]): PollState => ({ finalized: true, voteCounts });

describe('createPollFinalizer', () => {
  it('оставляет голосование на потом, если Discord ещё не подвёл итоги (не нулевые голоса — «ещё не готово»)', async () => {
    const due = pollRow();
    const polls = fakePolls({ findDue: vi.fn<PollsService['findDue']>(async () => [due]) });
    const gateway = fakeGateway({
      fetchPollState: vi.fn<PollGateway['fetchPollState']>(async () => ({ finalized: false, voteCounts: [0, 0, 0, 0] })),
    });

    const summary = await createPollFinalizer({ polls, gateway, logger }).finalizeDue(10);

    expect(summary).toEqual({ finalized: 0, pending: 1, failed: 0 });
    expect(polls.claimOutcome).not.toHaveBeenCalled();
    expect(gateway.announce).not.toHaveBeenCalled();
  });

  it('оставляет голосование на потом, если сообщение недоступно в Discord', async () => {
    const due = pollRow();
    const polls = fakePolls({ findDue: vi.fn<PollsService['findDue']>(async () => [due]) });
    const gateway = fakeGateway({ fetchPollState: vi.fn<PollGateway['fetchPollState']>(async () => null) });

    const summary = await createPollFinalizer({ polls, gateway, logger }).finalizeDue(10);

    expect(summary).toEqual({ finalized: 0, pending: 1, failed: 0 });
    expect(polls.claimOutcome).not.toHaveBeenCalled();
  });

  it('застолбливает явного победителя и объявляет его в канале голосования', async () => {
    const due = pollRow();
    const claimed = { ...due, winnerGame: 'valorant' as const, finalizedAt: new Date() };
    const claimOutcome = vi.fn<PollsService['claimOutcome']>(async () => claimed);
    const polls = fakePolls({ findDue: vi.fn<PollsService['findDue']>(async () => [due]), claimOutcome });
    const gateway = fakeGateway({ fetchPollState: vi.fn<PollGateway['fetchPollState']>(async () => finalizedState([2, 5, 1, 9])) });

    const summary = await createPollFinalizer({ polls, gateway, logger }).finalizeDue(10);

    expect(summary).toEqual({ finalized: 1, pending: 0, failed: 0 });
    expect(claimOutcome).toHaveBeenCalledWith(due.id, 'valorant');
    expect(gateway.announce).toHaveBeenCalledTimes(1);
    const call = gateway.announce.mock.calls[0];
    expect(call?.[0]).toBe(due.channelId);
    expect(call?.[1]).toContain('Valorant');
  });

  it('при ничьей застолбливает победителя как null и объявляет обе дисциплины', async () => {
    const due = pollRow();
    const claimed = { ...due, winnerGame: null, finalizedAt: new Date() };
    const claimOutcome = vi.fn<PollsService['claimOutcome']>(async () => claimed);
    const polls = fakePolls({ findDue: vi.fn<PollsService['findDue']>(async () => [due]), claimOutcome });
    const gateway = fakeGateway({ fetchPollState: vi.fn<PollGateway['fetchPollState']>(async () => finalizedState([7, 3, 7, 1])) });

    await createPollFinalizer({ polls, gateway, logger }).finalizeDue(10);

    expect(claimOutcome).toHaveBeenCalledWith(due.id, null);
    const call = gateway.announce.mock.calls[0];
    expect(call?.[1]?.toLowerCase()).toContain('ничь');
  });

  it('при нулевых голосах застолбливает null и объявляет человеческим текстом, что никто не проголосовал', async () => {
    const due = pollRow();
    const claimed = { ...due, winnerGame: null, finalizedAt: new Date() };
    const claimOutcome = vi.fn<PollsService['claimOutcome']>(async () => claimed);
    const polls = fakePolls({ findDue: vi.fn<PollsService['findDue']>(async () => [due]), claimOutcome });
    const gateway = fakeGateway({ fetchPollState: vi.fn<PollGateway['fetchPollState']>(async () => finalizedState([0, 0, 0, 0])) });

    await createPollFinalizer({ polls, gateway, logger }).finalizeDue(10);

    expect(claimOutcome).toHaveBeenCalledWith(due.id, null);
    const call = gateway.announce.mock.calls[0];
    expect(call?.[1]?.toLowerCase()).toContain('никто не проголосовал');
  });

  it('НЕ объявляет второй раз, если claimOutcome вернул null — итог уже застолблён другим прогоном', async () => {
    // Это и есть защита от двойного объявления (мутационная проверка №1): если её
    // сломать на уровне polls-service (убрать CAS), этот тест не заметит проблему
    // сам по себе — но упадёт интеграционный тест polls-service.test.ts, который
    // проверяет само CAS-условие. Здесь проверяется другая половина контракта:
    // финализатор обязан молчать, если claimOutcome честно вернул null.
    const due = pollRow();
    const claimOutcome = vi.fn<PollsService['claimOutcome']>(async () => null);
    const polls = fakePolls({ findDue: vi.fn<PollsService['findDue']>(async () => [due]), claimOutcome });
    const gateway = fakeGateway({ fetchPollState: vi.fn<PollGateway['fetchPollState']>(async () => finalizedState([2, 5, 1, 9])) });

    const summary = await createPollFinalizer({ polls, gateway, logger }).finalizeDue(10);

    expect(gateway.announce).not.toHaveBeenCalled();
    expect(summary).toEqual({ finalized: 1, pending: 0, failed: 0 });
  });

  it('откатывает финализацию, если Discord отказал в отправке объявления, — итог не теряется навсегда', async () => {
    const due = pollRow();
    const claimed = { ...due, winnerGame: 'lol' as const, finalizedAt: new Date() };
    const claimOutcome = vi.fn<PollsService['claimOutcome']>(async () => claimed);
    const revertClaim = vi.fn<PollsService['revertClaim']>(async () => {});
    const polls = fakePolls({ findDue: vi.fn<PollsService['findDue']>(async () => [due]), claimOutcome, revertClaim });
    const announce = vi.fn<PollGateway['announce']>(async () => {
      throw new Error('Discord недоступен');
    });
    const gateway = fakeGateway({ fetchPollState: vi.fn<PollGateway['fetchPollState']>(async () => finalizedState([1, 9, 0, 0])), announce });

    const summary = await createPollFinalizer({ polls, gateway, logger }).finalizeDue(10);

    expect(summary).toEqual({ finalized: 0, pending: 0, failed: 1 });
    expect(claimOutcome).toHaveBeenCalledWith(due.id, 'lol');
    expect(revertClaim).toHaveBeenCalledWith(due.id);

    // Порядок обязателен: сперва claim, потом попытка отправки, и только потом (при
    // отказе) откат. Обратный порядок означал бы второе сообщение при гонке реплик.
    const claimOrder = claimOutcome.mock.invocationCallOrder[0] ?? -1;
    const announceOrder = announce.mock.invocationCallOrder[0] ?? -1;
    const revertOrder = revertClaim.mock.invocationCallOrder[0] ?? -1;
    expect(claimOrder).toBeLessThan(announceOrder);
    expect(announceOrder).toBeLessThan(revertOrder);
  });

  it('обрабатывает несколько голосований за прогон и не роняет остальные из-за одного зависшего', async () => {
    const dueOk = pollRow({ id: 1, channelId: 'chan-1' });
    const duePending = pollRow({ id: 2, channelId: 'chan-2' });
    const claimOutcome = vi.fn<PollsService['claimOutcome']>(async (id, winnerGame) => ({
      ...dueOk,
      id,
      winnerGame,
      finalizedAt: new Date(),
    }));
    const polls = fakePolls({ findDue: vi.fn<PollsService['findDue']>(async () => [dueOk, duePending]), claimOutcome });
    const gateway = fakeGateway({
      fetchPollState: vi.fn<PollGateway['fetchPollState']>(async (channelId) =>
        channelId === 'chan-1' ? finalizedState([5, 0, 0, 0]) : { finalized: false, voteCounts: [0, 0, 0, 0] },
      ),
    });

    const summary = await createPollFinalizer({ polls, gateway, logger }).finalizeDue(10);

    expect(summary).toEqual({ finalized: 1, pending: 1, failed: 0 });
  });

  it('падение при обработке одного голосования не мешает джобе завершиться и не роняет процесс', async () => {
    const due = pollRow();
    const polls = fakePolls({
      findDue: vi.fn<PollsService['findDue']>(async () => [due]),
    });
    const gateway = fakeGateway({
      fetchPollState: vi.fn<PollGateway['fetchPollState']>(async () => {
        throw new Error('неожиданный сбой');
      }),
    });

    const summary = await createPollFinalizer({ polls, gateway, logger }).finalizeDue(10);

    expect(summary).toEqual({ finalized: 0, pending: 0, failed: 1 });
  });
});
