import pino from 'pino';
import type { Logger } from 'pino';
import type { Config } from './config.js';

export type { Logger };

export function createLogger(config: Config): Logger {
  return pino({
    level: config.LOG_LEVEL,
    redact: {
      paths: [
        'config.DISCORD_TOKEN',
        'config.STEAM_API_KEY',
        'config.RIOT_API_KEY',
        'headers.authorization',
        'headers["x-riot-token"]',
      ],
      censor: '[вырезано]',
    },
    ...(config.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
      : {}),
  });
}
