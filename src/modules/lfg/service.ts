import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Database } from '../../core/db/client.js';
import { UserError } from '../../core/errors.js';
import {
  lfgMembers,
  lfgPings,
  lfgPosts,
  lfgSettings,
  type LfgGame,
  type LfgPostRow,
  type LfgSettingsRow,
} from './schema.js';

export const MAX_SLOTS = 10;
export const MIN_SLOTS = 2;
export const MAX_TTL_MINUTES = 720;

export interface PostWithRoster {
  post: LfgPostRow;
  members: string[];
}

export function createLfgService(deps: { db: Database }) {
  const { db } = deps;

  async function roster(postId: number): Promise<string[]> {
    const rows = await db
      .select({ userId: lfgMembers.userId })
      .from(lfgMembers)
      .where(eq(lfgMembers.postId, postId))
      .orderBy(asc(lfgMembers.joinedAt));
    return rows.map((row) => row.userId);
  }

  async function byId(postId: number): Promise<LfgPostRow> {
    const [row] = await db.select().from(lfgPosts).where(eq(lfgPosts.id, postId));
    if (!row) throw new UserError('Этот сбор уже не найти.');
    return row;
  }

  return {
    byId,
    roster,

    async settings(guildId: string): Promise<LfgSettingsRow> {
      const [row] = await db.select().from(lfgSettings).where(eq(lfgSettings.guildId, guildId));
      if (row) return row;
      const [created] = await db.insert(lfgSettings).values({ guildId }).onConflictDoNothing().returning();
      if (created) return created;
      const [again] = await db.select().from(lfgSettings).where(eq(lfgSettings.guildId, guildId));
      if (!again) throw new Error('настройки LFG не создались');
      return again;
    },

    async saveSettings(guildId: string, patch: Partial<Omit<LfgSettingsRow, 'guildId'>>): Promise<LfgSettingsRow> {
      const [row] = await db
        .insert(lfgSettings)
        .values({ guildId, ...patch })
        .onConflictDoUpdate({ target: lfgSettings.guildId, set: { ...patch, updatedAt: new Date() } })
        .returning();
      if (!row) throw new Error('настройки LFG не сохранились');
      return row;
    },

    async pingRole(guildId: string, game: LfgGame): Promise<string | null> {
      const [row] = await db
        .select()
        .from(lfgPings)
        .where(and(eq(lfgPings.guildId, guildId), eq(lfgPings.game, game)));
      return row?.roleId ?? null;
    },

    /** Все настроенные подписки сервера: игра — роль. Нужно самообслуживанию подписок. */
    async pingRoles(guildId: string): Promise<{ game: LfgGame; roleId: string }[]> {
      return db
        .select({ game: lfgPings.game, roleId: lfgPings.roleId })
        .from(lfgPings)
        .where(eq(lfgPings.guildId, guildId));
    },

    async setPingRole(guildId: string, game: LfgGame, roleId: string): Promise<void> {
      await db
        .insert(lfgPings)
        .values({ guildId, game, roleId })
        .onConflictDoUpdate({ target: [lfgPings.guildId, lfgPings.game], set: { roleId } });
    },

    /**
     * Открывает сбор. Собирающий сразу занимает своё место: сбор «нужно 5» от человека,
     * который сам в него не входит, вводит в заблуждение — придут пятеро, а играть шестерым
     * некуда.
     *
     * Второй открытый сбор от того же человека запрещён: два его объявления делят одну и ту
     * же компанию, и кто-то придёт туда, где мест уже нет.
     */
    async open(input: {
      guildId: string;
      hostUserId: string;
      game: LfgGame;
      mode: string;
      slots: number;
      note?: string;
      channelId: string;
      ttlMinutes: number;
    }): Promise<PostWithRoster> {
      if (input.slots < MIN_SLOTS || input.slots > MAX_SLOTS) {
        throw new UserError(`Мест должно быть от ${MIN_SLOTS} до ${MAX_SLOTS}.`);
      }

      const existing = await db
        .select()
        .from(lfgPosts)
        .where(
          and(
            eq(lfgPosts.guildId, input.guildId),
            eq(lfgPosts.hostUserId, input.hostUserId),
            inArray(lfgPosts.state, ['open', 'full']),
          ),
        );
      if (existing.length > 0) {
        throw new UserError('У тебя уже есть открытый сбор. Закрой его: `/lfg close`.');
      }

      const ttl = Math.min(Math.max(input.ttlMinutes, 5), MAX_TTL_MINUTES);
      const [post] = await db
        .insert(lfgPosts)
        .values({
          guildId: input.guildId,
          hostUserId: input.hostUserId,
          game: input.game,
          mode: input.mode,
          slots: input.slots,
          channelId: input.channelId,
          expiresAt: new Date(Date.now() + ttl * 60_000),
          ...(input.note ? { note: input.note } : {}),
        })
        .returning();
      if (!post) throw new Error('сбор не создался');

      await db.insert(lfgMembers).values({ postId: post.id, userId: input.hostUserId });
      return { post, members: [input.hostUserId] };
    },

    async attachMessage(postId: number, messageId: string): Promise<void> {
      await db.update(lfgPosts).set({ messageId }).where(eq(lfgPosts.id, postId));
    },

    async attachVoice(postId: number, voiceChannelId: string): Promise<void> {
      await db.update(lfgPosts).set({ voiceChannelId }).where(eq(lfgPosts.id, postId));
    },

    /**
     * Записывает человека. Заполненность проверяется **после** вставки, а не до: между
     * проверкой и вставкой встал бы второй желающий, и в сбор на пятерых влезло бы шестеро.
     * Уникальность `(postId, userId)` заодно гасит двойное нажатие кнопки.
     */
    async join(postId: number, userId: string): Promise<PostWithRoster> {
      const post = await byId(postId);
      if (post.state === 'closed' || post.state === 'expired') {
        throw new UserError('Этот сбор уже закрыт.');
      }

      const before = await roster(postId);
      if (before.includes(userId)) throw new UserError('Ты уже записан в этот сбор.');
      if (before.length >= post.slots) throw new UserError('Мест уже нет.');

      await db.insert(lfgMembers).values({ postId, userId }).onConflictDoNothing();
      const after = await roster(postId);

      // Лишний, проскочивший в гонке, откатывается: место занял тот, кто успел раньше.
      if (after.length > post.slots) {
        await db.delete(lfgMembers).where(and(eq(lfgMembers.postId, postId), eq(lfgMembers.userId, userId)));
        throw new UserError('Мест уже нет — кто-то занял последнее раньше.');
      }

      if (after.length >= post.slots && post.state === 'open') {
        const [updated] = await db
          .update(lfgPosts)
          .set({ state: 'full' })
          .where(and(eq(lfgPosts.id, postId), eq(lfgPosts.state, 'open')))
          .returning();
        return { post: updated ?? post, members: after };
      }

      return { post, members: after };
    },

    async leave(postId: number, userId: string): Promise<PostWithRoster> {
      const post = await byId(postId);
      if (post.hostUserId === userId) {
        throw new UserError('Собирающий не может выйти из своего сбора — закрой его: `/lfg close`.');
      }

      await db.delete(lfgMembers).where(and(eq(lfgMembers.postId, postId), eq(lfgMembers.userId, userId)));
      const members = await roster(postId);

      // Место освободилось — сбор снова открыт.
      const [updated] = await db
        .update(lfgPosts)
        .set({ state: 'open' })
        .where(and(eq(lfgPosts.id, postId), eq(lfgPosts.state, 'full')))
        .returning();

      return { post: updated ?? post, members };
    },

    /** Закрытие: своё — собирающим, любое — администратором. */
    async close(postId: number, actorId: string, isAdmin: boolean): Promise<LfgPostRow> {
      const post = await byId(postId);
      if (post.hostUserId !== actorId && !isAdmin) {
        throw new UserError('Закрыть сбор может только тот, кто его создал.');
      }
      const [row] = await db
        .update(lfgPosts)
        .set({ state: 'closed', closedAt: new Date() })
        .where(and(eq(lfgPosts.id, postId), inArray(lfgPosts.state, ['open', 'full'])))
        .returning();
      return row ?? post;
    },

    /** Открытый сбор этого человека — чтобы `/lfg close` не требовал номера. */
    async ownPost(guildId: string, userId: string): Promise<LfgPostRow | null> {
      const [row] = await db
        .select()
        .from(lfgPosts)
        .where(
          and(
            eq(lfgPosts.guildId, guildId),
            eq(lfgPosts.hostUserId, userId),
            inArray(lfgPosts.state, ['open', 'full']),
          ),
        );
      return row ?? null;
    },

    async openPosts(guildId: string, limit: number): Promise<PostWithRoster[]> {
      const posts = await db
        .select()
        .from(lfgPosts)
        .where(and(eq(lfgPosts.guildId, guildId), inArray(lfgPosts.state, ['open', 'full'])))
        .orderBy(asc(lfgPosts.expiresAt))
        .limit(limit);

      return Promise.all(posts.map(async (post) => ({ post, members: await roster(post.id) })));
    },

    /**
     * Просроченные сборы. Срок — главная величина этого модуля: объявление, висящее сутки,
     * хуже отсутствия объявления, потому что человек приходит на зов, а зовущий уже спит.
     */
    async expired(now: Date, limit: number): Promise<LfgPostRow[]> {
      return db
        .select()
        .from(lfgPosts)
        .where(and(inArray(lfgPosts.state, ['open', 'full']), lte(lfgPosts.expiresAt, now)))
        .orderBy(asc(lfgPosts.expiresAt))
        .limit(limit);
    },

    async markExpired(postId: number): Promise<void> {
      await db
        .update(lfgPosts)
        .set({ state: 'expired', closedAt: new Date() })
        .where(and(eq(lfgPosts.id, postId), inArray(lfgPosts.state, ['open', 'full'])));
    },

    /** Сколько сборов человек открыл за сутки — чтобы объявлениями не забивали канал. */
    async postsToday(guildId: string, userId: string): Promise<number> {
      const result = await db.execute<{ count: number }>(sql`
        select count(*)::int as count
        from lfg_posts
        where guild_id = ${guildId} and host_user_id = ${userId}
          and created_at > now() - interval '24 hours'
      `);
      return result.rows[0]?.count ?? 0;
    },
  };
}

export type LfgService = ReturnType<typeof createLfgService>;
