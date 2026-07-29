/**
 * Поднимает витрину на порту с наполненной демонстрацией: турнир на восемь команд с
 * наполовину сыгранной сеткой и лидерборд по Dota. Нужен, чтобы посмотреть сайт глазами
 * до запуска бота — токен Discord для этого не требуется.
 *
 * Запуск: npx tsx scripts/web-demo.ts
 */
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { createCache } from '../src/core/cache.js';
import type { Config } from '../src/core/config.js';
import { createDatabase } from '../src/core/db/client.js';
import { guilds, users } from '../src/core/db/schema/core.js';
import { createLogger } from '../src/core/logger.js';
import { gameAccounts, rankSnapshots } from '../src/modules/identity/schema.js';
import { tournamentEntrants, tournamentMatches, tournaments } from '../src/modules/tournaments/schema.js';
import { registerWebRoutes } from '../src/modules/web/routes.js';

const PORT = Number.parseInt(process.env['PORT'] ?? '3000', 10);
const GUILD = '900000000000000001';

const config = {
  DATABASE_URL: process.env['DATABASE_URL'] ?? 'postgres://bot:bot@localhost:55432/disbot_test',
  REDIS_URL: process.env['REDIS_URL'] ?? 'redis://localhost:56379',
  LOG_LEVEL: 'info',
  NODE_ENV: 'development',
} as unknown as Config;

const TEAMS = ['Медведи', 'Соколы', 'Волки', 'Лисы', 'Барсуки', 'Кабаны', 'Рыси', 'Зубры'];

/** Медаль и звезда Dota кодируются как medal*10 + star; Immortal — 80. */
const LADDER: { nick: string; rankTier: number; leaderboard: number | null }[] = [
  { nick: 'Papich', rankTier: 80, leaderboard: 12 },
  { nick: 'Solo', rankTier: 80, leaderboard: 47 },
  { nick: 'NoTail', rankTier: 75, leaderboard: null },
  { nick: 'Dendi', rankTier: 73, leaderboard: null },
  { nick: 'Ceb', rankTier: 64, leaderboard: null },
  { nick: 'Puppey', rankTier: 52, leaderboard: null },
  { nick: 'Кто-то', rankTier: 41, leaderboard: null },
];

const DOTA_MEDALS = ['HERALD', 'GUARDIAN', 'CRUSADER', 'ARCHON', 'LEGEND', 'ANCIENT', 'DIVINE', 'IMMORTAL'];

async function seed(db: Awaited<ReturnType<typeof createDatabase>>['db']): Promise<number> {
  await db.insert(guilds).values({ id: GUILD }).onConflictDoNothing();

  // Турнир на восемь команд: первый круг сыгран, в полуфиналах один результат заявлен.
  const [tournament] = await db
    .insert(tournaments)
    .values({
      guildId: GUILD,
      name: 'Ежедневный турнир по Dota 2',
      game: 'dota2',
      entryMode: 'team',
      teamSize: 5,
      maxEntrants: 16,
      state: 'running',
      createdBy: GUILD,
      startedAt: new Date(),
    })
    .returning();
  if (!tournament) throw new Error('турнир не создался');

  const ids: number[] = [];
  for (const [index, name] of TEAMS.entries()) {
    const [entrant] = await db
      .insert(tournamentEntrants)
      .values({
        tournamentId: tournament.id,
        displayName: name,
        captainUserId: `9100000000000000${String(index).padStart(2, '0')}`,
        seed: index + 1,
        seedScore: 8000 - index * 420,
        checkedInAt: new Date(),
      })
      .returning();
    if (entrant) ids.push(entrant.id);
  }

  const at = (index: number): number => {
    const value = ids[index];
    if (value === undefined) throw new Error('участник не создался');
    return value;
  };

  // Расстановка сеяных для восьмёрки: [1,8,4,5,2,7,3,6] — пары ниже идут по ней.
  await db.insert(tournamentMatches).values([
    { tournamentId: tournament.id, round: 1, slot: 0, entrantAId: at(0), entrantBId: at(7), state: 'confirmed', winnerEntrantId: at(0), confirmedAt: new Date() },
    { tournamentId: tournament.id, round: 1, slot: 1, entrantAId: at(3), entrantBId: at(4), state: 'confirmed', winnerEntrantId: at(3), confirmedAt: new Date() },
    { tournamentId: tournament.id, round: 1, slot: 2, entrantAId: at(1), entrantBId: at(6), state: 'confirmed', winnerEntrantId: at(1), confirmedAt: new Date() },
    { tournamentId: tournament.id, round: 1, slot: 3, entrantAId: at(2), entrantBId: at(5), state: 'walkover', winnerEntrantId: at(2), confirmedAt: new Date() },
    { tournamentId: tournament.id, round: 2, slot: 0, entrantAId: at(0), entrantBId: at(3), state: 'reported', reportedBy: '910000000000000000', reportedWinnerId: at(0), reportedAt: new Date() },
    { tournamentId: tournament.id, round: 2, slot: 1, entrantAId: at(1), entrantBId: at(2), state: 'ready' },
    { tournamentId: tournament.id, round: 3, slot: 0, state: 'pending' },
  ]);

  // Лидерборд: подтверждённые привязки Steam с рангами Dota.
  for (const [index, player] of LADDER.entries()) {
    const userId = `9200000000000000${String(index).padStart(2, '0')}`;
    await db.insert(users).values({ id: userId }).onConflictDoNothing();
    const [account] = await db
      .insert(gameAccounts)
      .values({
        userId,
        provider: 'steam',
        externalId: `7656119800000${String(index).padStart(4, '0')}`,
        displayName: player.nick,
        verifiedAt: new Date(),
        verificationMethod: 'steam-openid',
      })
      .onConflictDoNothing()
      .returning();
    if (!account) continue;

    const medalIndex = Math.floor(player.rankTier / 10) - 1;
    const star = player.rankTier % 10;
    const isImmortal = medalIndex === DOTA_MEDALS.indexOf('IMMORTAL');
    await db.insert(rankSnapshots).values({
      accountId: account.id,
      mode: 'dota-mmr',
      scale: 'dota-mmr',
      tier: DOTA_MEDALS[medalIndex] ?? null,
      division: isImmortal ? null : String(star),
      points: isImmortal ? player.leaderboard : null,
      source: 'api',
      raw: { rank_tier: player.rankTier, leaderboard_rank: player.leaderboard },
    });
  }

  return tournament.id;
}

async function main(): Promise<void> {
  const logger = createLogger(config);
  const { db, close } = createDatabase(config, logger);
  const cache = createCache(config, logger);
  const server = Fastify({ logger: false });

  registerWebRoutes(server, { db, cache, logger });

  const tournamentId = await seed(db);
  await server.listen({ port: PORT, host: '0.0.0.0' });

  logger.info(
    {
      главная: `http://localhost:${PORT}/`,
      сетка: `http://localhost:${PORT}/t/${tournamentId}`,
      лидерборд: `http://localhost:${PORT}/leaderboard/dota2`,
    },
    'витрина поднята, Ctrl+C останавливает и убирает демонстрационные данные',
  );

  const stop = async (): Promise<void> => {
    await db.delete(tournaments).where(eq(tournaments.id, tournamentId));
    await server.close();
    await cache.close();
    await close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((error: unknown) => {
  createLogger(config).error({ err: error }, 'витрина не поднялась');
  process.exit(1);
});
