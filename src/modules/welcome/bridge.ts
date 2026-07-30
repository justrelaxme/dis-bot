import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import type { Database } from '../../core/db/client.js';
import { UNVERIFIABLE_PROVIDERS } from '../identity/providers/provider.js';
import { gameAccounts } from '../identity/schema.js';
import { tournamentEntrantMembers, tournaments, type TournamentRow } from '../tournaments/schema.js';

/**
 * Мост от встречи новичка к тому, что о нём уже известно. Такой же по устройству, как
 * мост турниров к рангам (services/strength.ts): один файл, где модуль читает чужие
 * таблицы, вместо того чтобы это делали пять разных мест.
 *
 * Читаем, но не пишем. Подсказка «что делать дальше» без этих данных была бы одинаковой
 * для всех — то есть общей инструкцией, которую новичок и так не читает. Смысл именно в
 * том, чтобы назвать один шаг, нужный этому человеку сейчас.
 */

export interface ServerStatus {
  /** Провайдеры, где привязка подтверждена. Неподтверждённая роли не даёт и здесь не считается. */
  verifiedProviders: string[];
  /** Турнир, который сейчас набирает или идёт. */
  tournament: TournamentRow | null;
  /** Человек уже в составе этого турнира. */
  inRoster: boolean;
}

export async function serverStatus(
  db: Database,
  guildId: string,
  userId: string,
): Promise<ServerStatus> {
  const [links, current] = await Promise.all([
    // Привязка засчитывается, если подтверждена **или** подтвердить её нечем в принципе
    // (Valorant). Иначе игрок Valorant получал бы «привяжи аккаунт» вечно, уже привязав.
    db
      .select({ provider: gameAccounts.provider })
      .from(gameAccounts)
      .where(
        and(
          eq(gameAccounts.userId, userId),
          or(
            isNotNull(gameAccounts.verifiedAt),
            inArray(gameAccounts.provider, [...UNVERIFIABLE_PROVIDERS]),
          ),
        ),
      ),
    db
      .select()
      .from(tournaments)
      .where(and(eq(tournaments.guildId, guildId), inArray(tournaments.state, ['registration', 'running']))),
  ]);

  const tournament = current[0] ?? null;
  if (!tournament) {
    return { verifiedProviders: links.map((row) => row.provider), tournament: null, inRoster: false };
  }

  const roster = await db
    .select({ userId: tournamentEntrantMembers.userId })
    .from(tournamentEntrantMembers)
    .where(
      and(
        eq(tournamentEntrantMembers.tournamentId, tournament.id),
        eq(tournamentEntrantMembers.userId, userId),
      ),
    );

  return {
    verifiedProviders: links.map((row) => row.provider),
    tournament,
    inRoster: roster.length > 0,
  };
}
