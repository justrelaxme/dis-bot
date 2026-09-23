import { eq } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import { tournamentSettings, type TournamentSettingsRow } from '../schema.js';

/**
 * Настройки турниров сервера: роль организаторов и канал штаба. Строка одна на сервер и
 * необязательна — без неё организатор это «Управление сервером», а звать бот будет владельца.
 */
export function createTournamentSettingsService(deps: { db: Database }) {
  const { db } = deps;

  return {
    async get(guildId: string): Promise<TournamentSettingsRow | null> {
      const [row] = await db.select().from(tournamentSettings).where(eq(tournamentSettings.guildId, guildId));
      return row ?? null;
    },

    /**
     * Правка по полям: `undefined` — не трогать, `null` — сбросить. Иначе поменять канал
     * штаба, не задев роль, было бы нельзя без того, чтобы указать роль заново.
     */
    async update(
      guildId: string,
      patch: { organizerRoleId?: string | null; staffChannelId?: string | null },
    ): Promise<TournamentSettingsRow> {
      const values = {
        ...(patch.organizerRoleId !== undefined ? { organizerRoleId: patch.organizerRoleId } : {}),
        ...(patch.staffChannelId !== undefined ? { staffChannelId: patch.staffChannelId } : {}),
      };
      const [row] = await db
        .insert(tournamentSettings)
        .values({ guildId, ...values })
        .onConflictDoUpdate({ target: tournamentSettings.guildId, set: { ...values, updatedAt: new Date() } })
        .returning();
      if (!row) throw new Error('настройки турниров не сохранились');
      return row;
    },
  };
}

export type TournamentSettingsService = ReturnType<typeof createTournamentSettingsService>;
