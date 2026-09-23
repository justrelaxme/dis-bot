import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveHub, type LiveClient } from '../../../src/modules/web/live.js';

/**
 * Хаб живой витрины. Сообщение говорит только «изменилось» — страница перечитывает себя сама.
 * Поэтому здесь важны три вещи: сигналы одного турнира склеиваются, медленный клиент не
 * держит остальных, а остановка бота не ждёт вечных потоков.
 */

function client(accepts = true): LiveClient & { chunks: string[]; ended: boolean } {
  const chunks: string[] = [];
  return {
    chunks,
    ended: false,
    write(chunk: string) {
      chunks.push(chunk);
      return accepts;
    },
    end() {
      this.ended = true;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('живая витрина', () => {
  /**
   * Закрытие матча — цепочка: матч закрыт, победитель продвинулся, следующий стал
   * играбельным. Три сигнала подряд заставили бы страницу перечитаться трижды.
   */
  it('сигналы одного турнира за короткое окно уходят одним сообщением', async () => {
    const hub = createLiveHub({ debounceMs: 250 });
    const viewer = client();
    hub.add(7, viewer);

    hub.publish(7, { type: 'match.confirmed', matchId: 1 });
    hub.publish(7, { type: 'match.ready', matchId: 3 });
    await vi.advanceTimersByTimeAsync(300);

    expect(viewer.chunks).toHaveLength(1);
    const data = JSON.parse(viewer.chunks[0]!.split('data: ')[1]!) as { types: string[]; matchIds: number[] };
    expect(data.types).toEqual(['match.confirmed', 'match.ready']);
    expect(data.matchIds).toEqual([1, 3]);
    hub.closeAll();
  });

  it('чужой турнир не получает сигналов', async () => {
    const hub = createLiveHub({ debounceMs: 10 });
    const viewer = client();
    hub.add(8, viewer);

    hub.publish(7, { type: 'match.ready', matchId: 1 });
    await vi.advanceTimersByTimeAsync(50);

    expect(viewer.chunks).toEqual([]);
    hub.closeAll();
  });

  /** Клиент, который не успевает читать, отключается: браузер переподключится сам. */
  it('медленный клиент отключается и не держит остальных', async () => {
    const hub = createLiveHub({ debounceMs: 10 });
    const slow = client(false);
    const fast = client();
    hub.add(7, slow);
    hub.add(7, fast);

    hub.publish(7, { type: 'match.ready', matchId: 1 });
    await vi.advanceTimersByTimeAsync(50);

    expect(slow.ended).toBe(true);
    expect(fast.chunks).toHaveLength(1);
    expect(hub.size).toBe(1);
    hub.closeAll();
  });

  it('мест не больше предела', () => {
    const hub = createLiveHub({ max: 2 });

    expect(hub.add(1, client())).toBe(true);
    expect(hub.add(2, client())).toBe(true);
    expect(hub.full).toBe(true);
    expect(hub.add(3, client())).toBe(false);
    hub.closeAll();
  });

  it('ушедший клиент освобождает место', () => {
    const hub = createLiveHub({ max: 1 });
    const viewer = client();
    hub.add(1, viewer);

    hub.remove(1, viewer);

    expect(hub.size).toBe(0);
    expect(hub.add(1, client())).toBe(true);
    hub.closeAll();
  });

  /** Прокси рвут соединение, по которому давно тихо, — поэтому пустой комментарий раз в интервал. */
  it('держит соединение сердцебиением', async () => {
    const hub = createLiveHub({ heartbeatMs: 1_000 });
    const viewer = client();
    hub.add(7, viewer);

    await vi.advanceTimersByTimeAsync(2_100);

    expect(viewer.chunks.filter((chunk) => chunk === ':\n\n')).toHaveLength(2);
    hub.closeAll();
  });

  /** Живой поток не заканчивается сам — без этого остановка бота простояла бы до таймаута. */
  it('при остановке закрывает все потоки и не шлёт отложенного', async () => {
    const hub = createLiveHub({ debounceMs: 100 });
    const viewer = client();
    hub.add(7, viewer);
    hub.publish(7, { type: 'match.ready', matchId: 1 });

    hub.closeAll();
    await vi.advanceTimersByTimeAsync(500);

    expect(viewer.ended).toBe(true);
    expect(viewer.chunks).toEqual([]);
    expect(hub.size).toBe(0);
  });
});
