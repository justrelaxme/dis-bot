import { describe, expect, it, vi } from 'vitest';
import { advanceTournamentRooms } from '../../../src/modules/tournaments/commands/play.js';

/**
 * Что получает матч, ставший играбельным.
 *
 * Тест написан по дефекту, найденному на живом турнире: во втором круге ссылки на драфт
 * капитанам не приходили. Причина оказалась не в рассылке — драфта для этих матчей просто не
 * существовало. Сетка меняется тремя разными путями (организатор присудил победу, соперник
 * подтвердил кнопкой, результат приняли по молчанию), каждый дописывали отдельно, и до драфта
 * дошёл только старт турнира.
 *
 * Поэтому проверяется здесь не «вызвался ли Discord», а обещание: у ставшего играбельным матча
 * появляется **и ветка, и драфт**. Забыть половину списка — это ровно та ошибка, которая уже
 * случилась.
 */

const guild = {} as never;

function depsWith(options: { needThread?: number[]; needDraft?: number[]; matchParentId?: string | null }) {
  const matches = (ids: number[]): unknown[] =>
    ids.map((id) => ({ id, entrantAId: 1, entrantBId: 2, tournamentId: 7 }));

  const channels = {
    createMatchThread: vi.fn(async () => 'thread-1'),
  };
  const drafts = {
    matchesNeedingDraft: vi.fn(async () => matches(options.needDraft ?? [])),
    // `created: false` — драфт уже есть: рассылка ссылок тогда пропускается, и Discord в этом
    // тесте не нужен вовсе. Проверяется сам факт, что драфты вообще пытались завести.
    ensureForMatch: vi.fn(async () => ({ draft: { id: 1 }, created: false })),
  };
  const tournaments = {
    byId: vi.fn(async () => ({
      id: 7,
      name: 'Кубок',
      matchParentId: options.matchParentId === undefined ? 'chan-1' : options.matchParentId,
    })),
    matchesNeedingThread: vi.fn(async () => matches(options.needThread ?? [])),
    bracket: vi.fn(async () => ({ entrants: [{ id: 1, displayName: 'А' }, { id: 2, displayName: 'Б' }] })),
    membersOf: vi.fn(async () => ['user-1']),
    attachThread: vi.fn(async () => {}),
  };

  return { deps: { tournaments, channels, drafts } as never, channels, drafts, tournaments };
}

describe('матч стал играбельным', () => {
  /** Тот самый дефект: ветка появлялась, а драфта не было — и ссылки слать было нечего. */
  it('заводит и ветку, и драфт', async () => {
    const { deps, channels, drafts } = depsWith({ needThread: [10], needDraft: [10] });

    await advanceTournamentRooms(deps, guild, 7);

    expect(channels.createMatchThread).toHaveBeenCalledTimes(1);
    expect(drafts.ensureForMatch).toHaveBeenCalledTimes(1);
  });

  /**
   * Ветка у матча уже есть, а драфта нет — так выглядит матч второго круга на турнире, где
   * ветки создавались, а драфты нет. Догонять надо именно драфт.
   */
  it('заводит драфт даже там, где ветка уже есть', async () => {
    const { deps, channels, drafts } = depsWith({ needThread: [], needDraft: [10, 11] });

    await advanceTournamentRooms(deps, guild, 7);

    expect(channels.createMatchThread).not.toHaveBeenCalled();
    expect(drafts.ensureForMatch).toHaveBeenCalledTimes(2);
  });

  it('без играбельных матчей не делает ничего', async () => {
    const { deps, channels, drafts } = depsWith({ needThread: [], needDraft: [] });

    await advanceTournamentRooms(deps, guild, 7);

    expect(channels.createMatchThread).not.toHaveBeenCalled();
    expect(drafts.ensureForMatch).not.toHaveBeenCalled();
  });

  /**
   * Канал для веток не настроен — веток не будет, но драфт от этого не зависит: он живёт на
   * витрине, а ссылки уходят в личку. Останавливаться на первом препятствии здесь нельзя.
   */
  it('без канала для веток драфт всё равно заводится', async () => {
    const { deps, channels, drafts } = depsWith({ needThread: [10], needDraft: [10], matchParentId: null });

    await advanceTournamentRooms(deps, guild, 7);

    expect(channels.createMatchThread).not.toHaveBeenCalled();
    expect(drafts.ensureForMatch).toHaveBeenCalledTimes(1);
  });
});
