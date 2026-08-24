import { randomBytes } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { Database } from '../../core/db/client.js';
import { webGrants, type WebGrantRow } from './schema.js';

/**
 * Выдача и проверка пропусков на витрину. Устройство и его цена описаны в `schema.ts`.
 */

/**
 * Сутки. Формат собирают за один присест, а ссылка, живущая месяц, к концу месяца лежит в
 * чужой переписке и всё ещё работает. Продлить нечего — новую выдаёт та же команда.
 */
const GRANT_TTL_MS = 24 * 60 * 60 * 1_000;

/** 32 байта: угадать нельзя, в адресную строку влезает. */
const TOKEN_BYTES = 32;

export function createGrantsService(deps: { db: Database }) {
  const { db } = deps;

  return {
    /**
     * Выдаёт пропуск, гася прежний того же человека на ту же область.
     *
     * Гашение — не уборка, а способ отозвать доступ: другого у выданной ссылки нет. Пока
     * пропусков могло быть много, переслать ссылку значило отдать доступ навсегда.
     */
    async issue(input: {
      guildId: string;
      userId: string;
      scope: 'formats';
    }): Promise<{ token: string; expiresAt: Date }> {
      await db
        .delete(webGrants)
        .where(
          and(
            eq(webGrants.guildId, input.guildId),
            eq(webGrants.userId, input.userId),
            eq(webGrants.scope, input.scope),
          ),
        );

      const token = randomBytes(TOKEN_BYTES).toString('base64url');
      const expiresAt = new Date(Date.now() + GRANT_TTL_MS);
      await db.insert(webGrants).values({ ...input, token, expiresAt });
      return { token, expiresAt };
    },

    /**
     * Кому принадлежит пропуск. `null` — токена нет, он не той области или просрочен.
     *
     * Просроченный отличать от несуществующего наружу не нужно: и то и то означает «эта
     * ссылка больше не действует, попроси новую», а разница между ними полезна только тому,
     * кто перебирает токены.
     */
    async owner(token: string | undefined, scope: 'formats'): Promise<WebGrantRow | null> {
      if (!token) return null;
      const [row] = await db.select().from(webGrants).where(eq(webGrants.token, token));
      if (!row || row.scope !== scope) return null;
      return row.expiresAt.getTime() > Date.now() ? row : null;
    },

    /** Убирает просроченные. Раз в сутки: таблица маленькая, но расти вечно ей незачем. */
    async sweepExpired(now: Date): Promise<number> {
      const rows = await db.delete(webGrants).where(lt(webGrants.expiresAt, now)).returning();
      return rows.length;
    },
  };
}

export type GrantsService = ReturnType<typeof createGrantsService>;
