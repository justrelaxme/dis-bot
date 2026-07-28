import { describe, expect, it } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { createHttpServer } from '../../../src/core/http/server.js';
import { createLogger } from '../../../src/core/logger.js';
import { createMetrics } from '../../../src/core/metrics.js';

const config = { LOG_LEVEL: 'fatal', NODE_ENV: 'test', HTTP_PORT: 3000 } as Config;

function serverWith(checks: { database: () => Promise<void>; cache: () => Promise<void> }) {
  return createHttpServer({
    config,
    logger: createLogger(config),
    metrics: createMetrics(),
    checks,
  });
}

const ok = async () => {};

describe('HTTP-сервер', () => {
  it('возвращает 200 на /healthz, когда зависимости живы', async () => {
    const server = serverWith({ database: ok, cache: ok });
    const response = await server.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', database: 'ok', cache: 'ok' });
    await server.close();
  });

  it('возвращает 503 и называет упавшую зависимость', async () => {
    const server = serverWith({
      database: async () => {
        throw new Error('соединение закрыто');
      },
      cache: ok,
    });
    const response = await server.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'error', database: 'error', cache: 'ok' });
    await server.close();
  });

  it('отдаёт метрики в формате Prometheus', async () => {
    const server = serverWith({ database: ok, cache: ok });
    const response = await server.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('bot_command_duration_seconds');
    await server.close();
  });

  it('не роняет процесс, если проверка здоровья зависла дольше секунды', async () => {
    const server = serverWith({
      database: () => new Promise((resolve) => setTimeout(resolve, 5_000)),
      cache: ok,
    });
    const response = await server.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ database: 'timeout' });
    await server.close();
  });
});
