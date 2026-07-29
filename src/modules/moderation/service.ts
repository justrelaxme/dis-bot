import { and, asc, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Cache } from '../../core/cache.js';
import type { Database } from '../../core/db/client.js';
import {
  guardSettings,
  infractions,
  tickets,
  type GuardSettingsRow,
  type InfractionKind,
  type InfractionRow,
  type InfractionSource,
  type TicketRow,
} from './schema.js';

export interface RecordInput {
  guildId: string;
  userId: string;
  moderatorId: string | null;
  kind: InfractionKind;
  reason: string;
  source?: InfractionSource;
  expiresAt?: Date;
  details?: Record<string, unknown>;
}

export function createModerationService(deps: { db: Database; cache: Cache }) {
  const { db, cache } = deps;

  return {
    async settings(guildId: string): Promise<GuardSettingsRow> {
      const [row] = await db.select().from(guardSettings).where(eq(guardSettings.guildId, guildId));
      if (row) return row;
      const [created] = await db.insert(guardSettings).values({ guildId }).onConflictDoNothing().returning();
      if (created) return created;
      const [again] = await db.select().from(guardSettings).where(eq(guardSettings.guildId, guildId));
      if (!again) throw new Error('настройки модерации не создались');
      return again;
    },

    async saveSettings(
      guildId: string,
      patch: Partial<Omit<GuardSettingsRow, 'guildId'>>,
    ): Promise<GuardSettingsRow> {
      const [row] = await db
        .insert(guardSettings)
        .values({ guildId, ...patch })
        .onConflictDoUpdate({ target: guardSettings.guildId, set: { ...patch, updatedAt: new Date() } })
        .returning();
      if (!row) throw new Error('настройки модерации не сохранились');
      return row;
    },

    /**
     * Пишет в журнал. Вызывается **до** действия в Discord: расхождение «в журнале есть, в
     * Discord нет» разбирается по логам, а обратное — нет, потому что Discord историю не
     * хранит и снятый мут не отличить от никогда не выданного.
     */
    async record(input: RecordInput): Promise<InfractionRow> {
      const [row] = await db
        .insert(infractions)
        .values({
          guildId: input.guildId,
          userId: input.userId,
          moderatorId: input.moderatorId,
          kind: input.kind,
          reason: input.reason,
          source: input.source ?? 'moderator',
          ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
          details: input.details ?? {},
        })
        .returning();
      if (!row) throw new Error('запись в журнал модерации не создалась');
      return row;
    },

    async history(guildId: string, userId: string, limit = 20): Promise<InfractionRow[]> {
      return db
        .select()
        .from(infractions)
        .where(and(eq(infractions.guildId, guildId), eq(infractions.userId, userId)))
        .orderBy(desc(infractions.createdAt))
        .limit(limit);
    },

    /** Сколько активных предупреждений — по ним срабатывает автоматический мут. */
    async activeWarns(guildId: string, userId: string): Promise<number> {
      const result = await db.execute<{ count: number }>(sql`
        select count(*)::int as count
        from moderation_infractions
        where guild_id = ${guildId} and user_id = ${userId}
          and kind = 'warn' and lifted_at is null
      `);
      return result.rows[0]?.count ?? 0;
    },

    /** Снятие наказания: запись остаётся, но помечается снятой. История не удаляется. */
    async lift(infractionId: number, byUserId: string): Promise<InfractionRow | null> {
      const [row] = await db
        .update(infractions)
        .set({ liftedAt: new Date(), liftedBy: byUserId })
        .where(and(eq(infractions.id, infractionId), isNull(infractions.liftedAt)))
        .returning();
      return row ?? null;
    },

    /** Активное наказание этого вида — чтобы не выдавать мут поверх мута. */
    async activeOfKind(guildId: string, userId: string, kind: InfractionKind): Promise<InfractionRow | null> {
      const [row] = await db
        .select()
        .from(infractions)
        .where(
          and(
            eq(infractions.guildId, guildId),
            eq(infractions.userId, userId),
            eq(infractions.kind, kind),
            isNull(infractions.liftedAt),
          ),
        )
        .orderBy(desc(infractions.createdAt));
      return row ?? null;
    },

    /** Наказания со истёкшим сроком, которые ещё не снял никто. */
    async expiredPunishments(now: Date, limit: number): Promise<InfractionRow[]> {
      return db
        .select()
        .from(infractions)
        .where(
          and(
            isNull(infractions.liftedAt),
            sql`${infractions.expiresAt} is not null`,
            lte(infractions.expiresAt, now),
          ),
        )
        .orderBy(asc(infractions.expiresAt))
        .limit(limit);
    },

    /**
     * Счётчик сообщений в окне — в Redis, а не в памяти: после перезапуска флудеру не должно
     * доставаться чистое окно. Ключ живёт ровно окно, поэтому чистить его не надо.
     */
    async bumpMessageRate(guildId: string, userId: string, windowSeconds: number): Promise<number> {
      return cache.incrementInWindow(`mod:rate:${guildId}:${userId}`, windowSeconds * 1_000);
    },

    /** Сколько раз подряд повторилось одно и то же сообщение. */
    async bumpDuplicate(guildId: string, userId: string, hash: string, windowSeconds: number): Promise<number> {
      return cache.incrementInWindow(`mod:dup:${guildId}:${userId}:${hash}`, windowSeconds * 1_000);
    },

    /** Сколько людей зашло на сервер за окно — по этому числу распознаётся рейд. */
    async bumpJoinRate(guildId: string, windowSeconds: number): Promise<number> {
      return cache.incrementInWindow(`mod:join:${guildId}`, windowSeconds * 1_000);
    },

    async openTicket(input: {
      guildId: string;
      userId: string;
      threadId: string;
      topic: string;
    }): Promise<TicketRow> {
      const [row] = await db.insert(tickets).values(input).returning();
      if (!row) throw new Error('тикет не создался');
      return row;
    },

    async openTicketOf(guildId: string, userId: string): Promise<TicketRow | null> {
      const [row] = await db
        .select()
        .from(tickets)
        .where(and(eq(tickets.guildId, guildId), eq(tickets.userId, userId), isNull(tickets.closedAt)));
      return row ?? null;
    },

    async closeTicket(ticketId: number, byUserId: string): Promise<void> {
      await db
        .update(tickets)
        .set({ closedAt: new Date(), closedBy: byUserId })
        .where(and(eq(tickets.id, ticketId), isNull(tickets.closedAt)));
    },

    async ticketByThread(threadId: string): Promise<TicketRow | null> {
      const [row] = await db.select().from(tickets).where(eq(tickets.threadId, threadId));
      return row ?? null;
    },
  };
}

export type ModerationService = ReturnType<typeof createModerationService>;
