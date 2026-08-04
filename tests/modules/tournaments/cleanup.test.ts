import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { createLogger } from '../../../src/core/logger.js';
import { closeTournamentRooms } from '../../../src/modules/tournaments/commands/play.js';

/**
 * Уборка после турнира. Тестов у неё не было вовсе, и это ровно то, из-за чего она годами
 * оставляла за собой комнаты: она ходила по «активным участникам», а вышедший из турнира
 * свою комнату с собой не забирает.
 *
 * Проверяется не «вызвался ли Discord», а обещание: всё, что турнир создал, должно быть
 * убрано, а о том, что убрать не дали, надо сказать вслух.
 */

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);
const guild = {} as never;

function depsWith(options: {
  rooms?: string[];
  threads?: string[];
  messages?: { channelId: string; messageId: string }[];
  /** Каналы, которые Discord удалить не даёт: нет права, канал чужой, что угодно. */
  refuses?: string[];
}) {
  const refuses = new Set(options.refuses ?? []);
  const channels = {
    deleteChannel: vi.fn(async (_guild: unknown, id: string) => !refuses.has(id)),
    deleteThread: vi.fn(async (_guild: unknown, id: string) => !refuses.has(id)),
    archiveThread: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
  };
  const messages = {
    sweepable: vi.fn(async () => options.messages ?? []),
    forget: vi.fn(async () => {}),
  };
  const tournaments = {
    tournamentVoiceRooms: vi.fn(async () => options.rooms ?? []),
    closedThreads: vi.fn(async () => options.threads ?? []),
  };
  return { deps: { tournaments, channels, messages } as never, channels, messages, tournaments };
}

describe('уборка комнат турнира', () => {
  /**
   * Тот самый дефект. Комнаты берутся по турниру, а не по тем, кто в нём ещё числится:
   * снятие с турнира — обычное дело, и как раз оно чаще всего и приводит к отмене.
   */
  it('спрашивает комнаты турнира, а не комнаты играющих', async () => {
    const { deps, tournaments } = depsWith({ rooms: ['voice-1', 'voice-2'] });

    await closeTournamentRooms(deps, guild, 7, logger);

    expect(tournaments.tournamentVoiceRooms).toHaveBeenCalledWith(7);
  });

  it('удаляет каждую комнату и считает удалённые', async () => {
    const { deps, channels } = depsWith({ rooms: ['voice-1', 'voice-2', 'voice-3'] });

    const report = await closeTournamentRooms(deps, guild, 7, logger);

    expect(channels.deleteChannel).toHaveBeenCalledTimes(3);
    expect(report.rooms).toEqual({ found: 3, removed: 3 });
  });

  /**
   * Отказ Discord надо не проглотить, а посчитать: «комнат убрано 1 из 3» организатор
   * прочитает и пойдёт выдавать боту право. «Комнаты убраны» он прочитает и успокоится.
   */
  it('отказ в удалении видно в отчёте', async () => {
    const { deps } = depsWith({ rooms: ['voice-1', 'voice-2', 'voice-3'], refuses: ['voice-2', 'voice-3'] });

    const report = await closeTournamentRooms(deps, guild, 7, logger);

    expect(report.rooms).toEqual({ found: 3, removed: 1 });
  });

  /** Доигранный турнир: в ветках остались договорённости, и по ним спорят о результате. */
  it('после доигранного ветки архивируются, а не удаляются', async () => {
    const { deps, channels } = depsWith({ threads: ['thread-1', 'thread-2'] });

    await closeTournamentRooms(deps, guild, 7, logger, 'archive');

    expect(channels.archiveThread).toHaveBeenCalledTimes(2);
    expect(channels.deleteThread).not.toHaveBeenCalled();
  });

  /** Отменённый: результата нет, спорить не о чем, а архив продолжает висеть в списке. */
  it('после отменённого ветки удаляются', async () => {
    const { deps, channels } = depsWith({ threads: ['thread-1', 'thread-2'] });

    const report = await closeTournamentRooms(deps, guild, 7, logger, 'delete');

    expect(channels.deleteThread).toHaveBeenCalledTimes(2);
    expect(channels.archiveThread).not.toHaveBeenCalled();
    expect(report.threads).toEqual({ found: 2, removed: 2 });
  });

  it('архивирование по умолчанию: доигранный турнир — обычный случай', async () => {
    const { deps, channels } = depsWith({ threads: ['thread-1'] });

    await closeTournamentRooms(deps, guild, 7, logger);

    expect(channels.archiveThread).toHaveBeenCalledTimes(1);
  });

  it('сор убирается и забывается, чтобы не остаться в базе навсегда', async () => {
    const { deps, channels, messages } = depsWith({
      messages: [
        { channelId: 'chan-1', messageId: 'msg-1' },
        { channelId: 'chan-1', messageId: 'msg-2' },
      ],
    });

    const report = await closeTournamentRooms(deps, guild, 7, logger);

    expect(channels.deleteMessage).toHaveBeenCalledTimes(2);
    expect(messages.forget).toHaveBeenCalledTimes(2);
    expect(report.messages).toBe(2);
  });

  it('убирать нечего — отчёт пустой, а не выдуманный', async () => {
    const { deps } = depsWith({});

    const report = await closeTournamentRooms(deps, guild, 7, logger);

    expect(report).toEqual({ rooms: { found: 0, removed: 0 }, threads: { found: 0, removed: 0 }, messages: 0 });
  });
});
