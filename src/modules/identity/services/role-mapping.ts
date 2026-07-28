import { and, eq } from 'drizzle-orm';
import type { GuildMember } from 'discord.js';
import type { Database } from '../../../core/db/client.js';
import { auditLog } from '../../../core/db/schema/core.js';
import type { Logger } from '../../../core/logger.js';
import type { RankInfo } from '../providers/provider.js';
import { roleMappings, type ProviderId } from '../schema.js';

const AUDIT_REASON = 'Авто-роль по игровому рангу';

export type RoleMappingRow = typeof roleMappings.$inferSelect;

export interface RoleChange {
  added: string[];
  removed: string[];
}

export interface RoleMappingService {
  setMapping(guildId: string, provider: ProviderId, mode: string, tier: string, roleId: string): Promise<void>;
  listMappings(guildId: string): Promise<RoleMappingRow[]>;
  removeMapping(guildId: string, provider: ProviderId, mode: string, tier: string): Promise<boolean>;
  resolveDesiredRoles(guildId: string, provider: ProviderId, ranks: RankInfo[]): Promise<string[]>;
  applyRoles(member: GuildMember, guildId: string, provider: ProviderId, ranks: RankInfo[]): Promise<RoleChange>;
}

/**
 * Роли-кандидаты по уже загруженному набору маппингов провайдера. Вынесено из
 * методов сервиса, чтобы applyRoles не делал по этому же провайдеру второй
 * (избыточный) поход в БД через resolveDesiredRoles — оба метода сходятся на
 * одном и том же списке mappings.
 *
 * Совпадение ищем по паре (mode, tier) — точно, без порога: маппинг администратора
 * привязан к конкретному тиру («Diamond — вот эта роль»), а не к «Diamond и выше».
 * Ранг без тира (нет данных от провайдера) кандидатом быть не может.
 */
function desiredRoleIdsFrom(mappings: RoleMappingRow[], ranks: RankInfo[]): string[] {
  const desired = new Set<string>();

  for (const rank of ranks) {
    if (!rank.tier) continue;
    const match = mappings.find((m) => m.mode === rank.mode && m.tier === rank.tier);
    if (match) desired.add(match.roleId);
  }

  return [...desired];
}

export function createRoleMappingService(deps: { db: Database; logger: Logger }): RoleMappingService {
  const { db, logger } = deps;

  async function mappingsFor(guildId: string, provider: ProviderId): Promise<RoleMappingRow[]> {
    return db
      .select()
      .from(roleMappings)
      .where(and(eq(roleMappings.guildId, guildId), eq(roleMappings.provider, provider)));
  }

  return {
    async setMapping(guildId, provider, mode, tier, roleId): Promise<void> {
      await db
        .insert(roleMappings)
        .values({ guildId, provider, mode, tier, roleId })
        .onConflictDoUpdate({
          target: [roleMappings.guildId, roleMappings.provider, roleMappings.mode, roleMappings.tier],
          set: { roleId },
        });
    },

    async listMappings(guildId): Promise<RoleMappingRow[]> {
      return db.select().from(roleMappings).where(eq(roleMappings.guildId, guildId));
    },

    async removeMapping(guildId, provider, mode, tier): Promise<boolean> {
      const deleted = await db
        .delete(roleMappings)
        .where(
          and(
            eq(roleMappings.guildId, guildId),
            eq(roleMappings.provider, provider),
            eq(roleMappings.mode, mode),
            eq(roleMappings.tier, tier),
          ),
        )
        .returning({ id: roleMappings.id });
      return deleted.length > 0;
    },

    async resolveDesiredRoles(guildId, provider, ranks): Promise<string[]> {
      const mappings = await mappingsFor(guildId, provider);
      return desiredRoleIdsFrom(mappings, ranks);
    },

    async applyRoles(member, guildId, provider, ranks): Promise<RoleChange> {
      const mappings = await mappingsFor(guildId, provider);
      // Кандидаты на снятие — только роли, которыми управляет маппинг этого
      // провайдера. Всё остальное (роли, выданные вручную администратором или
      // другим модулем) сервис не трогает — иначе бот срывал бы чужие роли.
      const managed = new Set(mappings.map((m) => m.roleId));
      const desired = new Set(desiredRoleIdsFrom(mappings, ranks));

      const added: string[] = [];
      const removed: string[] = [];

      for (const roleId of desired) {
        if (!member.roles.cache.has(roleId)) {
          await member.roles.add(roleId, AUDIT_REASON);
          added.push(roleId);
        }
      }

      for (const roleId of managed) {
        if (!desired.has(roleId) && member.roles.cache.has(roleId)) {
          await member.roles.remove(roleId, AUDIT_REASON);
          removed.push(roleId);
        }
      }

      if (added.length > 0 || removed.length > 0) {
        await db.insert(auditLog).values({
          guildId,
          actorId: null,
          action: 'identity.roles_synced',
          targetId: member.id,
          details: { provider, added, removed },
        });
        logger.info({ guildId, userId: member.id, provider, added, removed }, 'роли по рангу обновлены');
      }

      return { added, removed };
    },
  };
}
