import { and, asc, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../../core/db/client.js';
import { UserError } from '../../core/errors.js';
import {
  achievements,
  levelRewards,
  profiles,
  purchases,
  seasons,
  shopItems,
  voiceSessions,
  xpEvents,
  type AchievementRow,
  type LevelRewardRow,
  type ProfileRow,
  type SeasonRow,
  type XpReason,
} from './schema.js';
import {
  ACHIEVEMENTS,
  COINS_PER_LEVEL,
  VOICE_SESSION_CAP_MINUTES,
  XP_PER_VOICE_MINUTE,
  achievementByCode,
  levelFromXp,
} from './rules.js';

export interface AwardResult {
  profile: ProfileRow;
  /** Уровни, которые человек перешагнул этим начислением: по ним выдаются роли. */
  levelsGained: number[];
}

export function createProgressionService(deps: { db: Database }) {
  const { db } = deps;

  /**
   * Текущий сезон. Если его нет — открываем: сервер не должен требовать ручного действия,
   * чтобы начать считать опыт.
   */
  async function currentSeason(guildId: string): Promise<SeasonRow> {
    const [existing] = await db
      .select()
      .from(seasons)
      .where(and(eq(seasons.guildId, guildId), isNull(seasons.endedAt)))
      .orderBy(desc(seasons.id));
    if (existing) return existing;

    const [created] = await db.insert(seasons).values({ guildId, name: 'Первый сезон' }).returning();
    if (!created) throw new Error('сезон не создался');
    return created;
  }

  return {
    currentSeason,

    async profile(guildId: string, userId: string): Promise<ProfileRow> {
      const season = await currentSeason(guildId);
      const [row] = await db
        .select()
        .from(profiles)
        .where(
          and(eq(profiles.guildId, guildId), eq(profiles.userId, userId), eq(profiles.seasonId, season.id)),
        );
      if (row) return row;

      const [created] = await db
        .insert(profiles)
        .values({ guildId, userId, seasonId: season.id })
        .onConflictDoNothing()
        .returning();
      if (created) return created;

      // Вставку занял конкурентный вызов — перечитываем.
      const [again] = await db
        .select()
        .from(profiles)
        .where(
          and(eq(profiles.guildId, guildId), eq(profiles.userId, userId), eq(profiles.seasonId, season.id)),
        );
      if (!again) throw new Error('профиль прогрессии не создался');
      return again;
    },

    /**
     * Начисление. Журнал и кэш пишутся **одной транзакцией**: кэш можно пересобрать из
     * журнала, но только если журнал полон, — а расхождение в другую сторону (в кэше есть,
     * в журнале нет) сделало бы разбор «за что мне столько» невозможным.
     *
     * Возвращает перешагнутые уровни, а не только новый: за один турнир можно перескочить
     * два уровня сразу, и роли надо выдать за оба.
     */
    async award(
      guildId: string,
      userId: string,
      amount: number,
      reason: XpReason,
      details: Record<string, unknown> = {},
    ): Promise<AwardResult> {
      const before = await this.profile(guildId, userId);
      if (amount === 0) return { profile: before, levelsGained: [] };

      const season = await currentSeason(guildId);
      const xpAfter = Math.max(before.xp + amount, 0);
      const levelBefore = before.level;
      const levelAfter = levelFromXp(xpAfter);

      const levelsGained: number[] = [];
      for (let level = levelBefore + 1; level <= levelAfter; level += 1) levelsGained.push(level);

      // Монеты за уровень начисляются здесь же: отдельным проходом их легко потерять при
      // откате, а вместе с уровнем они всегда согласованы.
      const coinsGained = levelsGained.length * COINS_PER_LEVEL;

      const updated = await db.transaction(async (tx) => {
        await tx.insert(xpEvents).values({ guildId, userId, amount, reason, seasonId: season.id, details });

        const [row] = await tx
          .update(profiles)
          .set({
            xp: xpAfter,
            level: levelAfter,
            coins: before.coins + coinsGained,
            updatedAt: new Date(),
          })
          .where(eq(profiles.id, before.id))
          .returning();
        if (!row) throw new Error('профиль прогрессии не обновился');
        return row;
      });

      return { profile: updated, levelsGained };
    },

    /** Счётчик сообщений — отдельно от опыта: он нужен для достижений и статистики. */
    async countMessage(guildId: string, userId: string): Promise<void> {
      const profile = await this.profile(guildId, userId);
      await db
        .update(profiles)
        .set({ messages: profile.messages + 1, updatedAt: new Date() })
        .where(eq(profiles.id, profile.id));
    },

    async addVoiceMinutes(guildId: string, userId: string, minutes: number): Promise<void> {
      const profile = await this.profile(guildId, userId);
      await db
        .update(profiles)
        .set({ voiceMinutes: profile.voiceMinutes + minutes, updatedAt: new Date() })
        .where(eq(profiles.id, profile.id));
    },

    /**
     * Выдаёт достижение, если его ещё нет. Уникальность `(guildId, userId, code)` — и есть
     * гарантия «один раз»; `onConflictDoNothing` возвращает пусто, когда достижение уже
     * было, и это не ошибка, а нормальный исход повторной проверки.
     */
    async grantAchievement(guildId: string, userId: string, code: string): Promise<AchievementRow | null> {
      const definition = achievementByCode(code);
      if (!definition) throw new Error(`неизвестное достижение: ${code}`);

      const season = await currentSeason(guildId);
      const [row] = await db
        .insert(achievements)
        .values({ guildId, userId, code, seasonId: season.id })
        .onConflictDoNothing()
        .returning();
      if (!row) return null;

      if (definition.xp > 0) {
        await this.award(guildId, userId, definition.xp, 'achievement', { code });
      }
      return row;
    },

    async listAchievements(guildId: string, userId: string): Promise<AchievementRow[]> {
      return db
        .select()
        .from(achievements)
        .where(and(eq(achievements.guildId, guildId), eq(achievements.userId, userId)))
        .orderBy(asc(achievements.earnedAt));
    },

    async leaderboard(guildId: string, limit: number): Promise<ProfileRow[]> {
      const season = await currentSeason(guildId);
      return db
        .select()
        .from(profiles)
        .where(and(eq(profiles.guildId, guildId), eq(profiles.seasonId, season.id)))
        .orderBy(desc(profiles.xp))
        .limit(limit);
    },

    /** Место человека в таблице — считаем запросом, а не выгрузкой всей таблицы в память. */
    async rankOf(guildId: string, userId: string): Promise<number> {
      const profile = await this.profile(guildId, userId);
      const result = await db.execute<{ higher: number }>(sql`
        select count(*)::int as higher
        from progression_profiles
        where guild_id = ${guildId} and season_id = ${profile.seasonId} and xp > ${profile.xp}
      `);
      return (result.rows[0]?.higher ?? 0) + 1;
    },

    /**
     * Новый сезон: старый закрывается, зачёт начинается с нуля. Журнал и достижения
     * остаются — сезон обнуляет соревнование, а не историю человека.
     */
    async startSeason(guildId: string, name: string): Promise<SeasonRow> {
      const previous = await currentSeason(guildId);
      const [created] = await db.transaction(async (tx) => {
        await tx.update(seasons).set({ endedAt: new Date() }).where(eq(seasons.id, previous.id));
        return tx.insert(seasons).values({ guildId, name }).returning();
      });
      if (!created) throw new Error('сезон не создался');
      return created;
    },

    async setLevelReward(guildId: string, level: number, roleId: string): Promise<void> {
      await db
        .insert(levelRewards)
        .values({ guildId, level, roleId })
        .onConflictDoUpdate({ target: [levelRewards.guildId, levelRewards.level], set: { roleId } });
    },

    async levelRewardsUpTo(guildId: string, level: number): Promise<LevelRewardRow[]> {
      return db
        .select()
        .from(levelRewards)
        .where(and(eq(levelRewards.guildId, guildId), lte(levelRewards.level, level)))
        .orderBy(asc(levelRewards.level));
    },

    async listShop(guildId: string) {
      return db
        .select()
        .from(shopItems)
        .where(and(eq(shopItems.guildId, guildId), eq(shopItems.enabled, 'yes')))
        .orderBy(asc(shopItems.price));
    },

    async addShopItem(input: {
      guildId: string;
      payload: string;
      title: string;
      price: number;
      durationHours?: number;
    }) {
      const [row] = await db
        .insert(shopItems)
        .values({
          guildId: input.guildId,
          payload: input.payload,
          title: input.title,
          price: input.price,
          ...(input.durationHours ? { durationHours: input.durationHours } : {}),
        })
        .onConflictDoUpdate({
          target: [shopItems.guildId, shopItems.payload],
          set: { title: input.title, price: input.price, enabled: 'yes' },
        })
        .returning();
      return row ?? null;
    },

    /**
     * Покупка. Списание идёт условным UPDATE «монет хватает» — если между чтением баланса и
     * списанием человек купил что-то ещё, условие не выполнится и покупка не пройдёт.
     * Проверка перед списанием дала бы уход в минус на двух одновременных покупках.
     */
    async buy(guildId: string, userId: string, itemId: number) {
      const [item] = await db
        .select()
        .from(shopItems)
        .where(and(eq(shopItems.id, itemId), eq(shopItems.guildId, guildId), eq(shopItems.enabled, 'yes')));
      if (!item) throw new UserError('Такого товара нет.');

      const profile = await this.profile(guildId, userId);
      const [charged] = await db
        .update(profiles)
        .set({ coins: profile.coins - item.price, updatedAt: new Date() })
        .where(and(eq(profiles.id, profile.id), sql`${profiles.coins} >= ${item.price}`))
        .returning();

      if (!charged) {
        throw new UserError(`Не хватает монет: нужно ${item.price}, у тебя ${profile.coins}.`);
      }

      const expiresAt = item.durationHours
        ? new Date(Date.now() + item.durationHours * 60 * 60 * 1_000)
        : null;

      await db.insert(purchases).values({
        guildId,
        userId,
        itemId: item.id,
        paid: item.price,
        ...(expiresAt ? { expiresAt } : {}),
      });

      return { item, profile: charged, expiresAt };
    },

    /**
     * Покупки с истёкшим сроком, у которых роль ещё не снята.
     *
     * Условие «срок задан И вышел», а не «вышел ИЛИ не задан»: бессрочная покупка
     * (`expiresAt` = NULL) снималась бы во второй же прогон джобы, то есть человек платил
     * бы монеты за роль на пять минут.
     */
    async expiredPurchases(now: Date, limit: number) {
      return db
        .select({ purchase: purchases, item: shopItems })
        .from(purchases)
        .innerJoin(shopItems, eq(shopItems.id, purchases.itemId))
        .where(
          and(
            isNull(purchases.revokedAt),
            sql`${purchases.expiresAt} is not null`,
            lte(purchases.expiresAt, now),
          ),
        )
        .limit(limit);
    },

    async markRevoked(purchaseId: number): Promise<void> {
      await db.update(purchases).set({ revokedAt: new Date() }).where(eq(purchases.id, purchaseId));
    },

    async openVoiceSession(guildId: string, userId: string, channelId: string): Promise<void> {
      await db
        .insert(voiceSessions)
        .values({ guildId, userId, channelId })
        .onConflictDoUpdate({
          target: [voiceSessions.guildId, voiceSessions.userId],
          set: { channelId, joinedAt: new Date() },
        });
    },

    /**
     * Закрывает сессию и возвращает, сколько минут насчитали. Потолок на сессию нужен,
     * потому что забытый в канале микрофон иначе даёт опыт за сутки простоя.
     */
    async closeVoiceSession(guildId: string, userId: string, now: Date): Promise<number> {
      const [session] = await db
        .select()
        .from(voiceSessions)
        .where(and(eq(voiceSessions.guildId, guildId), eq(voiceSessions.userId, userId)));
      if (!session) return 0;

      await db
        .delete(voiceSessions)
        .where(and(eq(voiceSessions.guildId, guildId), eq(voiceSessions.userId, userId)));

      const minutes = Math.floor((now.getTime() - session.joinedAt.getTime()) / 60_000);
      return Math.min(Math.max(minutes, 0), VOICE_SESSION_CAP_MINUTES);
    },

    /** Опыт за голосовые минуты — отдельно, чтобы вызывающий решал, начислять ли вообще. */
    async awardVoice(guildId: string, userId: string, minutes: number): Promise<AwardResult | null> {
      if (minutes <= 0) return null;
      await this.addVoiceMinutes(guildId, userId, minutes);
      return this.award(guildId, userId, minutes * XP_PER_VOICE_MINUTE, 'voice', { minutes });
    },

    /** Каталог для показа: что вообще можно получить. */
    catalog() {
      return ACHIEVEMENTS;
    },
  };
}

export type ProgressionService = ReturnType<typeof createProgressionService>;
