import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

export function createDatabase(config: Config, logger: Logger): { db: Database; close: () => Promise<void> } {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5_000,
  });

  // Без этого слушателя смерть простаивающего клиента (перезапуск Postgres,
  // pg_terminate_backend, разрыв от NAT) становится необработанным исключением и
  // убивает процесс в обход graceful shutdown.
  pool.on('error', (error) => {
    logger.error({ err: error }, 'ошибка простаивающего клиента Postgres');
  });

  return {
    db: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}
