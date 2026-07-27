import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Config } from '../config.js';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

export function createDatabase(config: Config): { db: Database; close: () => Promise<void> } {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5_000,
  });
  return {
    db: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}
