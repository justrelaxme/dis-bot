import pino from 'pino';
import type { DestinationStream, Logger } from 'pino';
import type { Config } from './config.js';

export type { Logger };

/**
 * `destination` существует ради тестируемости: редакция секретов — защита от
 * утечки токена в логи, и её надо проверять автотестом, а не глазами. По
 * умолчанию pino пишет в stdout, как и положено.
 */
export function createLogger(config: Config, destination?: DestinationStream): Logger {
  const options = {
    level: config.LOG_LEVEL,
    redact: {
      paths: [
        'config.DISCORD_TOKEN',
        'config.STEAM_API_KEY',
        'config.RIOT_API_KEY',
        'config.DATABASE_URL',
        'config.REDIS_URL',
        'headers.authorization',
        'headers["x-riot-token"]',
        // pg-pool перед emit('error', ...) вешает err.client = client: сериализатор pino
        // копирует все перечислимые ключи клиента (connectionParameters, OID типов,
        // внутренности сокета, "user" с хостом/портом/БД) — без пароля (pg делает его
        // неперечислимым), но всё равно раздувает и захламляет лог на нестабильном соединении.
        'err.client',
      ],
      censor: '[вырезано]',
    },
    // pino-pretty подключается только в разработке: в проде нужен машинночитаемый JSON.
    // При заданном destination транспорт не ставится — иначе вывод ушёл бы мимо потока.
    ...(config.NODE_ENV === 'development' && !destination
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
      : {}),
  };

  return destination ? pino(options, destination) : pino(options);
}
