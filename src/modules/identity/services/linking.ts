import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { UserError } from '../../../core/errors.js';
import type { Database } from '../../../core/db/client.js';
import { users } from '../../../core/db/schema/core.js';
import type { RankInfo, VerificationChallenge, VerifiedAccount } from '../providers/provider.js';
import { accountVerifications, gameAccounts, rankSnapshots, type ProviderId } from '../schema.js';

/** Испытание верификации живёт 15 минут и допускает не больше 5 попыток (спека этапа). */
const MAX_ATTEMPTS = 5;

export type GameAccountRow = typeof gameAccounts.$inferSelect;

export interface TakenChallenge {
  userId: string;
  provider: ProviderId;
  payload: Record<string, unknown>;
}

export interface LinkingService {
  ensureUser(userId: string): Promise<void>;
  openChallenge(userId: string, provider: ProviderId, challenge: VerificationChallenge): Promise<void>;
  takeChallenge(challenge: string): Promise<TakenChallenge>;
  pendingChallenge(
    userId: string,
    provider: ProviderId,
  ): Promise<{ challenge: string; payload: Record<string, unknown> } | null>;
  linkAccount(userId: string, provider: ProviderId, account: VerifiedAccount, verified: boolean): Promise<number>;
  unlinkAccount(userId: string, provider: ProviderId): Promise<boolean>;
  listAccounts(userId: string): Promise<GameAccountRow[]>;
  saveRank(accountId: number, rank: RankInfo): Promise<void>;
  latestRanks(accountId: number): Promise<RankInfo[]>;
  rankAt(accountId: number, mode: string, at: Date): Promise<RankInfo | null>;
}

function toRankInfo(row: typeof rankSnapshots.$inferSelect): RankInfo {
  return {
    mode: row.mode,
    scale: row.scale,
    tier: row.tier,
    division: row.division,
    points: row.points,
    source: row.source,
    raw: row.raw,
  };
}

