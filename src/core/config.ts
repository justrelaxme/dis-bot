import { z } from 'zod';

// Сообщение задаётся параметром схемы `{ error }`, а не вторым аргументом .regex().
// Второй аргумент привязывается только к своей проверке и НЕ покрывает базовую проверку
// типа: при полностью отсутствующей переменной zod сначала выдаёт invalid_type по-английски,
// и русское сообщение недостижимо. Параметр схемы покрывает оба случая.
const snowflake = z
  .string({ error: 'ожидается Discord snowflake из 17–20 цифр' })
  .regex(/^\d{17,20}$/);

const emptyToUndefined = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production'], { error: 'допустимо: development, test, production' }).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'], { error: 'допустимо: trace, debug, info, warn, error, fatal' }).default('info'),

  DISCORD_TOKEN: z.string({ error: 'обязателен' }).min(1),
  DISCORD_APP_ID: snowflake,
  DISCORD_GUILD_ID: snowflake,

  DATABASE_URL: z.string({ error: 'обязателен' }).min(1),
  REDIS_URL: z.string({ error: 'обязателен' }).min(1),

  HTTP_PORT: z.coerce.number({ error: 'ожидается целое число порта от 1 до 65535' }).int().min(1).max(65535).default(3000),
  PUBLIC_BASE_URL: z.url('ожидается абсолютный URL'),

  STEAM_API_KEY: emptyToUndefined(z.string().min(1).optional()),
  RIOT_API_KEY: emptyToUndefined(z.string().min(1).optional()),
});

export type Config = z.infer<typeof envSchema>;

/**
 * Валидирует окружение целиком. Бросает одну ошибку, перечисляя в ней все найденные
 * проблемы, — чтобы не выяснять их по одной за пять перезапусков.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (parsed.success) return parsed.data;

  const details = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(корень)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Некорректная конфигурация окружения:\n${details}`);
}
