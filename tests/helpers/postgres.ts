import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { createDatabase, type Database } from '../../src/core/db/client.js';
import { createLogger } from '../../src/core/logger.js';

const DEFAULT_TEST_DATABASE_URL = 'postgres://bot:bot@localhost:55432/disbot_test';

interface PostgresFixture {
  get db(): Database;
}

/**
 * Подключается к настоящему Postgres из тестовых сервисов и применяет миграции.
 * Мок здесь не годится: половина проверяемого поведения живёт в ограничениях схемы.
 *
 * Таблицы очищаются один раз на файл, а не перед каждым тестом: тесты внутри файла
 * намеренно опираются на данные, созданные в его же beforeAll. Прогон файлов
 * последовательный (`fileParallelism: false`), поэтому файлы друг другу не мешают.
 */
export function withPostgres(): PostgresFixture {
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const config = loadConfig({
      DISCORD_TOKEN: 'test',
      DISCORD_APP_ID: '123456789012345678',
      DISCORD_GUILD_ID: '876543210987654321',
      DATABASE_URL: process.env['DATABASE_URL_TEST'] ?? DEFAULT_TEST_DATABASE_URL,
      REDIS_URL: 'redis://localhost:56379',
      PUBLIC_BASE_URL: 'https://test.example.com',
      NODE_ENV: 'test',
    });

    const created = createDatabase(config, createLogger(config));
    db = created.db;
    close = created.close;

    try {
      await db.execute(sql`select 1`);
    } catch (error) {
      throw new Error(
        `Тестовый Postgres недоступен по ${config.DATABASE_URL}. ` +
          `Подними сервисы: npm run test:services:up. Исходная ошибка: ${(error as Error).message}`,
      );
    }

    await migrate(db, { migrationsFolder: 'src/core/db/migrations' });
    await truncateAll(db);
  });

  afterAll(async () => {
    await close?.();
  });

  return {
    get db() {
      return db;
    },
  };
}

/** Чистит все таблицы схемы, кроме журнала миграций drizzle. */
async function truncateAll(db: Database): Promise<void> {
  const result = await db.execute<{ tablename: string }>(sql`
    select tablename from pg_tables
    where schemaname = 'public' and tablename not like '__drizzle%'
  `);

  const tables = result.rows.map((row) => `"${row.tablename}"`);
  if (tables.length === 0) return;

  await db.execute(sql.raw(`truncate table ${tables.join(', ')} restart identity cascade`));
}
