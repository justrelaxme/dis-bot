import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/core/events/bus.js';
import { createLogger } from '../../src/core/logger.js';
import type { Config } from '../../src/core/config.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

describe('EventBus', () => {
  it('доставляет событие всем подписчикам', async () => {
    const bus = new EventBus(logger);
    const first = vi.fn();
    const second = vi.fn();
    bus.on('core.ready', first);
    bus.on('core.ready', second);

    await bus.emit('core.ready', { at: new Date('2026-07-27T10:00:00Z') });

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('перестаёт доставлять после отписки', async () => {
    const bus = new EventBus(logger);
    const handler = vi.fn();
    const unsubscribe = bus.on('core.ready', handler);

    unsubscribe();
    await bus.emit('core.ready', { at: new Date() });

    expect(handler).not.toHaveBeenCalled();
  });

  it('не даёт упавшему обработчику сорвать остальные', async () => {
    const bus = new EventBus(logger);
    const broken = vi.fn(() => {
      throw new Error('обработчик сломан');
    });
    const healthy = vi.fn();
    bus.on('core.ready', broken);
    bus.on('core.ready', healthy);

    await expect(bus.emit('core.ready', { at: new Date() })).resolves.toBeUndefined();
    expect(healthy).toHaveBeenCalledOnce();
  });

  it('дожидается асинхронных обработчиков', async () => {
    const bus = new EventBus(logger);
    let finished = false;
    bus.on('core.ready', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      finished = true;
    });

    await bus.emit('core.ready', { at: new Date() });

    expect(finished).toBe(true);
  });

  it('молча игнорирует событие без подписчиков', async () => {
    const bus = new EventBus(logger);
    await expect(bus.emit('core.ready', { at: new Date() })).resolves.toBeUndefined();
  });
});