export function createLinkingService(deps: { db: Database }): LinkingService {
  const { db } = deps;

  return {
    async ensureUser(userId): Promise<void> {
      await db.insert(users).values({ id: userId }).onConflictDoNothing();
    },

    async openChallenge(userId, provider, challenge): Promise<void> {
      // Старый незавершённый челлендж того же провайдера больше не нужен.
      await db
        .delete(accountVerifications)
        .where(and(eq(accountVerifications.userId, userId), eq(accountVerifications.provider, provider)));

      await db.insert(accountVerifications).values({
        userId,
        provider,
        challenge: challenge.challenge,
        payload: challenge.payload,
        expiresAt: challenge.expiresAt,
      });
    },

    async takeChallenge(challenge): Promise<TakenChallenge> {
      const [row] = await db
        .select()
        .from(accountVerifications)
        .where(eq(accountVerifications.challenge, challenge));

      if (!row) {
        // Одно и то же сообщение для «никогда не существовал» и «уже использован
        // и поэтому удалён» — иначе по тексту ошибки можно было бы отличить
        // погашенный код от в принципе несуществующего.
        throw new UserError('Такой код не найден. Запусти привязку заново.');
      }
      if (row.expiresAt.getTime() < Date.now()) {
        await db.delete(accountVerifications).where(eq(accountVerifications.id, row.id));
        throw new UserError('Код истёк — он действует 15 минут. Запусти привязку заново.');
      }
      if (row.attempts >= MAX_ATTEMPTS) {
        await db.delete(accountVerifications).where(eq(accountVerifications.id, row.id));
        throw new UserError('Исчерпаны попытки по этому коду. Запусти привязку заново.');
      }

      await db
        .update(accountVerifications)
        .set({ attempts: sql`${accountVerifications.attempts} + 1` })
        .where(eq(accountVerifications.id, row.id));

      return { userId: row.userId, provider: row.provider, payload: row.payload };
    },

    async pendingChallenge(userId, provider) {
      const [row] = await db
        .select()
        .from(accountVerifications)
        .where(and(eq(accountVerifications.userId, userId), eq(accountVerifications.provider, provider)));

      if (!row) return null;
      if (row.expiresAt.getTime() < Date.now()) {
        await db.delete(accountVerifications).where(eq(accountVerifications.id, row.id));
        return null;
      }
      return { challenge: row.challenge, payload: row.payload };
    },

    async linkAccount(userId, provider, account, verified): Promise<number> {
      const [owner] = await db
        .select({ userId: gameAccounts.userId })
        .from(gameAccounts)
        .where(and(eq(gameAccounts.provider, provider), eq(gameAccounts.externalId, account.externalId)));

      if (owner && owner.userId !== userId) {
        throw new UserError(
          'Этот игровой аккаунт уже привязан к другому пользователю сервера. Если это твой аккаунт — обратись к администратору.',
        );
      }

      const [row] = await db
        .insert(gameAccounts)
        .values({
          userId,
          provider,
          externalId: account.externalId,
          displayName: account.displayName,
          region: account.region ?? null,
          verifiedAt: verified ? new Date() : null,
          verificationMethod: account.verificationMethod,
        })
        .onConflictDoUpdate({
          target: [gameAccounts.userId, gameAccounts.provider],
          set: {
            externalId: account.externalId,
            displayName: account.displayName,
            region: account.region ?? null,
            verifiedAt: verified ? new Date() : null,
            verificationMethod: account.verificationMethod,
            updatedAt: new Date(),
          },
        })
        .returning({ id: gameAccounts.id });

      if (!row) {
        throw new UserError('Не удалось сохранить привязку. Попробуй ещё раз.');
      }

      // Одноразовость испытания: как только аккаунт реально привязан, код, которым
      // это доказывалось, обязан перестать действовать. Иначе перехваченный код
      // (лог, история браузера, повторный сабмит формы) можно предъявить повторно
      // сколько угодно раз в пределах 15 минут и 5 попыток — replay чужой привязки.
      await db
        .delete(accountVerifications)
        .where(and(eq(accountVerifications.userId, userId), eq(accountVerifications.provider, provider)));

      return row.id;
    },

    async unlinkAccount(userId, provider): Promise<boolean> {
      const deleted = await db
        .delete(gameAccounts)
        .where(and(eq(gameAccounts.userId, userId), eq(gameAccounts.provider, provider)))
        .returning({ id: gameAccounts.id });
      return deleted.length > 0;
    },

    async listAccounts(userId): Promise<GameAccountRow[]> {
      return db.select().from(gameAccounts).where(eq(gameAccounts.userId, userId));
    },

    async saveRank(accountId, rank): Promise<void> {
      await db.insert(rankSnapshots).values({
        accountId,
        mode: rank.mode,
        scale: rank.scale,
        tier: rank.tier,
        division: rank.division,
        points: rank.points,
        source: rank.source,
        raw: rank.raw,
      });
      await db.update(gameAccounts).set({ updatedAt: new Date() }).where(eq(gameAccounts.id, accountId));
    },

    async latestRanks(accountId): Promise<RankInfo[]> {
      // DISTINCT ON — последний снимок по каждому режиму одним запросом.
      const rows = await db
        .selectDistinctOn([rankSnapshots.mode])
        .from(rankSnapshots)
        .where(eq(rankSnapshots.accountId, accountId))
        .orderBy(rankSnapshots.mode, desc(rankSnapshots.capturedAt));

      return rows.map(toRankInfo);
    },

    async rankAt(accountId, mode, at): Promise<RankInfo | null> {
      const [row] = await db
        .select()
        .from(rankSnapshots)
        .where(
          and(
            eq(rankSnapshots.accountId, accountId),
            eq(rankSnapshots.mode, mode),
            lte(rankSnapshots.capturedAt, at),
          ),
        )
        .orderBy(desc(rankSnapshots.capturedAt))
        .limit(1);

      return row ? toRankInfo(row) : null;
    },
  };
}
