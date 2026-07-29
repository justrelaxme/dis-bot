/**
 * Разовая проверка: витрина реально отдаёт страницы. Поднимает Fastify с веб-маршрутами
 * и дёргает их через inject — без порта, без токена Discord, без запуска бота.
 */
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { createCache } from '../src/core/cache.js';
import type { Config } from '../src/core/config.js';
import { createDatabase } from '../src/core/db/client.js';
import { createLogger } from '../src/core/logger.js';
import { tournamentEntrants, tournamentMatches, tournaments } from '../src/modules/tournaments/schema.js';
import { registerWebRoutes } from '../src/modules/web/routes.js';

const config = {
  DATABASE_URL: process.env['DATABASE_URL'] ?? 'postgres://bot:bot@localhost:55432/disbot_test',
  REDIS_URL: process.env['REDIS_URL'] ?? 'redis://localhost:56379',
  LOG_LEVEL: 'fatal',
  NODE_ENV: 'test',
} as unknown as Config;

async function main(): Promise<void> {
  const logger = createLogger(config);
  const { db, close } = createDatabase(config, logger);
  const cache = createCache(config, logger);
  const server = Fastify({ logger: false });

  registerWebRoutes(server, { db, cache, logger });

  const [tournament] = await db
    .insert(tournaments)
    .values({
      guildId: '1',
      name: 'Проверочный турнир',
      game: 'dota2',
      entryMode: 'team',
      teamSize: 5,
      state: 'running',
      createdBy: '1',
    })
    .returning();
  if (!tournament) throw new Error('турнир не создался');

  const entrantIds: number[] = [];
  for (const [index, name] of ['Медведи', 'Соколы', 'Волки', 'Лисы'].entries()) {
    const [entrant] = await db
      .insert(tournamentEntrants)
      .values({
        tournamentId: tournament.id,
        displayName: name,
        captainUserId: String(100 + index),
        seed: index + 1,
        checkedInAt: new Date(),
      })
      .returning();
    if (entrant) entrantIds.push(entrant.id);
  }

  const [a, b, c, d] = entrantIds;
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    throw new Error('участники не создались');
  }

  await db.insert(tournamentMatches).values([
    { tournamentId: tournament.id, round: 1, slot: 0, entrantAId: a, entrantBId: d, state: 'confirmed', winnerEntrantId: a },
    { tournamentId: tournament.id, round: 1, slot: 1, entrantAId: b, entrantBId: c, state: 'reported' },
    { tournamentId: tournament.id, round: 2, slot: 0, entrantAId: a, state: 'pending' },
  ]);

  for (const url of ['/', `/t/${tournament.id}`, '/leaderboard/dota2', '/leaderboard/nope', '/p/123']) {
    const response = await server.inject({ method: 'GET', url });
    const text = response.body
      .replace(/<style>[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    console.log(`\n=== ${url} -> ${response.statusCode} (${response.body.length} bytes) ===`);
    console.log(text.slice(0, 400));
  }

  await db.delete(tournaments).where(eq(tournaments.id, tournament.id));
  await server.close();
  await cache.close();
  await close();
}

main().catch((error: unknown) => {
  console.error('СМОУК УПАЛ:', error);
  process.exit(1);
});
