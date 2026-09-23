import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Синхронизатор турнира. Появился из дефекта: матч, закрытый проверкой по данным Dota, не
 * двигал сетку, а финал, закрытый так, не убирал комнаты и не объявлял итог. Путей закрыть
 * матч пять, и каждый решал сам, что делать дальше. Теперь все зовут одно место — и проверять
 * надо именно его обещания: идущему турниру — ветки и драфты, доигранному — одно закрытие.
 */

const play = vi.hoisted(() => ({
  createTournamentRooms: vi.fn(async () => {}),
  closeTournamentRooms: vi.fn(async () => ({ rooms: { found: 0, removed: 0 }, threads: { found: 0, removed: 0 }, messages: 0 })),
}));
const closing = vi.hoisted(() => ({
  prepareClosing: vi.fn(async () => ({ message: 'итог', champion: 'Альфа' })),
  publishClosing: vi.fn(async () => {}),
}));

vi.mock('../../../src/modules/tournaments/commands/play.js', () => play);
vi.mock('../../../src/modules/tournaments/discord/closing.js', () => closing);

const { syncTournament } = await import('../../../src/modules/tournaments/discord/sync.js');

const guild = {} as never;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

function depsFor(state: string, claim: unknown = { id: 7, state: 'finished' }) {
  const tournaments = {
    byId: vi.fn(async () => ({ id: 7, state })),
    claimCloseOut: vi.fn(async () => claim),
  };
  return { deps: { tournaments } as never, tournaments };
}

beforeEach(() => {
  play.createTournamentRooms.mockReset().mockResolvedValue(undefined);
  play.closeTournamentRooms.mockReset().mockResolvedValue(undefined as never);
  closing.prepareClosing.mockReset().mockResolvedValue({ message: 'итог', champion: 'Альфа' });
  closing.publishClosing.mockClear();
});

describe('синхронизатор турнира', () => {
  it('идущему турниру догоняет ветки и драфты', async () => {
    const { deps } = depsFor('running');

    await expect(syncTournament(deps, guild, 7, logger)).resolves.toBe('advanced');

    expect(play.createTournamentRooms).toHaveBeenCalledTimes(1);
    expect(play.closeTournamentRooms).not.toHaveBeenCalled();
  });

  /** Финал, закрытый любым путём, убирает комнаты и объявляет итог в канал объявлений. */
  it('доигранный турнир закрывает: комнаты и итог', async () => {
    const { deps, tournaments } = depsFor('finished');

    await expect(syncTournament(deps, guild, 7, logger)).resolves.toBe('closed');

    expect(tournaments.claimCloseOut).toHaveBeenCalledWith(7);
    expect(play.closeTournamentRooms).toHaveBeenCalledTimes(1);
    expect(closing.publishClosing).toHaveBeenCalledTimes(1);
  });

  /**
   * Сбой до отметки — отметка не занята, и через минуту джоба повторит. Раньше отметка
   * занималась первой, и упавшая уборка не повторялась никогда: комнаты оставались, итога не
   * было, афиша висела.
   */
  it('упавшая уборка или сборка итога не занимает отметку — следующий прогон повторит', async () => {
    const { deps, tournaments } = depsFor('finished');
    closing.prepareClosing.mockRejectedValueOnce(new Error('база моргнула'));

    await expect(syncTournament(deps, guild, 7, logger)).rejects.toThrow('база моргнула');
    expect(tournaments.claimCloseOut).not.toHaveBeenCalled();

    await expect(syncTournament(deps, guild, 7, logger)).resolves.toBe('closed');
    expect(closing.publishClosing).toHaveBeenCalledTimes(1);
  });

  /** Второй «итог» в канале уже не отменить — закрывает только тот, кто занял отметку. */
  it('уже закрытый турнир второй раз не закрывает', async () => {
    const { deps } = depsFor('finished', null);

    await expect(syncTournament(deps, guild, 7, logger)).resolves.toBe('idle');

    expect(closing.publishClosing).not.toHaveBeenCalled();
  });

  it('регистрацию и отменённый турнир не трогает', async () => {
    for (const state of ['registration', 'cancelled']) {
      const { deps, tournaments } = depsFor(state);
      await expect(syncTournament(deps, guild, 7, logger)).resolves.toBe('idle');
      expect(tournaments.claimCloseOut).not.toHaveBeenCalled();
    }
    expect(play.createTournamentRooms).not.toHaveBeenCalled();
  });

  /**
   * Кнопка и джоба приходят к одному турниру одновременно. Если бы прогоны шли вместе, оба
   * увидели бы матч без ветки и завели бы две.
   */
  it('прогоны одного турнира идут по одному, а не вместе', async () => {
    let inside = 0;
    let most = 0;
    play.createTournamentRooms.mockImplementation(async () => {
      inside += 1;
      most = Math.max(most, inside);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inside -= 1;
    });
    const { deps } = depsFor('running');

    await Promise.all([1, 2, 3].map(() => syncTournament(deps, guild, 7, logger)));

    expect(play.createTournamentRooms).toHaveBeenCalledTimes(3);
    expect(most).toBe(1);
  });

  it('упавший прогон не останавливает следующий', async () => {
    play.createTournamentRooms.mockRejectedValueOnce(new Error('Discord отказал'));
    const { deps } = depsFor('running');

    const first = syncTournament(deps, guild, 7, logger);
    const second = syncTournament(deps, guild, 7, logger);

    await expect(first).rejects.toThrow('Discord отказал');
    await expect(second).resolves.toBe('advanced');
  });
});
