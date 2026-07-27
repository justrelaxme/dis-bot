import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/, 'ожидается Discord snowflake из 17–20 цифр');

const emptyToUndefined = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DISCORD_TOKEN: z.string().min(1, 'обязателен'),
  DISCORD_APP_ID: snowflake,
  DISCORD_GUILD_ID: snowflake,

  DATABASE_URL: z.string().min(1, 'обязателен'),
  REDIS_URL: z.string().min(1, 'обязателен'),

  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_BASE_URL: z.url('ожидается абсолютный URL'),

  STEAM_API_KEY: emptyToUndefined(z.string().min(1).optional()),
  RIOT_API_KEY: emptyToUndefined(z.string().min(1).optional()),
});

export type Config = z.infer<typeof envSchema>;

/**
 * Валидирует окружение целиком. Бросает при первой же проблеме, но перечисляет
 * в сообщении все найденные — чтобы не выяснять их по одной за пять перезапусков.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (parsed.success) return parsed.data;

  const details = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(корень)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Некорректная конфигурация окружения:\n${details}`);
}
