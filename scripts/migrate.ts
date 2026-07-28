import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../src/core/config.js';
import { createDatabase } from '../src/core/db/client.js';
import { createLogger } from '../src/core/logger.js';

const config = loadConfig();
const logger = createLogger(config);
const { db, close } = createDatabase(config, logger);

try {
  await migrate(db, { migrationsFolder: 'src/core/db/migrations' });
  logger.info('миграции применены');
} catch (error) {
  logger.error({ err: error }, 'миграции не применились');
  process.exitCode = 1;
} finally {
  await close();
}
