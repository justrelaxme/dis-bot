import { describe, expect, it } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { createHttpServer } from '../../../src/core/http/server.js';
import { createLogger } from '../../../src/core/logger.js';
import { createMetrics } from '../../../src/core/metrics.js';

const config = { LOG_LEVEL: 'fatal', NODE_ENV: 'test', HTTP_PORT: 3000 } as Config;

function serverWith(
  checks: { database: () => Promise<void>; cache: () => Promise<void> },
  metricsEnabled = true,
) {
  const withMetrics = { ...config, METRICS_ENABLED: metricsEnabled } as Config;
  return createHttpServer({
    config: withMetrics,
    logger: createLogger(withMetrics),
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

  it('отдаёт метрики в формате Prometheus, когда они включены', async () => {
    const server = serverWith({ database: ok, cache: ok });
    const response = await server.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('bot_command_duration_seconds');
    await server.close();
  });

  /**
   * Раньше метрики от внешнего мира закрывал только Caddy, и на платформе без него они
   * оказались бы публичными. Этот тест держит новое поведение: по умолчанию наружу
   * ничего, включается явно. Без него значение по умолчанию однажды тихо вернётся.
   */
  it('прячет метрики, когда они не включены явно', async () => {
    const server = serverWith({ database: ok, cache: ok }, false);
    const response = await server.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('bot_command_duration_seconds');
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

  describe('setErrorHandler — страховка от утечки внутренних деталей', () => {
    // Регрессия на Critical-находку финального ревью: без явного обработчика Fastify
    // отдаёт необработанный отказ асинхронного роута как сырой JSON вида
    // {"statusCode":500,"error":"Internal Server Error","message":"<текст исключения>"}.
    // Роуты этого файла и Steam-колбэк уже разбирают свои ошибки сами — здесь проверяется
    // именно страховка по умолчанию, на ещё не написанном (любом будущем) роуте.
    it('прячет текст необработанной ошибки произвольного роута', async () => {
      const server = serverWith({ database: ok, cache: ok });
      server.get('/boom', async () => {
        throw new Error('пароль от базы: hunter2');
      });

      const response = await server.inject({ method: 'GET', url: '/boom' });

      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('hunter2');
      expect(response.body).not.toContain('statusCode');
      expect(response.body).not.toContain('Internal Server Error');
      await server.close();
    });

    it('сохраняет валидный statusCode самой ошибки, но не её текст', async () => {
      const server = serverWith({ database: ok, cache: ok });
      server.get('/not-found-ish', async () => {
        throw Object.assign(new Error('внутренний путь /admin/secret-panel не существует'), { statusCode: 404 });
      });

      const response = await server.inject({ method: 'GET', url: '/not-found-ish' });

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('/admin/secret-panel');
      expect(response.body).not.toContain('Internal Server Error');
      await server.close();
    });
  });
});
