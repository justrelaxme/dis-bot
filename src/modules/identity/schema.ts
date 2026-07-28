import { bigint, bigserial, index, integer, jsonb, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { guilds, users } from '../../core/db/schema/core.js';

export type ProviderId = 'steam' | 'riot-lol' | 'riot-tft' | 'riot-valorant';
export type RankScale = 'riot-tier' | 'dota-mmr';
export type RankSource = 'api' | 'manual';
export type VerificationMethod = 'steam-openid' | 'riot-third-party-code' | 'manual';

export const gameAccounts = pgTable(
  'game_accounts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<ProviderId>().notNull(),
    /** SteamID64, Riot PUUID или Riot ID для Valorant. */
    externalId: text('external_id').notNull(),
    displayName: text('display_name').notNull(),
    /** Платформа Riot (euw1, ru, …). NULL для Steam. */
    region: text('region'),
    /** NULL означает «владение не подтверждено» — авто-роль такой аккаунт не даёт. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verificationMethod: text('verification_method').$type<VerificationMethod>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Один игровой аккаунт нельзя привязать к двум Discord-профилям.
    unique('game_accounts_provider_external_uq').on(table.provider, table.externalId),
    // Один игровой аккаунт на провайдера: авто-роль требует однозначного ранга.
    unique('game_accounts_user_provider_uq').on(table.userId, table.provider),
    index('game_accounts_updated_idx').on(table.updatedAt),
  ],
);

export const accountVerifications = pgTable(
  'account_verifications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<ProviderId>().notNull(),
    /** Код для игрока или nonce для OpenID. */
    challenge: text('challenge').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('account_verifications_user_provider_idx').on(table.userId, table.provider),
    unique('account_verifications_challenge_uq').on(table.challenge),
  ],
);

export const rankSnapshots = pgTable(
  'rank_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    accountId: bigint('account_id', { mode: 'number' })
      .notNull()
      .references(() => gameAccounts.id, { onDelete: 'cascade' }),
    mode: text('mode').notNull(),
    scale: text('scale').$type<RankScale>().notNull(),
    tier: text('tier'),
    division: text('division'),
    points: integer('points'),
    source: text('source').$type<RankSource>().notNull(),
    raw: jsonb('raw').$type<unknown>().notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('rank_snapshots_account_mode_idx').on(table.accountId, table.mode, table.capturedAt.desc())],
);

export const roleMappings = pgTable(
  'role_mappings',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<ProviderId>().notNull(),
    mode: text('mode').notNull(),
    tier: text('tier').notNull(),
    roleId: text('role_id').notNull(),
  },
  (table) => [unique('role_mappings_uq').on(table.guildId, table.provider, table.mode, table.tier)],
);
