import { z } from 'zod';

/**
 * У zod два независимых места, откуда берётся текст ошибки, и они не перекрывают
 * друг друга:
 *   - `{ error }` в конструкторе схемы покрывает только базовую проверку типа
 *     (значение отсутствует или не той природы);
 *   - второй аргумент `.min()` / `.regex()` покрывает только своё уточнение
 *     (значение есть и нужного типа, но не проходит проверку).
 * Указать сообщение лишь в одном месте — значит получить английский текст zod в
 * другом. Поэтому оно передаётся в оба и хранится константой, чтобы не разъехалось.
 */
const SNOWFLAKE_MSG = 'ожидается Discord snowflake из 17–20 цифр';
const REQUIRED_MSG = 'обязателен';
const PORT_MSG = 'ожидается целое число порта от 1 до 65535';
const DATABASE_URL_MSG = 'ожидается URL Postgres вида postgres://... или postgresql://...';
const REDIS_URL_MSG = 'ожидается URL Redis вида redis://... или rediss://...';

const snowflake = z.string({ error: SNOWFLAKE_MSG }).regex(/^\d{17,20}$/, SNOWFLAKE_MSG);

const requiredString = () => z.string({ error: REQUIRED_MSG }).min(1, REQUIRED_MSG);

const databaseUrl = z.string({ error: DATABASE_URL_MSG }).regex(/^postgres(ql)?:\/\/.+/, DATABASE_URL_MSG);

const redisUrl = z.string({ error: REDIS_URL_MSG }).regex(/^rediss?:\/\/.+/, REDIS_URL_MSG);

const emptyToUndefined = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'], { error: 'допустимо: development, test, production' })
    .default('development'),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'], {
      error: 'допустимо: trace, debug, info, warn, error, fatal',
    })
    .default('info'),

  DISCORD_TOKEN: requiredString(),
  DISCORD_APP_ID: snowflake,
  DISCORD_GUILD_ID: snowflake,

  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,

  HTTP_PORT: z.coerce
    .number({ error: PORT_MSG })
    .int(PORT_MSG)
    .min(1, PORT_MSG)
    .max(65535, PORT_MSG)
    .default(3000),
  PUBLIC_BASE_URL: z.url('ожидается абсолютный URL'),

  STEAM_API_KEY: emptyToUndefined(z.string().min(1).optional()),
  RIOT_API_KEY: emptyToUndefined(z.string().min(1).optional()),

  /**
   * Бэкап включён по умолчанию, и это осознанно: потеря Postgres — безвозвратная потеря
   * уровней, монет и всей турнирной летописи, а выключенный по умолчанию бэкап включают
   * ровно на следующий день после того, как он понадобился. Отказ бэкапа бота не роняет.
   */
  BACKUP_ENABLED: z
    .enum(['true', 'false'], { error: 'допустимо: true или false' })
    .default('true')
    .transform((value) => value === 'true'),
  BACKUP_DIR: z.string().min(1).default('./backups'),
  BACKUP_KEEP_DAYS: z.coerce
    .number({ error: 'ожидается число дней' })
    .int('ожидается целое число дней')
    .min(1, 'хранить меньше суток бессмысленно')
    .max(365, 'больше года — это уже архив, а не бэкап')
    .default(7),
  /** По умолчанию в 4 утра: время, когда на игровом сервере тише всего. */
  BACKUP_CRON: z.string().min(1).default('0 4 * * *'),
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
