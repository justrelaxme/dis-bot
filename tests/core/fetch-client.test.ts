import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/core/config.js';
import { ProviderError } from '../../src/core/errors.js';
import { createFetchClient } from '../../src/core/http/fetch-client.js';
import { createLogger } from '../../src/core/logger.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function clientWith(fetchMock: typeof fetch, now = () => 0) {
  vi.stubGlobal('fetch', fetchMock);
  return createFetchClient({ provider: 'test', logger, now, sleep: async () => {} });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('createFetchClient', () => {
  it('возвращает разобранный JSON при успехе', async () => {
    const client = clientWith(vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch);
    await expect(client.json('https://api.test/x')).resolves.toEqual({ ok: true });
  });

  it('повторяет запрос при 500 и отдаёт результат удачной попытки', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = clientWith(fetchMock as unknown as typeof fetch);

    await expect(client.json('https://api.test/x')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('делает не более трёх попыток', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 503));
    const client = clientWith(fetchMock as unknown as typeof fetch);

    await expect(client.json('https://api.test/x')).rejects.toThrow(ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('НЕ повторяет запрос при 404 — это не временный сбой', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 404));
    const client = clientWith(fetchMock as unknown as typeof fetch);

    await expect(client.json('https://api.test/x')).rejects.toThrow(ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('соблюдает Retry-After при 429', async () => {
    const delays: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '2' } }))
        .mockResolvedValueOnce(jsonResponse({ ok: true })),
    );
    const client = createFetchClient({
      provider: 'test',
      logger,
      now: () => 0,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await client.json('https://api.test/x');
    expect(delays[0]).toBeGreaterThanOrEqual(2_000);
  });

  /**
   * Сервис вправе попросить час, но заснуть на час посреди нажатия кнопки нельзя: человек
   * останется без ответа, а джоба — висеть. Долгая просьба подождать — это отказ сейчас и
   * закрытая дорога до названного срока.
   */
  it('долгий Retry-After не усыпляет, а отказывает и держит предохранитель до срока', async () => {
    let clock = 0;
    const delays: number[] = [];
    const fetchMock = vi.fn(
      async () => new Response('', { status: 429, headers: { 'retry-after': '3600' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createFetchClient({
      provider: 'test',
      logger,
      now: () => clock,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await expect(client.json('https://api.test/x')).rejects.toThrow(/подождать 3600/);
    expect(delays).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Пока срок не вышел, наружу не звоним вовсе.
    clock += 60_000;
    await expect(client.json('https://api.test/x')).rejects.toThrow(/недоступен/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Предохранитель держит не дольше пятнадцати минут, даже если просили час.
    clock += 15 * 60_000;
    await client.json('https://api.test/x').catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('Retry-After в виде HTTP-даты тоже понимается', async () => {
    const delays: number[] = [];
    const soon = new Date(Date.now() + 3_000).toUTCString();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 503, headers: { 'retry-after': soon } }))
        .mockResolvedValueOnce(jsonResponse({ ok: true })),
    );
    const client = createFetchClient({
      provider: 'test',
      logger,
      now: () => 0,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await expect(client.json('https://api.test/x')).resolves.toEqual({ ok: true });
    expect(delays[0]).toBeGreaterThan(0);
    expect(delays[0]).toBeLessThanOrEqual(3_000);
  });

  /**
   * Заголовки приходят сразу, тело — как получится. Пока таймер снимался на заголовках,
   * медленное тело держало запрос без всякого предела.
   */
  it('тело ответа читается под тем же таймером, что и запрос', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const stream = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(new Error('прервано по таймеру')));
          },
        });
        return new Response(stream, { status: 200 });
      });
      const client = clientWith(fetchMock as unknown as typeof fetch);

      const outcome = client.json('https://api.test/x').then(
        () => 'resolved',
        (error: unknown) => (error instanceof ProviderError ? 'provider-error' : 'other'),
      );
      for (let i = 0; i < 3; i += 1) await vi.advanceTimersByTimeAsync(5_000);

      await expect(outcome).resolves.toBe('provider-error');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('открывает breaker после пяти подряд сбоев и перестаёт звонить наружу', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 500));
    const client = clientWith(fetchMock as unknown as typeof fetch);

    // Каждый вызов расходует три попытки; пяти сбоев подряд достаточно уже после второго.
    for (let i = 0; i < 3; i += 1) {
      await client.json('https://api.test/x').catch(() => {});
    }
    const callsBefore = fetchMock.mock.calls.length;

    await expect(client.json('https://api.test/x')).rejects.toThrow(/недоступен/);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('закрывает breaker через 60 секунд', async () => {
    let clock = 0;
    const fetchMock = vi.fn(async () => jsonResponse({}, 500));
    vi.stubGlobal('fetch', fetchMock);
    const client = createFetchClient({ provider: 'test', logger, now: () => clock, sleep: async () => {} });

    for (let i = 0; i < 3; i += 1) {
      await client.json('https://api.test/x').catch(() => {});
    }
    const callsBefore = fetchMock.mock.calls.length;

    clock += 61_000;
    await client.json('https://api.test/x').catch(() => {});

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('валидирует ответ переданной схемой', async () => {
    const client = clientWith(vi.fn(async () => jsonResponse({ wrong: 1 })) as unknown as typeof fetch);
    const schema = {
      parse: (input: unknown) => {
        if (typeof (input as { expected?: unknown }).expected !== 'string') throw new Error('не та форма');
        return input as { expected: string };
      },
    };

    await expect(client.json('https://api.test/x', { schema })).rejects.toThrow(ProviderError);
  });

  it('бросает ProviderError при успешном ответе с битым телом', async () => {
    const fetchMock = vi.fn(
      async () => new Response('не json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const client = clientWith(fetchMock as unknown as typeof fetch);

    await expect(client.json('https://api.test/x')).rejects.toThrow(ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('открывает breaker на потоке ответов, которые отвергает схема', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ wrong: 1 }));
    const client = clientWith(fetchMock as unknown as typeof fetch);
    const schema = {
      parse: (): never => {
        throw new Error('не та форма');
      },
    };

    for (let i = 0; i < 5; i += 1) {
      await client.json('https://api.test/x', { schema }).catch(() => {});
    }
    const callsBefore = fetchMock.mock.calls.length;

    await expect(client.json('https://api.test/x', { schema })).rejects.toThrow(/недоступен/);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });
});
