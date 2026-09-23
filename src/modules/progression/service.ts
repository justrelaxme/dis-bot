import { and, asc, desc, eq, gt, isNull, lte, ne, sql } from 'drizzle-orm';
import type { Database } from '../../core/db/client.js';
import { auditLog } from '../../core/db/schema/core.js';
import { UserError } from '../../core/errors.js';
import {
  achievements,
  levelRewards,
  profiles,
  purchases,
  seasonResults,
  seasonRewards,
  seasons,
  shopItems,
  voiceSessions,
  xpEvents,
  type AchievementRow,
  type LevelRewardRow,
  type ProfileRow,
  type SeasonResultRow,
  type SeasonRewardsRow,
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

/** Награждённое призовое место при закрытии сезона. */
export interface SeasonAward {
  userId: string;
  place: number;
  xp: number;
  coins: number;
}

/**
 * Итог закрытия сезона. Роли выдаёт вызывающий: сервис не знает про Discord, а роль
 * чемпиона надо не только надеть новому, но и снять с прежнего.
 */
export interface SeasonClosing {
  season: SeasonRow;
  previous: SeasonRow;
  awarded: SeasonAward[];
  championRoleId: string | null;
}

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

    // Два первых обращения на новом сервере приходят одновременно — сообщение и голос. Сезон
    // создаёт тот, кто успел; второй упирается в уникальность открытого сезона и читает его.
    const [created] = await db
      .insert(seasons)
      .values({ guildId, name: 'Первый сезон' })
      .onConflictDoNothing()
      .returning();
    if (created) return created;

    const [raced] = await db
      .select()
      .from(seasons)
      .where(and(eq(seasons.guildId, guildId), isNull(seasons.endedAt)));
    if (!raced) throw new Error('сезон не создался');
    return raced;
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
     *
     * Всё считается от строки под блокировкой, а не от прочитанного заранее: сообщение,
     * голос и турнир начисляют одновременно, и запись абсолютных значений, посчитанных из
     * одного и того же чтения, оставляла бы только последнее начисление — а заодно стирала
     * монеты, пришедшие между чтением и записью.
     */
    async award(
      guildId: string,
      userId: string,
      amount: number,
      reason: XpReason,
      details: Record<string, unknown> = {},
    ): Promise<AwardResult> {
      const profile = await this.profile(guildId, userId);
      if (amount === 0) return { profile, levelsGained: [] };

      return db.transaction(async (tx) => {
        await tx.insert(xpEvents).values({ guildId, userId, amount, reason, seasonId: profile.seasonId, details });

        // Прибавка в самом SQL. Этот UPDATE запирает строку до конца транзакции: второе
        // начисление встанет в очередь и прибавит к уже записанному.
        const [bumped] = await tx
          .update(profiles)
          .set({ xp: sql`greatest(${profiles.xp} + ${amount}, 0)`, updatedAt: new Date() })
          .where(eq(profiles.id, profile.id))
          .returning();
        if (!bumped) throw new Error('профиль прогрессии не обновился');

        // Уровень «до» — из той же строки: столбец level этим UPDATE не тронут, а строка
        // заперта, значит он соответствует опыту до нашей прибавки. Считать его из
        // `xp - amount` нельзя: опыт упирается в ноль, и разность соврала бы.
        const levelBefore = bumped.level;
        const levelAfter = levelFromXp(bumped.xp);
        if (levelAfter === levelBefore) return { profile: bumped, levelsGained: [] };

        const levelsGained: number[] = [];
        for (let level = levelBefore + 1; level <= levelAfter; level += 1) levelsGained.push(level);

        // Монеты за уровень — в той же транзакции и тоже прибавкой: отдельным проходом их
        // легко потерять при откате, а абсолютным значением — затереть чужое начисление.
        const [leveled] = await tx
          .update(profiles)
          .set({
            level: levelAfter,
            coins: sql`${profiles.coins} + ${levelsGained.length * COINS_PER_LEVEL}`,
          })
          .where(eq(profiles.id, profile.id))
          .returning();
        if (!leveled) throw new Error('профиль прогрессии не обновился');
        return { profile: leveled, levelsGained };
      });
    },

    /** Счётчик сообщений — отдельно от опыта: он нужен для достижений и статистики. */
    async countMessage(guildId: string, userId: string): Promise<void> {
      const profile = await this.profile(guildId, userId);
      // Прибавкой, как и опыт: сообщения идут пачками, и чтение-плюс-запись теряло бы их.
      await db
        .update(profiles)
        .set({ messages: sql`${profiles.messages} + 1`, updatedAt: new Date() })
        .where(eq(profiles.id, profile.id));
    },

    async addVoiceMinutes(guildId: string, userId: string, minutes: number): Promise<void> {
      const profile = await this.profile(guildId, userId);
      await db
        .update(profiles)
        .set({ voiceMinutes: sql`${profiles.voiceMinutes} + ${minutes}`, updatedAt: new Date() })
        .where(eq(profiles.id, profile.id));
    },

    /**
     * Выдаёт достижение, если его ещё нет. Уникальность `(guildId, userId, code)` — и есть
     * гарантия «один раз»; `onConflictDoNothing` возвращает пусто, когда достижение уже
     * было, и это не ошибка, а нормальный исход повторной проверки.
     */
    /**
     * Начисляет монеты за что-то, посчитанное вне прогрессии, — например за угаданный прогноз.
     *
     * Отдельный метод, а не прямая правка таблицы из чужого модуля: кошелёк живёт здесь, и
     * второй способ его менять означал бы два места, где заводится правило «сколько у человека
     * монет». Опыта такое начисление не даёт: монеты за угадывание не должны поднимать уровень,
     * который считается за участие.
     */
    async grantCoins(guildId: string, userId: string, coins: number, reason: string): Promise<void> {
      if (coins <= 0) return;
      const profile = await this.profile(guildId, userId);
      await db
        .update(profiles)
        .set({ coins: sql`${profiles.coins} + ${coins}`, updatedAt: new Date() })
        .where(eq(profiles.id, profile.id));

      await db.insert(auditLog).values({
        guildId,
        actorId: 'system',
        action: 'progression.coins',
        targetId: userId,
        details: { coins, reason },
      });
    },

    /**
     * Сколько раз человек получал опыт по этой причине — за всё время, а не за сезон. Нужно
     * достижениям «за постоянство»: три победы остаются тремя победами и после смены сезона.
     */
    async countEvents(guildId: string, userId: string, reason: XpReason): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(xpEvents)
        .where(and(eq(xpEvents.guildId, guildId), eq(xpEvents.userId, userId), eq(xpEvents.reason, reason)));
      return row?.count ?? 0;
    },

    /**
     * Поправка баланса в обе стороны — например, пересчёт прогноза после исправленного
     * результата. Баланс не уходит ниже нуля: монеты могли быть уже потрачены, и долг перед
     * магазином был бы хуже недосписанной поправки.
     */
    async adjustCoins(guildId: string, userId: string, delta: number, reason: string): Promise<void> {
      if (delta === 0) return;
      const profile = await this.profile(guildId, userId);
      await db
        .update(profiles)
        .set({ coins: sql`greatest(${profiles.coins} + ${delta}, 0)`, updatedAt: new Date() })
        .where(eq(profiles.id, profile.id));
      await db.insert(auditLog).values({
        guildId,
        actorId: 'system',
        action: 'progression.coins',
        targetId: userId,
        details: { coins: delta, reason },
      });
    },

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
    async seasonRewardConfig(guildId: string): Promise<SeasonRewardsRow> {
      const [row] = await db.select().from(seasonRewards).where(eq(seasonRewards.guildId, guildId));
      if (row) return row;
      const [created] = await db
        .insert(seasonRewards)
        .values({ guildId })
        .onConflictDoNothing()
        .returning();
      if (created) return created;
      const [again] = await db.select().from(seasonRewards).where(eq(seasonRewards.guildId, guildId));
      if (!again) throw new Error('настройки наград за сезон не создались');
      return again;
    },

    async saveSeasonRewards(
      guildId: string,
      patch: Partial<Omit<SeasonRewardsRow, 'guildId'>>,
    ): Promise<SeasonRewardsRow> {
      const [row] = await db
        .insert(seasonRewards)
        .values({ guildId, ...patch })
        .onConflictDoUpdate({ target: seasonRewards.guildId, set: { ...patch, updatedAt: new Date() } })
        .returning();
      if (!row) throw new Error('настройки наград за сезон не сохранились');
      return row;
    },

    /**
     * Чемпион предыдущего закрытого сезона — с кого снять роль. Берём из записей итогов,
     * а не из списка носителей роли: список носителей приходит из кэша участников, который
     * на большом сервере может быть неполным, и тогда роль осталась бы на прежнем чемпионе.
     */
    async priorChampion(guildId: string, exceptSeasonId: number): Promise<string | null> {
      const [row] = await db
        .select({ userId: seasonResults.userId })
        .from(seasonResults)
        .where(
          and(
            eq(seasonResults.guildId, guildId),
            eq(seasonResults.place, 1),
            ne(seasonResults.seasonId, exceptSeasonId),
          ),
        )
        .orderBy(desc(seasonResults.seasonId))
        .limit(1);
      return row?.userId ?? null;
    },

    /** Серверы, где смена сезона настроена по расписанию. Нужно джобе. */
    async guildsWithSeasonRotation(): Promise<SeasonRewardsRow[]> {
      return db.select().from(seasonRewards).where(gt(seasonRewards.seasonWeeks, 0));
    },

    /**
     * Имя следующего сезона по счёту: «Сезон 3». Автоматической смене нужно имя, а
     * придумывать его боту не из чего — номер честнее выдуманного названия.
     */
    async nextSeasonName(guildId: string): Promise<string> {
      const result = await db.execute<{ count: number }>(sql`
        select count(*)::int as count from progression_seasons where guild_id = ${guildId}
      `);
      return `Сезон ${(result.rows[0]?.count ?? 0) + 1}`;
    },

    /** Итоги закрытого сезона: место, опыт, выданные монеты. */
    async seasonResults(guildId: string, seasonId: number): Promise<SeasonResultRow[]> {
      return db
        .select()
        .from(seasonResults)
        .where(and(eq(seasonResults.guildId, guildId), eq(seasonResults.seasonId, seasonId)))
        .orderBy(asc(seasonResults.place));
    },

    /**
     * Закрывает сезон и открывает новый, попутно награждая призовые места.
     *
     * Обнуление без награды — это просто потеря прогресса: человек месяц лез в таблицу, а
     * первого числа обнаружил ноль и никакого следа того, что он был первым. Поэтому
     * закрытие сезона обязано что-то оставлять.
     *
     * Монеты начисляются в **новый** сезон: в закрытом они уже никому не пригодятся, потому
     * что зачёт и кошелёк в этой модели живут в одной строке на сезон.
     *
     * Выдача однократна за счёт уникальности в `season_results`: если роль не выдалась
     * из-за иерархии ролей, повтор не заплатит монеты второй раз.
     */
    async startSeason(guildId: string, name: string): Promise<SeasonClosing> {
      const previous = await currentSeason(guildId);
      const config = await this.seasonRewardConfig(guildId);

      // Стоящих в таблице читаем до закрытия: после него текущим станет новый сезон.
      // Нулевой опыт награды не заслуживает — иначе призы уйдут тем, кто не приходил.
      const standings = await db
        .select()
        .from(profiles)
        .where(
          and(
            eq(profiles.guildId, guildId),
            eq(profiles.seasonId, previous.id),
            gt(profiles.xp, 0),
          ),
        )
        .orderBy(desc(profiles.xp))
        .limit(Math.max(config.topCount, 0));

      const [created] = await db.transaction(async (tx) => {
        await tx.update(seasons).set({ endedAt: new Date() }).where(eq(seasons.id, previous.id));
        return tx.insert(seasons).values({ guildId, name }).returning();
      });
      if (!created) throw new Error('сезон не создался');

      const awarded: SeasonAward[] = [];
      for (const [index, row] of standings.entries()) {
        const place = index + 1;
        const coins = config.coinsBase * (config.topCount - place + 1);

        const [recorded] = await db
          .insert(seasonResults)
          .values({
            guildId,
            seasonId: previous.id,
            userId: row.userId,
            place,
            xp: row.xp,
            coinsAwarded: coins,
          })
          .onConflictDoNothing()
          .returning();
        // Уже записано — награда за этот сезон выдавалась, второй раз не платим.
        if (!recorded) continue;

        if (coins > 0) {
          // profile() создаёт строку нового сезона, если её ещё нет.
          await this.profile(guildId, row.userId);
          await db
            .update(profiles)
            .set({ coins: sql`${profiles.coins} + ${coins}`, updatedAt: new Date() })
            .where(
              and(
                eq(profiles.guildId, guildId),
                eq(profiles.userId, row.userId),
                eq(profiles.seasonId, created.id),
              ),
            );
        }

        await this.grantAchievement(guildId, row.userId, place === 1 ? 'season-winner' : 'season-podium');
        awarded.push({ userId: row.userId, place, xp: row.xp, coins });
      }

      return { season: created, previous, awarded, championRoleId: config.championRoleId };
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
     * Оплата покупки: списание и запись о ней. Роль к этому моменту уже выдана — порядок
     * задаёт purchaseRole (shop.ts), чтобы не брать монеты за то, что Discord не выдал.
     *
     * Списание — один условный UPDATE, и вычитание идёт в самом SQL: `coins = coins - price
     * where coins >= price`. Проверка баланса отдельным чтением дала бы уход в минус на двух
     * одновременных покупках, а разность, посчитанная из прочитанного, затёрла бы монеты,
     * начисленные между чтением и списанием.
     *
     * Запись о покупке — в той же транзакции: списанные монеты без записи не снимутся по
     * сроку и не найдутся при разборе.
     */
    async buy(guildId: string, userId: string, itemId: number) {
      const [item] = await db
        .select()
        .from(shopItems)
        .where(and(eq(shopItems.id, itemId), eq(shopItems.guildId, guildId), eq(shopItems.enabled, 'yes')));
      if (!item) throw new UserError('Такого товара нет.');

      const profile = await this.profile(guildId, userId);
      const expiresAt = item.durationHours
        ? new Date(Date.now() + item.durationHours * 60 * 60 * 1_000)
        : null;

      const charged = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(profiles)
          .set({ coins: sql`${profiles.coins} - ${item.price}`, updatedAt: new Date() })
          .where(and(eq(profiles.id, profile.id), sql`${profiles.coins} >= ${item.price}`))
          .returning();
        if (!row) return null;

        await tx.insert(purchases).values({
          guildId,
          userId,
          itemId: item.id,
          paid: item.price,
          ...(expiresAt ? { expiresAt } : {}),
        });
        return row;
      });

      if (!charged) {
        // Баланс перечитываем: прочитанный до списания мог уже устареть — а человеку
        // нужна цифра, которая есть сейчас.
        const now = await this.profile(guildId, userId);
        throw new UserError(`Не хватает монет: нужно ${item.price}, у тебя ${now.coins}.`);
      }

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

    /**
     * Открывает сессию — или перезапускает её с `now`, если она уже была. Сессия одна на
     * человека, поэтому переход между каналами обязан сначала закрыть старую
     * (`voiceTransition` в voice.ts), иначе её минуты перезапишутся здесь.
     */
    async openVoiceSession(guildId: string, userId: string, channelId: string, now = new Date()): Promise<void> {
      await db
        .insert(voiceSessions)
        .values({ guildId, userId, channelId, joinedAt: now })
        .onConflictDoUpdate({
          target: [voiceSessions.guildId, voiceSessions.userId],
          set: { channelId, joinedAt: now },
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
