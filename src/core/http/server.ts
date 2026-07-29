import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { describeForUser } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';

export interface HealthChecks {
  database(): Promise<void>;
  cache(): Promise<void>;
}

export interface HttpServerDeps {
  config: Config;
  logger: Logger;
  metrics: Metrics;
  checks: HealthChecks;
}

const CHECK_TIMEOUT_MS = 1_000;

type CheckResult = 'ok' | 'error' | 'timeout';

/**
 * Гоняет одну проверку здоровья наперегонки с таймаутом. Без него зависший
 * Postgres превращает /healthz в зависший запрос, и оркестратор не может
 * отличить заклинивший контейнер от рабочего. Таймер чистится в finally —
 * иначе быстрая проверка всё равно оставляет висящий таймер, и vitest не
 * сможет корректно завершить процесс.
 */
async function runCheck(check: () => Promise<void>): Promise<CheckResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), CHECK_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([check().then((): CheckResult => 'ok'), timeout]);
    return result;
  } catch {
    return 'error';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fastify-сервер — зерно для будущих этапов: этап 1 навешивает на него
 * Steam OAuth-колбэк, этап 6 — веб-дашборд. Пока что только здоровье и метрики.
 */
export function createHttpServer(deps: HttpServerDeps): FastifyInstance {
  const server = Fastify({ logger: false });

  server.get('/healthz', async (_request, reply) => {
    const [database, cache] = await Promise.all([runCheck(deps.checks.database), runCheck(deps.checks.cache)]);
    const healthy = database === 'ok' && cache === 'ok';

    if (!healthy) {
      deps.logger.warn({ database, cache }, 'проверка здоровья не пройдена');
    }

    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'error',
      database,
      cache,
    });
  });

  server.get('/metrics', async (_request, reply) => {
    const body = await deps.metrics.render();
    return reply.header('content-type', deps.metrics.registry.contentType).send(body);
  });

  // Страховка на будущее: без явного обработчика Fastify отдаёт необработанный отказ
  // асинхронного роута как сырой JSON с текстом исключения (в т.ч. внутренние детали —
  // имена переменных окружения, сообщения провайдеров и т.п.). Роуты этого файла и
  // Steam-колбэк уже разбирают свои ошибки сами, но любой будущий роут (веб-дашборд
  // этапа 6) по умолчанию не должен утекать наружу текстом внутренней ошибки.
  server.setErrorHandler<FastifyError>((error, request, reply) => {
    const described = describeForUser(error);

    if (described.incidentId) {
      deps.logger.error({ err: error, incidentId: described.incidentId, url: request.url }, 'необработанная ошибка HTTP-роута');
    } else {
      deps.logger.warn({ err: error, url: request.url }, 'HTTP-роут отклонил запрос ожидаемой ошибкой');
    }

    const statusCode =
      typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;

    return reply.code(statusCode).send({ error: described.text });
  });

  return server;
}
