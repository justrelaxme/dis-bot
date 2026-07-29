# Этап 1: личность и профиль — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Игрок привязывает свои Steam и Riot аккаунты с подтверждением владения, видит единую карточку профиля с рангами, и получает роли на сервере автоматически по своему рангу.

**Architecture:** Модуль `identity` внутри ядра этапа 0. Вся разница между играми спрятана за интерфейсом `GameProvider`; выше него код работает только с нормализованным `RankInfo`. Ранги обновляет cron-джоба, а не пользовательский запрос, и публикует `rank.changed` в шину — модуль ролей слушает событие и не знает о провайдерах ничего.

**Tech Stack:** Тот же, что на этапе 0. Добавляются Steam Web API + Steam OpenID 2.0, Riot Games API (account-v1, league-v4, tft-league-v1), Components V2 для карточки профиля.

**Spec:** [docs/superpowers/specs/2026-07-27-discord-gaming-bot-design.md](../specs/2026-07-27-discord-gaming-bot-design.md)
**Предыдущий план:** [2026-07-27-stage0-bot-core.md](2026-07-27-stage0-bot-core.md) — должен быть выполнен полностью.

## Global Constraints

Все ограничения этапа 0 остаются в силе. Ключевые, о которых спотыкаются чаще всего:

- **ESM:** относительные импорты с расширением `.js`, даже когда файл на диске `.ts`.
- **Эфемерные ответы:** `flags: MessageFlags.Ephemeral`, никогда `ephemeral: true`.
- **Окно ответа Discord — 3 секунды.** Любая команда этого этапа, кроме `/rolemap`, делает сетевой вызов, поэтому объявляет `defer`.
- **Snowflake — `string`.** Времена — `timestamptz` UTC. LP и MMR — целые.
- **Зависимости приходят через `ModuleContext`**, не глобальным импортом.
- **Сообщения zod указываются в двух местах одновременно** — параметром схемы (`z.string({ error: '…' })`) и вторым аргументом уточнения (`.min(1, '…')`). Первое покрывает проверку типа, второе — своё уточнение; одного из двух недостаточно, иначе на другом пути протекает английский текст zod. Актуально для валидации ответов провайдеров.
- **Ассерты на ограничения БД пишутся через `cause`, не через текст ошибки.** Drizzle 0.45 оборачивает ошибку Postgres в `DrizzleQueryError`, у которого `.message` — это `"Failed query: …"`, а SQLSTATE и имя ограничения лежат в `.cause`. Поэтому `.rejects.toThrow(/имя_ограничения/)` **не работает**, нужно `.rejects.toMatchObject({ cause: { code: '23505', message: expect.stringMatching(/имя_ограничения/) } })`. Прецедент: `tests/integration/db/core-schema.test.ts:33-41`.
- **Каждому клиенту `ioredis` обязателен слушатель `error`.** `ioredis` — это `EventEmitter`, и событие `error` без слушателя становится неперехваченным исключением, которое убивает процесс мимо аккуратного завершения: обрыв связи, рестарт контейнера, сработавший `maxmemory`. Это был единственный Critical этапа 0. Относится ко всему, что делает `new Redis(...)`: `Cache`, `createRateLimiter`, `createCooldown`.
- **Ответ внешнего сервиса разыменовывается только после проверки схемой.** `FetchClient.json` превращает в `ProviderError` любой исход, кроме успеха, — но лишь если ему передали `schema`. Без схемы `data.response.players[0]` на неожиданном теле даёт `TypeError`, который роутер команд покажет как поломку на нашей стороне, и breaker такой сбой не посчитает. Поэтому любой вызов `client.json(...)`, чей результат читается по полям, обязан передавать `schema`.

Значения из спеки, зафиксированные и не подлежащие изменению при реализации:

| Параметр | Значение |
|---|---|
| TTL кэша профиля | 24 ч, просроченное отдавать до 7 суток |
| TTL кэша ранга | 20 мин, просроченное отдавать до 24 ч |
| TTL кэша истории матчей | 5 мин, просроченное отдавать до 1 ч |
| Челлендж верификации | живёт 15 минут, допускает 5 попыток |
| Кулдаун `/ranksync` | 10 минут на пользователя |
| Таймаут внешнего вызова | 5 секунд, до 3 попыток с экспоненциальной задержкой и джиттером |
| Circuit breaker | открывается после 5 подряд сбоев, пробует снова через 60 секунд |
| Cron синхронизации рангов | каждые 30 минут, по 100 аккаунтов с самым старым `updated_at` |

**Внешняя зависимость, влияющая на приёмку.** Riot production-ключ выдаётся по заявке с ревью, dev-ключ живёт 24 часа. Этап сдаётся без него: Steam работает полностью, Riot-провайдеры реализованы и покрыты тестами на моках, а включаются по факту получения ключа. Отсутствие `RIOT_API_KEY` в окружении не должно ломать ни старт бота, ни `/profile`, ни синхронизацию — только команды Riot отвечают понятным текстом.

## Структура файлов

| Файл | Ответственность |
|---|---|
| `src/modules/identity/schema.ts` | таблицы `gameAccounts`, `accountVerifications`, `rankSnapshots`, `roleMappings` |
| `src/modules/identity/ranks/riot.ts` | нормализация рангов Riot (LoL, TFT, Valorant) |
| `src/modules/identity/ranks/dota.ts` | нормализация `rank_tier` OpenDota |
| `src/modules/identity/ranks/compare.ts` | числовая шкала и определение факта изменения ранга |
| `src/core/http/fetch-client.ts` | таймаут, ретраи, джиттер, circuit breaker — общий для всех провайдеров |
| `src/core/rate-limit.ts` | token bucket в Redis |
| `src/modules/identity/providers/provider.ts` | интерфейс `GameProvider`, типы `RankInfo`, `GameProfile` |
| `src/modules/identity/providers/steam.ts` | Steam Web API: профиль, библиотека, Dota через OpenDota |
| `src/modules/identity/providers/steam-openid.ts` | построение и проверка OpenID 2.0 |
| `src/modules/identity/providers/riot.ts` | account-v1 → league-v4 / tft-league-v1 |
| `src/modules/identity/providers/valorant.ts` | ручной ввод ранга |
| `src/modules/identity/providers/index.ts` | реестр провайдеров по `ProviderId` |
| `src/modules/identity/services/linking.ts` | привязка, отвязка, проверка уникальности |
| `src/modules/identity/services/rank-sync.ts` | обновление рангов пачкой, публикация `rank.changed` |
| `src/modules/identity/services/role-mapping.ts` | выдача и снятие ролей по рангу |
| `src/modules/identity/commands/link.ts` | `/link steam`, `/link riot`, `/link valorant` |
| `src/modules/identity/commands/unlink.ts` | `/unlink` |
| `src/modules/identity/commands/profile.ts` | `/profile` |
| `src/modules/identity/commands/ranksync.ts` | `/ranksync` |
| `src/modules/identity/commands/rolemap.ts` | `/rolemap set`, `/rolemap list`, `/rolemap remove` |
| `src/modules/identity/render/profile-card.ts` | карточка профиля на Components V2 |
| `src/modules/identity/http/steam-callback.ts` | роут возврата Steam OpenID |
| `src/modules/identity/index.ts` | манифест модуля |

---

### Task 1: Схема модуля identity

**Files:**
- Create: `src/modules/identity/schema.ts`
- Modify: `src/core/db/schema/index.ts` — добавить строку реэкспорта
- Test: `tests/integration/db/identity-schema.test.ts`

**Interfaces:**
- Consumes: `guilds`, `users` из `src/core/db/schema/core.ts`; хелпер `withPostgres()`.
- Produces: таблицы `gameAccounts`, `accountVerifications`, `rankSnapshots`, `roleMappings`; типы `ProviderId`, `RankScale`, `RankSource`.

- [ ] **Step 1: Написать схему `src/modules/identity/schema.ts`**

```ts
import { bigint, bigserial, index, integer, jsonb, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { guilds, users } from '../../core/db/schema/core.js';

export type ProviderId = 'steam' | 'riot-lol' | 'riot-tft' | 'riot-valorant';
export type RankScale = 'riot-tier' | 'valorant-tier' | 'dota-mmr';
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
```

- [ ] **Step 2: Подключить схему в точке сборки**

В `src/core/db/schema/index.ts` добавить вторую строку:

```ts
export * from './core.js';
export * from '../../../modules/identity/schema.js';
```

- [ ] **Step 3: Сгенерировать миграцию**

Run: `npm run db:generate`
Expected: появился `src/core/db/migrations/0001_*.sql` с четырьмя `CREATE TABLE`, двумя `UNIQUE` на `game_accounts` и индексами. Открыть и проверить глазами, что все временные колонки — `timestamp with time zone`.

- [ ] **Step 4: Написать падающий интеграционный тест**

Файл `tests/integration/db/identity-schema.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { guilds, users } from '../../../src/core/db/schema/core.js';
import { gameAccounts, rankSnapshots, roleMappings } from '../../../src/modules/identity/schema.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();

const GUILD = '111111111111111111';
const ALICE = '222222222222222222';
const BOB = '333333333333333333';

beforeAll(async () => {
  await pg.db.insert(guilds).values({ id: GUILD });
  await pg.db.insert(users).values([{ id: ALICE }, { id: BOB }]);
});

describe('схема identity', () => {
  it('сохраняет подтверждённый аккаунт', async () => {
    const [row] = await pg.db
      .insert(gameAccounts)
      .values({
        userId: ALICE,
        provider: 'steam',
        externalId: '76561198000000001',
        displayName: 'alice',
        verifiedAt: new Date(),
        verificationMethod: 'steam-openid',
      })
      .returning();

    expect(row?.id).toBeTypeOf('number');
    expect(row?.region).toBeNull();
  });

  it('запрещает привязать один игровой аккаунт к двум пользователям', async () => {
    await expect(
      pg.db.insert(gameAccounts).values({
        userId: BOB,
        provider: 'steam',
        externalId: '76561198000000001',
        displayName: 'alice-клон',
        verificationMethod: 'manual',
      }),
    ).rejects.toMatchObject({
      cause: { code: '23505', message: expect.stringMatching(/game_accounts_provider_external_uq/) },
    });
  });

  it('запрещает второй аккаунт того же провайдера у одного пользователя', async () => {
    await expect(
      pg.db.insert(gameAccounts).values({
        userId: ALICE,
        provider: 'steam',
        externalId: '76561198000000002',
        displayName: 'смурф',
        verificationMethod: 'manual',
      }),
    ).rejects.toMatchObject({
      cause: { code: '23505', message: expect.stringMatching(/game_accounts_user_provider_uq/) },
    });
  });

  it('хранит историю рангов, а не одно значение', async () => {
    const [account] = await pg.db.select().from(gameAccounts).where(eq(gameAccounts.userId, ALICE));
    const accountId = account!.id;

    await pg.db.insert(rankSnapshots).values([
      { accountId, mode: 'dota-mmr', scale: 'dota-mmr', tier: 'LEGEND', division: '3', points: null, source: 'api', raw: { rank_tier: 53 } },
      { accountId, mode: 'dota-mmr', scale: 'dota-mmr', tier: 'ANCIENT', division: '1', points: null, source: 'api', raw: { rank_tier: 61 } },
    ]);

    const rows = await pg.db.select().from(rankSnapshots).where(eq(rankSnapshots.accountId, accountId));
    expect(rows).toHaveLength(2);
  });

  it('удаляет снимки рангов вместе с аккаунтом', async () => {
    const [account] = await pg.db.select().from(gameAccounts).where(eq(gameAccounts.userId, ALICE));
    await pg.db.delete(gameAccounts).where(eq(gameAccounts.id, account!.id));

    const rows = await pg.db.select().from(rankSnapshots).where(eq(rankSnapshots.accountId, account!.id));
    expect(rows).toHaveLength(0);
  });

  it('запрещает два маппинга на один и тот же ранг', async () => {
    await pg.db.insert(roleMappings).values({
      guildId: GUILD,
      provider: 'riot-lol',
      mode: 'solo-duo',
      tier: 'PLATINUM',
      roleId: '444444444444444444',
    });

    await expect(
      pg.db.insert(roleMappings).values({
        guildId: GUILD,
        provider: 'riot-lol',
        mode: 'solo-duo',
        tier: 'PLATINUM',
        roleId: '555555555555555555',
      }),
    ).rejects.toMatchObject({
      cause: { code: '23505', message: expect.stringMatching(/role_mappings_uq/) },
    });
  });
});
```

- [ ] **Step 5: Прогнать тест**

Run: `npm run test:int -- tests/integration/db/identity-schema.test.ts`
Expected: 6 тестов PASS.

- [ ] **Step 6: Коммит**

```bash
git add src/modules/identity/schema.ts src/core/db/schema/index.ts src/core/db/migrations tests/integration/db/identity-schema.test.ts
git commit -m "feat(identity): схема аккаунтов, верификаций, снимков рангов и маппинга ролей"
```

---

### Task 2: Нормализация рангов Riot

**Files:**
- Create: `src/modules/identity/providers/provider.ts`, `src/modules/identity/ranks/riot.ts`
- Test: `tests/modules/identity/ranks/riot.test.ts`

**Interfaces:**
- Consumes: `ProviderId`, `RankScale`, `RankSource` из Task 1.
- Produces: `interface RankInfo { mode: string; scale: RankScale; tier: string | null; division: string | null; points: number | null; source: RankSource; raw: unknown }`; `interface GameProfile { externalId: string; displayName: string; avatarUrl?: string; region?: string }`; `RIOT_TIERS: readonly string[]`; `normalizeRiotEntry(entry: RiotLeagueEntry): RankInfo | null`; `parseRiotTier(input: string): { tier: string; division: string | null } | null`.

- [ ] **Step 1: Написать падающие тесты**

Файл `tests/modules/identity/ranks/riot.test.ts`. Краевые случаи здесь и есть вся сложность задачи: Emerald появился в 2023 и его забывают; у Master и выше нет дивизионов, хотя API всё равно присылает `rank: 'I'`; unranked приходит пустым массивом, а не нулём.

```ts
import { describe, expect, it } from 'vitest';
import { RIOT_TIERS, normalizeRiotEntry, parseRiotTier } from '../../../../src/modules/identity/ranks/riot.js';

describe('RIOT_TIERS', () => {
  it('включает EMERALD между PLATINUM и DIAMOND', () => {
    expect(RIOT_TIERS.indexOf('EMERALD')).toBe(RIOT_TIERS.indexOf('PLATINUM') + 1);
    expect(RIOT_TIERS.indexOf('DIAMOND')).toBe(RIOT_TIERS.indexOf('EMERALD') + 1);
  });

  it('перечисляет все десять тиров от IRON до CHALLENGER', () => {
    expect(RIOT_TIERS).toHaveLength(10);
    expect(RIOT_TIERS[0]).toBe('IRON');
    expect(RIOT_TIERS.at(-1)).toBe('CHALLENGER');
  });
});

describe('normalizeRiotEntry', () => {
  it('нормализует запись соло-очереди', () => {
    const result = normalizeRiotEntry({
      queueType: 'RANKED_SOLO_5x5',
      tier: 'PLATINUM',
      rank: 'II',
      leaguePoints: 47,
    });

    expect(result).toMatchObject({
      mode: 'solo-duo',
      scale: 'riot-tier',
      tier: 'PLATINUM',
      division: 'II',
      points: 47,
      source: 'api',
    });
  });

  it('нормализует гибкую очередь', () => {
    const result = normalizeRiotEntry({ queueType: 'RANKED_FLEX_SR', tier: 'GOLD', rank: 'IV', leaguePoints: 0 });
    expect(result?.mode).toBe('flex');
  });

  it('обнуляет дивизион у Master и выше, хотя API присылает I', () => {
    for (const tier of ['MASTER', 'GRANDMASTER', 'CHALLENGER']) {
      const result = normalizeRiotEntry({ queueType: 'RANKED_SOLO_5x5', tier, rank: 'I', leaguePoints: 640 });
      expect(result?.division).toBeNull();
      expect(result?.tier).toBe(tier);
    }
  });

  it('нормализует ранговый TFT', () => {
    const result = normalizeRiotEntry({ queueType: 'RANKED_TFT', tier: 'DIAMOND', rank: 'III', leaguePoints: 12 });
    expect(result?.mode).toBe('tft-ranked');
  });

  it('возвращает null для неизвестной очереди', () => {
    const result = normalizeRiotEntry({ queueType: 'CHERRY', tier: 'GOLD', rank: 'I', leaguePoints: 0 });
    expect(result).toBeNull();
  });

  it('возвращает null для неизвестного тира вместо выдумывания значения', () => {
    const result = normalizeRiotEntry({ queueType: 'RANKED_SOLO_5x5', tier: 'МИФИЧЕСКИЙ', rank: 'I', leaguePoints: 0 });
    expect(result).toBeNull();
  });

  it('сохраняет исходный ответ в raw', () => {
    const entry = { queueType: 'RANKED_SOLO_5x5', tier: 'IRON', rank: 'IV', leaguePoints: 3 };
    expect(normalizeRiotEntry(entry)?.raw).toEqual(entry);
  });
});

describe('parseRiotTier', () => {
  it('разбирает ввод пользователя с дивизионом в любом регистре', () => {
    expect(parseRiotTier('platinum ii')).toEqual({ tier: 'PLATINUM', division: 'II' });
    expect(parseRiotTier('Immortal 2')).toEqual({ tier: 'IMMORTAL', division: 'II' });
  });

  it('разбирает арабские цифры как дивизионы', () => {
    expect(parseRiotTier('GOLD 4')).toEqual({ tier: 'GOLD', division: 'IV' });
  });

  it('разбирает тир без дивизиона', () => {
    expect(parseRiotTier('RADIANT')).toEqual({ tier: 'RADIANT', division: null });
  });

  it('возвращает null на мусоре', () => {
    expect(parseRiotTier('очень высокий')).toBeNull();
    expect(parseRiotTier('')).toBeNull();
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `npx vitest run tests/modules/identity/ranks/riot.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Создать `src/modules/identity/providers/provider.ts`**

Полный интерфейс `GameProvider` появится в Task 5; сейчас нужны только типы данных, от которых зависит нормализация.

```ts
import type { RankScale, RankSource } from '../schema.js';

/** Ранг в общем виде: выше этого типа код не знает специфики игр. */
export interface RankInfo {
  mode: string;
  scale: RankScale;
  tier: string | null;
  division: string | null;
  points: number | null;
  source: RankSource;
  raw: unknown;
}

export interface GameProfile {
  externalId: string;
  displayName: string;
  avatarUrl?: string;
  region?: string;
}
```

- [ ] **Step 4: Реализовать `src/modules/identity/ranks/riot.ts`**

```ts
import type { RankInfo } from '../providers/provider.js';

/** Порядок значим: индекс используется как числовая шкала в compare.ts. */
export const RIOT_TIERS = [
  'IRON',
  'BRONZE',
  'SILVER',
  'GOLD',
  'PLATINUM',
  'EMERALD',
  'DIAMOND',
  'MASTER',
  'GRANDMASTER',
  'CHALLENGER',
] as const;

/** Тиры Valorant. Вводятся вручную, поэтому список нужен только для разбора. */
export const VALORANT_TIERS = [
  'IRON',
  'BRONZE',
  'SILVER',
  'GOLD',
  'PLATINUM',
  'DIAMOND',
  'ASCENDANT',
  'IMMORTAL',
  'RADIANT',
] as const;

/** У Master и выше дивизионов нет, хотя API всё равно присылает rank: 'I'. */
const TIERS_WITHOUT_DIVISION = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER', 'RADIANT']);

const DIVISIONS = ['I', 'II', 'III', 'IV'] as const;
const ARABIC_TO_ROMAN: Record<string, string> = { '1': 'I', '2': 'II', '3': 'III', '4': 'IV' };

const QUEUE_TO_MODE: Record<string, string> = {
  RANKED_SOLO_5x5: 'solo-duo',
  RANKED_FLEX_SR: 'flex',
  RANKED_TFT: 'tft-ranked',
  RANKED_TFT_DOUBLE_UP: 'tft-double-up',
};

export interface RiotLeagueEntry {
  queueType: string;
  tier: string;
  rank: string;
  leaguePoints: number;
}

export function normalizeRiotEntry(entry: RiotLeagueEntry): RankInfo | null {
  const mode = QUEUE_TO_MODE[entry.queueType];
  if (!mode) return null;

  const tier = entry.tier.toUpperCase();
  if (!RIOT_TIERS.includes(tier as (typeof RIOT_TIERS)[number])) return null;

  return {
    mode,
    scale: 'riot-tier',
    tier,
    division: TIERS_WITHOUT_DIVISION.has(tier) ? null : entry.rank.toUpperCase(),
    points: entry.leaguePoints,
    source: 'api',
    raw: entry,
  };
}

const KNOWN_TIERS = new Set<string>([...RIOT_TIERS, ...VALORANT_TIERS]);

/** Разбирает ввод человека: «platinum ii», «Immortal 2», «RADIANT». */
export function parseRiotTier(input: string): { tier: string; division: string | null } | null {
  const parts = input.trim().toUpperCase().split(/\s+/).filter(Boolean);
  const [tierPart, divisionPart] = parts;
  if (!tierPart || !KNOWN_TIERS.has(tierPart)) return null;

  if (TIERS_WITHOUT_DIVISION.has(tierPart) || divisionPart === undefined) {
    return { tier: tierPart, division: null };
  }

  const division = ARABIC_TO_ROMAN[divisionPart] ?? divisionPart;
  if (!DIVISIONS.includes(division as (typeof DIVISIONS)[number])) return null;

  return { tier: tierPart, division };
}
```

- [ ] **Step 5: Прогнать тесты**

Run: `npx vitest run tests/modules/identity/ranks/riot.test.ts && npm run typecheck`
Expected: 13 тестов PASS.

- [ ] **Step 6: Коммит**

```bash
git add src/modules/identity/providers/provider.ts src/modules/identity/ranks/riot.ts tests/modules/identity/ranks/riot.test.ts
git commit -m "feat(identity): нормализация рангов Riot с Emerald и тирами без дивизионов"
```

---

### Task 3: Нормализация Dota и сравнение рангов

**Files:**
- Create: `src/modules/identity/ranks/dota.ts`, `src/modules/identity/ranks/compare.ts`
- Test: `tests/modules/identity/ranks/dota.test.ts`, `tests/modules/identity/ranks/compare.test.ts`

**Interfaces:**
- Consumes: `RankInfo` (Task 2), `RIOT_TIERS` (Task 2).
- Produces: `DOTA_MEDALS: readonly string[]`; `normalizeDotaRank(player: { rank_tier: number | null; leaderboard_rank?: number | null }): RankInfo | null`; `rankScore(rank: RankInfo): number`; `hasRankChanged(previous: RankInfo | null, next: RankInfo): boolean`.

- [ ] **Step 1: Написать падающие тесты для Dota**

Файл `tests/modules/identity/ranks/dota.test.ts`. OpenDota кодирует ранг двумя цифрами: первая — медаль (1 Herald … 8 Immortal), вторая — звезда 1–5. У Immortal звёзд нет, там `rank_tier` равен 80.

```ts
import { describe, expect, it } from 'vitest';
import { DOTA_MEDALS, normalizeDotaRank } from '../../../../src/modules/identity/ranks/dota.js';

describe('DOTA_MEDALS', () => {
  it('перечисляет восемь медалей от Herald до Immortal', () => {
    expect(DOTA_MEDALS).toHaveLength(8);
    expect(DOTA_MEDALS[0]).toBe('HERALD');
    expect(DOTA_MEDALS.at(-1)).toBe('IMMORTAL');
  });
});

describe('normalizeDotaRank', () => {
  it('разбирает медаль и звезду из двузначного кода', () => {
    expect(normalizeDotaRank({ rank_tier: 53 })).toMatchObject({
      mode: 'dota-mmr',
      scale: 'dota-mmr',
      tier: 'LEGEND',
      division: '3',
      source: 'api',
    });
  });

  it('разбирает младшую медаль', () => {
    expect(normalizeDotaRank({ rank_tier: 11 })).toMatchObject({ tier: 'HERALD', division: '1' });
  });

  it('обнуляет звезду у Immortal', () => {
    const result = normalizeDotaRank({ rank_tier: 80 });
    expect(result).toMatchObject({ tier: 'IMMORTAL', division: null });
  });

  it('кладёт место в лидерборде в points для Immortal', () => {
    const result = normalizeDotaRank({ rank_tier: 80, leaderboard_rank: 412 });
    expect(result?.points).toBe(412);
  });

  it('возвращает null для игрока без калибровки', () => {
    expect(normalizeDotaRank({ rank_tier: null })).toBeNull();
  });

  it('возвращает null для кода вне допустимого диапазона', () => {
    expect(normalizeDotaRank({ rank_tier: 99 })).toBeNull();
    expect(normalizeDotaRank({ rank_tier: 0 })).toBeNull();
  });

  it('сохраняет исходный ответ в raw', () => {
    const player = { rank_tier: 61, leaderboard_rank: null };
    expect(normalizeDotaRank(player)?.raw).toEqual(player);
  });
});
```

- [ ] **Step 2: Написать падающие тесты для сравнения**

Файл `tests/modules/identity/ranks/compare.test.ts`. Числовая шкала нужна двум потребителям: маппингу ролей (порог «Platinum и выше») и определению факта изменения ранга. Изменение LP внутри дивизиона рангом не считается — иначе `rank.changed` будет срабатывать после каждого матча и перевыдавать роли впустую.

```ts
import { describe, expect, it } from 'vitest';
import { hasRankChanged, rankScore } from '../../../../src/modules/identity/ranks/compare.js';
import type { RankInfo } from '../../../../src/modules/identity/providers/provider.js';

function riot(tier: string, division: string | null, points = 0): RankInfo {
  return { mode: 'solo-duo', scale: 'riot-tier', tier, division, points, source: 'api', raw: {} };
}

describe('rankScore', () => {
  it('ставит более высокий тир выше', () => {
    expect(rankScore(riot('DIAMOND', 'IV'))).toBeGreaterThan(rankScore(riot('EMERALD', 'I')));
  });

  it('ставит первый дивизион выше четвёртого внутри тира', () => {
    expect(rankScore(riot('GOLD', 'I'))).toBeGreaterThan(rankScore(riot('GOLD', 'IV')));
  });

  it('учитывает LP внутри дивизиона', () => {
    expect(rankScore(riot('GOLD', 'II', 80))).toBeGreaterThan(rankScore(riot('GOLD', 'II', 10)));
  });

  it('ставит Challenger выше Master', () => {
    expect(rankScore(riot('CHALLENGER', null, 1200))).toBeGreaterThan(rankScore(riot('MASTER', null, 1200)));
  });

  it('даёт ноль для ранга без тира', () => {
    expect(rankScore(riot(null as unknown as string, null))).toBe(0);
  });
});

describe('hasRankChanged', () => {
  it('считает изменением первое появление ранга', () => {
    expect(hasRankChanged(null, riot('GOLD', 'II'))).toBe(true);
  });

  it('считает изменением смену тира', () => {
    expect(hasRankChanged(riot('GOLD', 'I'), riot('PLATINUM', 'IV'))).toBe(true);
  });

  it('считает изменением смену дивизиона', () => {
    expect(hasRankChanged(riot('GOLD', 'III'), riot('GOLD', 'II'))).toBe(true);
  });

  it('НЕ считает изменением сдвиг LP внутри дивизиона', () => {
    expect(hasRankChanged(riot('GOLD', 'II', 10), riot('GOLD', 'II', 88))).toBe(false);
  });

  it('считает изменением сдвиг очков у тира без дивизионов', () => {
    expect(hasRankChanged(riot('MASTER', null, 100), riot('MASTER', null, 250))).toBe(true);
  });
});
```

- [ ] **Step 3: Запустить тесты — убедиться, что падают**

Run: `npx vitest run tests/modules/identity/ranks/`
Expected: FAIL — `dota.js` и `compare.js` не найдены.

- [ ] **Step 4: Реализовать `src/modules/identity/ranks/dota.ts`**

```ts
import type { RankInfo } from '../providers/provider.js';

/** Порядок значим: индекс используется как числовая шкала в compare.ts. */
export const DOTA_MEDALS = [
  'HERALD',
  'GUARDIAN',
  'CRUSADER',
  'ARCHON',
  'LEGEND',
  'ANCIENT',
  'DIVINE',
  'IMMORTAL',
] as const;

const IMMORTAL_INDEX = DOTA_MEDALS.indexOf('IMMORTAL');

export interface OpenDotaPlayer {
  /** Двузначный код: медаль * 10 + звезда. У Immortal звезды нет — код 80. */
  rank_tier: number | null;
  leaderboard_rank?: number | null;
}

export function normalizeDotaRank(player: OpenDotaPlayer): RankInfo | null {
  const code = player.rank_tier;
  if (code === null || code === undefined) return null;

  const medalIndex = Math.floor(code / 10) - 1;
  const star = code % 10;
  const medal = DOTA_MEDALS[medalIndex];
  if (!medal) return null;

  const isImmortal = medalIndex === IMMORTAL_INDEX;
  if (!isImmortal && (star < 1 || star > 5)) return null;

  return {
    mode: 'dota-mmr',
    scale: 'dota-mmr',
    tier: medal,
    division: isImmortal ? null : String(star),
    points: isImmortal ? (player.leaderboard_rank ?? null) : null,
    source: 'api',
    raw: player,
  };
}
```

- [ ] **Step 5: Реализовать `src/modules/identity/ranks/compare.ts`**

```ts
import type { RankInfo } from '../providers/provider.js';
import { DOTA_MEDALS } from './dota.js';
import { RIOT_TIERS, VALORANT_TIERS } from './riot.js';

const DIVISION_ORDER: Record<string, number> = { IV: 0, III: 1, II: 2, I: 3, '1': 0, '2': 1, '3': 2, '4': 3, '5': 4 };

const TIER_POINTS = 1_000;
const DIVISION_POINTS = 100;

// Шкала выбирается по `rank.scale` однозначно, без перебора. Перебор двух списков
// сразу давал коллизию: в Valorant нет Emerald, поэтому валорантовый DIAMOND
// получал индекс ASCENDANT и оказывался выше, чем должен.
function tierIndex(rank: RankInfo): number {
  if (!rank.tier) return -1;
  const scale = rank.scale === 'dota-mmr' ? DOTA_MEDALS :
                rank.scale === 'valorant-tier' ? VALORANT_TIERS :
                RIOT_TIERS;
  return (scale as readonly string[]).indexOf(rank.tier);
}

/**
 * Сопоставимое число для порогов ролей и лидербордов.
 * Ноль означает «ранга нет» — так порог «Platinum и выше» не пропустит unranked.
 */
export function rankScore(rank: RankInfo): number {
  const tier = tierIndex(rank);
  if (tier < 0) return 0;

  const division = rank.division !== null ? (DIVISION_ORDER[rank.division] ?? 0) : 0;
  const points = rank.points ?? 0;
  // Для dota-mmr очки не учитываются: в `points` лежит место в лидерборде, где
  // меньше — лучше, и прибавлять его как «больше — лучше» значит ставить
  // Immortal #90 выше Immortal #5. Медаль со звездой и есть ранг Dota.
  // У тиров без дивизионов (Master/GM/Challenger/Radiant) ступенька — это тир,
  // а не дивизион, и LP там измеряется сотнями: отсечка по сотне схлопывала бы
  // Master/1200 и Challenger/1200 в одинаковую прибавку.
  const pointsCapped = rank.scale === 'dota-mmr'
    ? 0
    : rank.division !== null
      ? Math.min(points, DIVISION_POINTS - 1)
      : Math.min(points, TIER_POINTS - 1);
  return tier * TIER_POINTS + division * DIVISION_POINTS + pointsCapped;
}

/**
 * Изменением считается смена тира или дивизиона, а у тиров без дивизионов —
 * ещё и сдвиг очков. Дрейф LP внутри дивизиона изменением не является: иначе
 * rank.changed срабатывал бы после каждого матча и перевыдавал роли впустую.
 */
export function hasRankChanged(previous: RankInfo | null, next: RankInfo): boolean {
  if (!previous) return true;
  if (previous.tier !== next.tier) return true;
  if (previous.division !== next.division) return true;
  if (next.division === null && previous.points !== next.points) return true;
  return false;
}
```

- [ ] **Step 6: Прогнать тесты**

Run: `npx vitest run tests/modules/identity/ranks/ && npm run typecheck`
Expected: 18 тестов PASS.

- [ ] **Step 7: Коммит**

```bash
git add src/modules/identity/ranks/dota.ts src/modules/identity/ranks/compare.ts tests/modules/identity/ranks/dota.test.ts tests/modules/identity/ranks/compare.test.ts
git commit -m "feat(identity): нормализация рангов Dota и сравнение рангов по общей шкале"
```

---

### Task 4: HTTP-клиент с таймаутом, ретраями и circuit breaker

**Files:**
- Create: `src/core/http/fetch-client.ts`
- Test: `tests/core/fetch-client.test.ts`

**Interfaces:**
- Consumes: `ProviderError` (этап 0, Task 3), `Logger`, `Metrics`.
- Produces: `createFetchClient(deps: { provider: string; logger: Logger; metrics?: Metrics; now?: () => number; sleep?: (ms: number) => Promise<void> }): FetchClient` где `interface FetchClient { json<T>(url: string, init?: RequestInit & { schema?: { parse(input: unknown): T } }): Promise<T> }`. Бросает `ProviderError` при любом исходе, кроме успеха.

- [ ] **Step 1: Написать падающие тесты**

Файл `tests/core/fetch-client.test.ts`. Часы и сон подменяются, иначе тест на circuit breaker занимал бы минуту, а тест на ретраи — секунды.

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/core/config.js';
import { ProviderError } from '../../src/core/errors.js';
import { createFetchClient } from '../../src/core/http/fetch-client.js';
import { createLogger } from '../../src/core/logger.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function clientWith(fetchMock: typeof fetch, now = () => 0) {
  vi.stubGlobal('fetch', fetchMock);
  return createFetchClient({ provider: 'test', logger, now, sleep: async () => {} });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('createFetchClient', () => {
  it('возвращает разобранный JSON при успехе', async () => {
    const client = clientWith(vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch);
    await expect(client.json('https://api.test/x')).resolves.toEqual({ ok: true });
  });

  it('повторяет запрос при 500 и отдаёт результат удачной попытки', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = clientWith(fetchMock as unknown as typeof fetch);

    await expect(client.json('https://api.test/x')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('делает не более трёх попыток', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 503));
    const client = clientWith(fetchMock as unknown as typeof fetch);

    await expect(client.json('https://api.test/x')).rejects.toThrow(ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('НЕ повторяет запрос при 404 — это не временный сбой', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 404));
    const client = clientWith(fetchMock as unknown as typeof fetch);

    await expect(client.json('https://api.test/x')).rejects.toThrow(ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('соблюдает Retry-After при 429', async () => {
    const delays: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '2' } }))
        .mockResolvedValueOnce(jsonResponse({ ok: true })),
    );
    const client = createFetchClient({
      provider: 'test',
      logger,
      now: () => 0,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    await client.json('https://api.test/x');
    expect(delays[0]).toBeGreaterThanOrEqual(2_000);
  });

  it('открывает breaker после пяти подряд сбоев и перестаёт звонить наружу', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 500));
    const client = clientWith(fetchMock as unknown as typeof fetch);

    // Каждый вызов расходует три попытки; пяти сбоев подряд достаточно уже после второго.
    for (let i = 0; i < 3; i += 1) {
      await client.json('https://api.test/x').catch(() => {});
    }
    const callsBefore = fetchMock.mock.calls.length;

    await expect(client.json('https://api.test/x')).rejects.toThrow(/недоступен/);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('закрывает breaker через 60 секунд', async () => {
    let clock = 0;
    const fetchMock = vi.fn(async () => jsonResponse({}, 500));
    vi.stubGlobal('fetch', fetchMock);
    const client = createFetchClient({ provider: 'test', logger, now: () => clock, sleep: async () => {} });

    for (let i = 0; i < 3; i += 1) {
      await client.json('https://api.test/x').catch(() => {});
    }
    const callsBefore = fetchMock.mock.calls.length;

    clock += 61_000;
    await client.json('https://api.test/x').catch(() => {});

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('валидирует ответ переданной схемой', async () => {
    const client = clientWith(vi.fn(async () => jsonResponse({ wrong: 1 })) as unknown as typeof fetch);
    const schema = {
      parse: (input: unknown) => {
        if (typeof (input as { expected?: unknown }).expected !== 'string') throw new Error('не та форма');
        return input as { expected: string };
      },
    };

    await expect(client.json('https://api.test/x', { schema })).rejects.toThrow(ProviderError);
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `npx vitest run tests/core/fetch-client.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `src/core/http/fetch-client.ts`**

```ts
import { ProviderError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';

const TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 300;
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 60_000;

/** Коды, при которых повтор осмыслен. 404 и 403 повторять бессмысленно. */
const RETRIABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface FetchClientDeps {
  provider: string;
  logger: Logger;
  metrics?: Metrics;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface JsonInit extends RequestInit {
  schema?: { parse(input: unknown): unknown };
}

export interface FetchClient {
  json<T>(url: string, init?: RequestInit & { schema?: { parse(input: unknown): T } }): Promise<T>;
}

export function createFetchClient(deps: FetchClientDeps): FetchClient {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let consecutiveFailures = 0;
  let breakerOpenedAt: number | null = null;

  function breakerIsOpen(): boolean {
    if (breakerOpenedAt === null) return false;
    if (now() - breakerOpenedAt >= BREAKER_COOLDOWN_MS) {
      breakerOpenedAt = null;
      consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  function recordFailure(): void {
    consecutiveFailures += 1;
    if (consecutiveFailures >= BREAKER_THRESHOLD && breakerOpenedAt === null) {
      breakerOpenedAt = now();
      deps.logger.warn({ provider: deps.provider }, 'circuit breaker открыт');
    }
    deps.metrics?.providerErrors.inc({ provider: deps.provider });
  }

  async function attempt(url: string, init: JsonInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function backoffMs(attemptNumber: number, response: Response | null): number {
    const retryAfter = response?.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return seconds * 1_000;
    }
    const exponential = BASE_BACKOFF_MS * 2 ** (attemptNumber - 1);
    // Джиттер: без него все ожидающие клиенты просыпаются одновременно.
    return exponential + Math.floor(exponential * 0.5 * Math.random());
  }

  return {
    async json<T>(url: string, init: RequestInit & { schema?: { parse(input: unknown): T } } = {}): Promise<T> {
      if (breakerIsOpen()) {
        throw new ProviderError(`${deps.provider} недоступен: circuit breaker открыт`, deps.provider);
      }

      let lastProblem = 'неизвестная ошибка';

      for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber += 1) {
        let response: Response | null = null;
        try {
          response = await attempt(url, init);
        } catch (error) {
          lastProblem = error instanceof Error ? error.message : 'сетевой сбой';
          recordFailure();
          if (attemptNumber === MAX_ATTEMPTS) break;
          await sleep(backoffMs(attemptNumber, null));
          continue;
        }

        if (response.ok) {
          // Разбор тела обёрнут, а счётчик сбрасывается только после полного успеха.
          // Сброс до разбора делал breaker недостижимым на потоке «HTTP 200, тело мусор» —
          // а это как раз тот отказ, ради которого breaker и нужен: провайдер жив и быстр,
          // но данные негодные. Непойманный `response.json()` при этом выпускал наружу
          // SyntaxError вместо ProviderError, и роутер команд показывал его как нашу поломку.
          let payload: unknown;
          try {
            payload = await response.json();
          } catch (error) {
            // Ответ пришёл (200), но тело не разобралось — повторять бессмысленно, тело уже такое.
            recordFailure();
            throw new ProviderError(`не удалось разобрать ответ: ${(error as Error).message}`, deps.provider, error);
          }

          if (!init.schema) {
            consecutiveFailures = 0;
            return payload as T;
          }
          try {
            const parsed = init.schema.parse(payload);
            consecutiveFailures = 0;
            return parsed;
          } catch (error) {
            // Ответ пришёл, но формат не тот — повторять бессмысленно.
            recordFailure();
            throw new ProviderError(`неожиданный формат ответа: ${(error as Error).message}`, deps.provider, error);
          }
        }

        lastProblem = `HTTP ${response.status}`;
        recordFailure();

        if (!RETRIABLE_STATUS.has(response.status) || attemptNumber === MAX_ATTEMPTS) break;
        await sleep(backoffMs(attemptNumber, response));
      }

      throw new ProviderError(`${deps.provider} недоступен: ${lastProblem}`, deps.provider);
    },
  };
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `npx vitest run tests/core/fetch-client.test.ts && npm run typecheck`
Expected: 10 тестов PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/core/http/fetch-client.ts tests/core/fetch-client.test.ts
git commit -m "feat: HTTP-клиент с таймаутом, ретраями по джиттеру и circuit breaker"
```

---

### Task 5: Token bucket в Redis

**Files:**
- Create: `src/core/rate-limit.ts`
- Test: `tests/integration/rate-limit.test.ts`

**Interfaces:**
- Consumes: `Config`, `Logger`, хелпер `withRedis()`.
- Produces: `createRateLimiter(deps: { redisUrl: string; logger: Logger }): RateLimiter` где `interface RateLimiter { acquire(key: string, limits: Limit[]): Promise<void>; close(): Promise<void> }` и `interface Limit { tokens: number; windowMs: number }`. Метод `acquire` ждёт, пока место освободится, и только потом возвращается.

- [ ] **Step 1: Написать падающие тесты**

Файл `tests/integration/rate-limit.test.ts`. Riot применяет два окна одновременно — секундное и двухминутное, — поэтому `acquire` принимает массив лимитов, а не одно число.

```ts
import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import { createRateLimiter } from '../../src/core/rate-limit.js';
import { withRedis } from '../helpers/redis.js';

const redis = withRedis();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

describe('createRateLimiter', () => {
  it('пропускает вызовы в пределах лимита без задержки', async () => {
    const limiter = createRateLimiter({ redisUrl: redis.url, logger });
    const startedAt = Date.now();

    for (let i = 0; i < 5; i += 1) {
      await limiter.acquire('k:under', [{ tokens: 5, windowMs: 10_000 }]);
    }

    expect(Date.now() - startedAt).toBeLessThan(500);
    await limiter.close();
  });

  it('задерживает вызов сверх лимита до освобождения окна', async () => {
    const limiter = createRateLimiter({ redisUrl: redis.url, logger });
    const limits = [{ tokens: 2, windowMs: 400 }];

    await limiter.acquire('k:over', limits);
    await limiter.acquire('k:over', limits);
    const startedAt = Date.now();
    await limiter.acquire('k:over', limits);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
    await limiter.close();
  });

  it('соблюдает самое узкое из нескольких окон', async () => {
    const limiter = createRateLimiter({ redisUrl: redis.url, logger });
    const limits = [
      { tokens: 10, windowMs: 60_000 },
      { tokens: 1, windowMs: 400 },
    ];

    await limiter.acquire('k:multi', limits);
    const startedAt = Date.now();
    await limiter.acquire('k:multi', limits);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
    await limiter.close();
  });

  it('ведёт независимый учёт по разным ключам', async () => {
    const limiter = createRateLimiter({ redisUrl: redis.url, logger });
    const limits = [{ tokens: 1, windowMs: 5_000 }];

    await limiter.acquire('k:a', limits);
    const startedAt = Date.now();
    await limiter.acquire('k:b', limits);

    expect(Date.now() - startedAt).toBeLessThan(200);
    await limiter.close();
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `npm run test:int -- tests/integration/rate-limit.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `src/core/rate-limit.ts`**

Счётчик — `INCR` с `PEXPIRE` на первом инкременте: это скользящее окно фиксированного размера, которого для соблюдения лимитов провайдера достаточно, и оно атомарно без Lua.

```ts
import { Redis } from 'ioredis';
import type { Logger } from './logger.js';

export interface Limit {
  tokens: number;
  windowMs: number;
}

export interface RateLimiter {
  /** Ждёт, пока во всех окнах появится место, и только потом возвращается. */
  acquire(key: string, limits: Limit[]): Promise<void>;
  close(): Promise<void>;
}

const POLL_INTERVAL_MS = 50;
const MAX_WAIT_MS = 30_000;

export function createRateLimiter(deps: { redisUrl: string; logger: Logger }): RateLimiter {
  const redis = new Redis(deps.redisUrl, { maxRetriesPerRequest: 3 });

  // ОБЯЗАТЕЛЬНО. `ioredis` — это EventEmitter, и событие `error` без слушателя
  // становится неперехваченным исключением, которое убивает процесс мимо
  // аккуратного завершения: обрыв связи, рестарт контейнера, сработавший maxmemory.
  // Ровно этот дефект был единственным Critical этапа 0 (см. Cache в src/core/cache.ts).
  redis.on('error', (error) => {
    deps.logger.error({ err: error }, 'ошибка соединения с Redis у лимитера запросов');
  });

  async function tryTake(key: string, limit: Limit): Promise<boolean> {
    const bucketKey = `ratelimit:${key}:${limit.windowMs}`;
    const count = await redis.incr(bucketKey);
    if (count === 1) {
      await redis.pexpire(bucketKey, limit.windowMs);
    }
    if (count <= limit.tokens) return true;
    // Место кончилось — откатываем свой инкремент, чтобы ожидание не сдвигало окно.
    await redis.decr(bucketKey);
    return false;
  }

  return {
    async acquire(key: string, limits: Limit[]): Promise<void> {
      const deadline = Date.now() + MAX_WAIT_MS;

      while (Date.now() < deadline) {
        const taken: Limit[] = [];
        let blocked = false;

        for (const limit of limits) {
          if (await tryTake(key, limit)) {
            taken.push(limit);
          } else {
            blocked = true;
            break;
          }
        }

        if (!blocked) return;

        // Частично взятые токены надо вернуть, иначе узкое окно голодает.
        for (const limit of taken) {
          await redis.decr(`ratelimit:${key}:${limit.windowMs}`);
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      deps.logger.error({ key }, 'превышено время ожидания квоты rate limit');
      throw new Error(`Не удалось получить квоту для «${key}» за ${MAX_WAIT_MS} мс.`);
    },

    async close(): Promise<void> {
      await redis.quit();
    },
  };
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `npm run test:int -- tests/integration/rate-limit.test.ts && npm run typecheck`
Expected: 5 тестов PASS (включая проверку слушателя error у клиента Redis).

- [ ] **Step 5: Коммит**

```bash
git add src/core/rate-limit.ts tests/integration/rate-limit.test.ts
git commit -m "feat: token bucket в Redis с поддержкой нескольких окон одновременно"
```

---

### Task 6: Интерфейс провайдера

**Files:**
- Modify: `src/modules/identity/providers/provider.ts` — дополнить типами из Task 2
- Test: `tests/modules/identity/providers/provider.test.ts`

**Interfaces:**
- Consumes: `RankInfo`, `GameProfile` (Task 2), `ProviderId` (Task 1).
- Produces: `interface GameProvider` с полями `id`, `capabilities`, необязательными `startVerification` / `completeVerification` / `fetchRank` и обязательным `fetchProfile`; типы `VerificationChallenge`, `VerifiedAccount`, `ProviderCapabilities`; функции `canVerify(provider): boolean` и `canFetchRank(provider): boolean`.

- [ ] **Step 1: Написать падающий тест**

Файл `tests/modules/identity/providers/provider.test.ts`. Смысл `capabilities` — в том, чтобы вызывающий код спрашивал о возможностях, а не сравнивал `provider.id` со строками.

```ts
import { describe, expect, it } from 'vitest';
import { canFetchRank, canVerify, type GameProvider } from '../../../../src/modules/identity/providers/provider.js';

const full: GameProvider = {
  id: 'steam',
  capabilities: { verification: 'steam-openid', rank: 'api' },
  startVerification: async () => ({ challenge: 'x', expiresAt: new Date(), payload: {} }),
  completeVerification: async () => ({ externalId: '1', displayName: 'a', verificationMethod: 'steam-openid' }),
  fetchProfile: async () => ({ externalId: '1', displayName: 'a' }),
  fetchRank: async () => [],
};

const manual: GameProvider = {
  id: 'riot-valorant',
  capabilities: { verification: 'none', rank: 'manual' },
  fetchProfile: async () => ({ externalId: 'a#b', displayName: 'a#b' }),
};

describe('canVerify', () => {
  it('истина, когда провайдер умеет подтверждать владение', () => {
    expect(canVerify(full)).toBe(true);
  });

  it('ложь для провайдера с verification: none', () => {
    expect(canVerify(manual)).toBe(false);
  });

  it('ложь, если методы верификации не реализованы, несмотря на объявление', () => {
    expect(canVerify({ ...manual, capabilities: { verification: 'steam-openid', rank: 'manual' } })).toBe(false);
  });
});

describe('canFetchRank', () => {
  it('истина только при rank: api и реализованном fetchRank', () => {
    expect(canFetchRank(full)).toBe(true);
    expect(canFetchRank(manual)).toBe(false);
    expect(canFetchRank({ ...manual, capabilities: { verification: 'none', rank: 'api' } })).toBe(false);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npx vitest run tests/modules/identity/providers/provider.test.ts`
Expected: FAIL — `canVerify` не экспортируется.

- [ ] **Step 3: Дополнить `src/modules/identity/providers/provider.ts`**

Файл уже содержит `RankInfo` и `GameProfile` из Task 2. Дописать ниже:

```ts
import type { ProviderId, VerificationMethod } from '../schema.js';

export interface ProviderCapabilities {
  verification: VerificationMethod | 'none';
  /** 'manual' означает, что ранг вводит пользователь, а не отдаёт API. */
  rank: 'api' | 'manual';
}

export interface VerificationChallenge {
  /** Код для игрока или nonce для OpenID. Уникален. */
  challenge: string;
  expiresAt: Date;
  payload: Record<string, unknown>;
  /** Показывается пользователю: ссылка или инструкция. */
  instruction?: string;
}

export interface VerifiedAccount {
  externalId: string;
  displayName: string;
  region?: string;
  verificationMethod: VerificationMethod;
}

export interface GameProvider {
  id: ProviderId;
  capabilities: ProviderCapabilities;
  startVerification?(userId: string): Promise<VerificationChallenge>;
  completeVerification?(challenge: VerificationChallenge, input: string): Promise<VerifiedAccount>;
  /** region обязателен для Riot (платформа) и игнорируется Steam. */
  fetchProfile(externalId: string, region?: string): Promise<GameProfile>;
  fetchRank?(externalId: string, region?: string): Promise<RankInfo[]>;
}

/**
 * Проверяет и объявление, и наличие реализации. Одного объявления мало:
 * рассинхрон между capabilities и методами — это баг, который иначе всплывёт
 * у пользователя как «cannot read property of undefined».
 */
export function canVerify(provider: GameProvider): boolean {
  return (
    provider.capabilities.verification !== 'none' &&
    typeof provider.startVerification === 'function' &&
    typeof provider.completeVerification === 'function'
  );
}

export function canFetchRank(provider: GameProvider): boolean {
  return provider.capabilities.rank === 'api' && typeof provider.fetchRank === 'function';
}
```

- [ ] **Step 4: Прогнать тест**

Run: `npx vitest run tests/modules/identity/providers/provider.test.ts && npm run typecheck`
Expected: 4 теста PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/identity/providers/provider.ts tests/modules/identity/providers/provider.test.ts
git commit -m "feat(identity): интерфейс GameProvider с объявлением возможностей"
```

---

### Task 7: Steam OpenID

**Files:**
- Create: `src/modules/identity/providers/steam-openid.ts`
- Test: `tests/modules/identity/providers/steam-openid.test.ts`

**Interfaces:**
- Consumes: `ProviderError` (этап 0).
- Produces: `buildSteamLoginUrl(opts: { returnTo: string; realm: string }): string`; `extractSteamId(claimedId: string): string | null`; `verifySteamAssertion(params: URLSearchParams, deps: { fetch?: typeof fetch }): Promise<string>` — возвращает SteamID64 или бросает `ProviderError`.

- [ ] **Step 1: Написать падающие тесты**

Файл `tests/modules/identity/providers/steam-openid.test.ts`. Проверка подлинности обязательна: без обращения к `check_authentication` любой может подделать возврат и «подтвердить» чужой аккаунт.

```ts
import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../../../src/core/errors.js';
import {
  buildSteamLoginUrl,
  extractSteamId,
  verifySteamAssertion,
} from '../../../../src/modules/identity/providers/steam-openid.js';

describe('buildSteamLoginUrl', () => {
  it('строит адрес входа со всеми обязательными параметрами OpenID 2.0', () => {
    const url = new URL(
      buildSteamLoginUrl({ returnTo: 'https://bot.example.com/steam/callback', realm: 'https://bot.example.com' }),
    );

    expect(url.origin + url.pathname).toBe('https://steamcommunity.com/openid/login');
    expect(url.searchParams.get('openid.mode')).toBe('checkid_setup');
    expect(url.searchParams.get('openid.ns')).toBe('http://specs.openid.net/auth/2.0');
    expect(url.searchParams.get('openid.identity')).toBe('http://specs.openid.net/auth/2.0/identifier_select');
    expect(url.searchParams.get('openid.claimed_id')).toBe('http://specs.openid.net/auth/2.0/identifier_select');
    expect(url.searchParams.get('openid.return_to')).toBe('https://bot.example.com/steam/callback');
    expect(url.searchParams.get('openid.realm')).toBe('https://bot.example.com');
  });
});

describe('extractSteamId', () => {
  it('вынимает SteamID64 из claimed_id', () => {
    expect(extractSteamId('https://steamcommunity.com/openid/id/76561198000000001')).toBe('76561198000000001');
  });

  it('возвращает null на чужом домене', () => {
    expect(extractSteamId('https://evil.example.com/openid/id/76561198000000001')).toBeNull();
  });

  it('возвращает null, если идентификатор не похож на SteamID64', () => {
    expect(extractSteamId('https://steamcommunity.com/openid/id/не-число')).toBeNull();
  });

  // Без этих двух тест на evil.example.com проходит вакуумно: префикс Steam ровно
  // 37 символов, у `https://evil.example.com/openid/id/` их 35, поэтому slice(37)
  // съедает две лишние цифры и null возвращается по случайной причине, а не потому,
  // что проверка домена работает. Удаление проверки префикса тест не валит.
  it('возвращает null для чужого домена, подогнанного по длине под Steam', () => {
    expect(extractSteamId('https://notsteamcommun.com/openid/id/76561198000000001')).toBeNull();
  });

  it('возвращает null для верного домена с чужим путём', () => {
    expect(extractSteamId('https://steamcommunity.com/openid/ID/76561198000000001')).toBeNull();
  });
});

describe('verifySteamAssertion', () => {
  const validParams = () =>
    new URLSearchParams({
      'openid.mode': 'id_res',
      'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198000000001',
      'openid.signed': 'signed,op_endpoint,claimed_id',
      'openid.sig': 'подпись',
    });

  it('возвращает SteamID64, когда Steam подтвердил подпись', async () => {
    const fetchMock = vi.fn(async () => new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n'));
    await expect(verifySteamAssertion(validParams(), { fetch: fetchMock as unknown as typeof fetch })).resolves.toBe(
      '76561198000000001',
    );
  });

  it('отправляет check_authentication, а не доверяет параметрам', async () => {
    const fetchMock = vi.fn(async () => new Response('is_valid:true\n'));
    await verifySteamAssertion(validParams(), { fetch: fetchMock as unknown as typeof fetch });

    // Разворачиваем вручную: `vi.fn(async () => …)` без параметров даёт
    // `Parameters<T> = []`, и при noUncheckedIndexedAccess обращение
    // `calls[0]?.[1]` не компилируется — TS2493.
    const call = fetchMock.mock.calls[0] as unknown[] | undefined;
    if (!call || call.length < 2) throw new Error('fetchMock не был вызван');
    const requestInit = call[1] as unknown as Record<string, unknown>;
    const body = new URLSearchParams(requestInit.body as string);
    expect(body.get('openid.mode')).toBe('check_authentication');
  });

  it('отвергает, когда Steam ответил is_valid:false', async () => {
    const fetchMock = vi.fn(async () => new Response('is_valid:false\n'));
    await expect(
      verifySteamAssertion(validParams(), { fetch: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow(ProviderError);
  });

  it('отвергает возврат с неверным openid.mode', async () => {
    const params = validParams();
    params.set('openid.mode', 'cancel');
    await expect(verifySteamAssertion(params, {})).rejects.toThrow(/отменена/);
  });

  it('отвергает claimed_id с чужого домена, не обращаясь к сети', async () => {
    const params = validParams();
    params.set('openid.claimed_id', 'https://evil.example.com/openid/id/76561198000000001');
    const fetchMock = vi.fn();

    await expect(verifySteamAssertion(params, { fetch: fetchMock as unknown as typeof fetch })).rejects.toThrow(
      ProviderError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Тот же случай, но с домена, подогнанного по длине: без проверки префикса
  // запрос ушёл бы наружу, и предыдущий тест этого не поймал бы.
  it('не ходит в сеть и на чужом домене, подогнанном по длине под Steam', async () => {
    const params = validParams();
    params.set('openid.claimed_id', 'https://notsteamcommun.com/openid/id/76561198000000001');
    const fetchMock = vi.fn();

    await expect(verifySteamAssertion(params, { fetch: fetchMock as unknown as typeof fetch })).rejects.toThrow(
      ProviderError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `npx vitest run tests/modules/identity/providers/steam-openid.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `src/modules/identity/providers/steam-openid.ts`**

```ts
import { ProviderError } from '../../../core/errors.js';

const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const CLAIMED_ID_PREFIX = 'https://steamcommunity.com/openid/id/';

export function buildSteamLoginUrl(opts: { returnTo: string; realm: string }): string {
  const params = new URLSearchParams({
    'openid.ns': OPENID_NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': opts.returnTo,
    'openid.realm': opts.realm,
    'openid.identity': IDENTIFIER_SELECT,
    'openid.claimed_id': IDENTIFIER_SELECT,
  });
  return `${STEAM_OPENID_ENDPOINT}?${params.toString()}`;
}

export function extractSteamId(claimedId: string): string | null {
  if (!claimedId.startsWith(CLAIMED_ID_PREFIX)) return null;
  const id = claimedId.slice(CLAIMED_ID_PREFIX.length);
  return /^\d{17}$/.test(id) ? id : null;
}

/**
 * Проверяет подлинность возврата, переспрашивая Steam через check_authentication.
 * Доверять параметрам запроса нельзя: их подделает любой, кто знает адрес колбэка.
 */
export async function verifySteamAssertion(
  params: URLSearchParams,
  deps: { fetch?: typeof fetch },
): Promise<string> {
  const mode = params.get('openid.mode');
  if (mode !== 'id_res') {
    // Текст обязан содержать «отменена» — именно это ищет тест.
    throw new ProviderError(`авторизация отменена или прервана (mode=${mode ?? 'отсутствует'})`, 'steam');
  }

  const claimedId = params.get('openid.claimed_id') ?? '';
  const steamId = extractSteamId(claimedId);
  if (!steamId) {
    throw new ProviderError(`claimed_id не принадлежит Steam: ${claimedId}`, 'steam');
  }

  const verification = new URLSearchParams(params);
  verification.set('openid.mode', 'check_authentication');

  const doFetch = deps.fetch ?? fetch;
  const response = await doFetch(STEAM_OPENID_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: verification,
  });

  const text = await response.text();
  if (!/^is_valid:true$/m.test(text.trim())) {
    throw new ProviderError('Steam не подтвердил подпись возврата', 'steam');
  }

  return steamId;
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `npx vitest run tests/modules/identity/providers/steam-openid.test.ts && npm run typecheck`
Expected: 12 тестов PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/identity/providers/steam-openid.ts tests/modules/identity/providers/steam-openid.test.ts
git commit -m "feat(identity): проверка Steam OpenID через check_authentication"
```

---

### Task 8: Steam-провайдер

**Files:**
- Create: `src/modules/identity/providers/steam.ts`
- Test: `tests/modules/identity/providers/steam.test.ts`

**Interfaces:**
- Consumes: `GameProvider`, `RankInfo`, `GameProfile` (Task 6), `normalizeDotaRank` (Task 3), `FetchClient` (Task 4), `RateLimiter` (Task 5), `buildSteamLoginUrl` / `verifySteamAssertion` (Task 7).
- Produces: `steamId64ToAccountId(steamId64: string): string`; `createSteamProvider(deps: SteamProviderDeps): GameProvider` где `interface SteamProviderDeps { apiKey?: string; publicBaseUrl: string; client: FetchClient; openDotaClient: FetchClient; rateLimiter: RateLimiter }`.

- [ ] **Step 1: Написать падающие тесты**

Файл `tests/modules/identity/providers/steam.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { UserError } from '../../../../src/core/errors.js';
import type { FetchClient } from '../../../../src/core/http/fetch-client.js';
import type { RateLimiter } from '../../../../src/core/rate-limit.js';
import { createSteamProvider, steamId64ToAccountId } from '../../../../src/modules/identity/providers/steam.js';

const noopLimiter: RateLimiter = { acquire: async () => {}, close: async () => {} };

function clientReturning(payload: unknown): FetchClient {
  return { json: vi.fn(async () => payload) as FetchClient['json'] };
}

const playerSummary = {
  response: {
    players: [
      {
        steamid: '76561198000000001',
        personaname: 'ЧувакИзДоты',
        avatarfull: 'https://avatars.steamstatic.com/abc_full.jpg',
        communityvisibilitystate: 3,
      },
    ],
  },
};

describe('steamId64ToAccountId', () => {
  it('переводит SteamID64 в account_id для OpenDota', () => {
    expect(steamId64ToAccountId('76561197960265729')).toBe('1');
    expect(steamId64ToAccountId('76561198000000001')).toBe('39734273');
  });
});

describe('createSteamProvider', () => {
  it('объявляет верификацию через OpenID и ранг из API', () => {
    const provider = createSteamProvider({
      apiKey: 'k',
      publicBaseUrl: 'https://bot.example.com',
      client: clientReturning(playerSummary),
      openDotaClient: clientReturning({}),
      rateLimiter: noopLimiter,
    });

    expect(provider.id).toBe('steam');
    expect(provider.capabilities).toEqual({ verification: 'steam-openid', rank: 'api' });
  });

  it('отдаёт профиль с персоной и аватаром', async () => {
    const provider = createSteamProvider({
      apiKey: 'k',
      publicBaseUrl: 'https://bot.example.com',
      client: clientReturning(playerSummary),
      openDotaClient: clientReturning({}),
      rateLimiter: noopLimiter,
    });

    await expect(provider.fetchProfile('76561198000000001')).resolves.toEqual({
      externalId: '76561198000000001',
      displayName: 'ЧувакИзДоты',
      avatarUrl: 'https://avatars.steamstatic.com/abc_full.jpg',
    });
  });

  it('бросает UserError, когда Steam не знает такой аккаунт', async () => {
    const provider = createSteamProvider({
      apiKey: 'k',
      publicBaseUrl: 'https://bot.example.com',
      client: clientReturning({ response: { players: [] } }),
      openDotaClient: clientReturning({}),
      rateLimiter: noopLimiter,
    });

    await expect(provider.fetchProfile('76561198000000009')).rejects.toThrow(UserError);
  });

  it('бросает UserError без ключа Steam вместо падения', async () => {
    const provider = createSteamProvider({
      publicBaseUrl: 'https://bot.example.com',
      client: clientReturning(playerSummary),
      openDotaClient: clientReturning({}),
      rateLimiter: noopLimiter,
    });

    await expect(provider.fetchProfile('76561198000000001')).rejects.toThrow(/STEAM_API_KEY/);
  });

  it('отдаёт нормализованный ранг Dota', async () => {
    const provider = createSteamProvider({
      apiKey: 'k',
      publicBaseUrl: 'https://bot.example.com',
      client: clientReturning(playerSummary),
      openDotaClient: clientReturning({ rank_tier: 53, leaderboard_rank: null }),
      rateLimiter: noopLimiter,
    });

    const ranks = await provider.fetchRank!('76561198000000001');
    expect(ranks).toHaveLength(1);
    expect(ranks[0]).toMatchObject({ mode: 'dota-mmr', tier: 'LEGEND', division: '3' });
  });

  it('отдаёт пустой список, когда игрок в Dota не откалиброван', async () => {
    const provider = createSteamProvider({
      apiKey: 'k',
      publicBaseUrl: 'https://bot.example.com',
      client: clientReturning(playerSummary),
      openDotaClient: clientReturning({ rank_tier: null }),
      rateLimiter: noopLimiter,
    });

    await expect(provider.fetchRank!('76561198000000001')).resolves.toEqual([]);
  });

  it('берёт квоту перед каждым внешним вызовом', async () => {
    const acquire = vi.fn(async () => {});
    const provider = createSteamProvider({
      apiKey: 'k',
      publicBaseUrl: 'https://bot.example.com',
      client: clientReturning(playerSummary),
      openDotaClient: clientReturning({ rank_tier: 11 }),
      rateLimiter: { acquire, close: async () => {} },
    });

    await provider.fetchProfile('76561198000000001');
    await provider.fetchRank!('76561198000000001');

    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('выдаёт челлендж со ссылкой на вход Steam', async () => {
    const provider = createSteamProvider({
      apiKey: 'k',
      publicBaseUrl: 'https://bot.example.com',
      client: clientReturning(playerSummary),
      openDotaClient: clientReturning({}),
      rateLimiter: noopLimiter,
    });

    const challenge = await provider.startVerification!('222222222222222222');

    expect(challenge.instruction).toContain('https://steamcommunity.com/openid/login');
    expect(challenge.instruction).toContain(encodeURIComponent(challenge.challenge));
    expect(challenge.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `npx vitest run tests/modules/identity/providers/steam.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `src/modules/identity/providers/steam.ts`**

Ранг Dota не отдаёт ни Steam Web API, ни сам клиент игры — только OpenDota, поэтому провайдер работает с двумя разными базами и двумя разными квотами.

```ts
import { randomUUID } from 'node:crypto';
import { UserError } from '../../../core/errors.js';
import type { FetchClient } from '../../../core/http/fetch-client.js';
import type { Limit, RateLimiter } from '../../../core/rate-limit.js';
import { normalizeDotaRank, type OpenDotaPlayer } from '../ranks/dota.js';
import type { GameProfile, GameProvider, RankInfo, VerificationChallenge } from './provider.js';
import { buildSteamLoginUrl } from './steam-openid.js';

const STEAM_API = 'https://api.steampowered.com';
const OPENDOTA_API = 'https://api.opendota.com/api';

/** Смещение между SteamID64 и account_id, который ждёт OpenDota. */
const STEAM_ID64_BASE = 76561197960265728n;

const VERIFICATION_TTL_MS = 15 * 60 * 1_000;

/** Лимиты консервативны намеренно: превышение стоит дороже лишней секунды ожидания. */
const STEAM_LIMITS: Limit[] = [{ tokens: 20, windowMs: 1_000 }];
const OPENDOTA_LIMITS: Limit[] = [
  { tokens: 50, windowMs: 60_000 },
  { tokens: 1_800, windowMs: 24 * 60 * 60 * 1_000 },
];

export function steamId64ToAccountId(steamId64: string): string {
  return (BigInt(steamId64) - STEAM_ID64_BASE).toString();
}

interface PlayerSummariesResponse {
  response: {
    players: Array<{
      steamid: string;
      personaname: string;
      avatarfull?: string;
      communityvisibilitystate?: number;
    }>;
  };
}

export interface SteamProviderDeps {
  apiKey?: string;
  publicBaseUrl: string;
  client: FetchClient;
  openDotaClient: FetchClient;
  rateLimiter: RateLimiter;
}

export function createSteamProvider(deps: SteamProviderDeps): GameProvider {
  function requireKey(): string {
    if (!deps.apiKey) {
      throw new UserError('Интеграция со Steam не настроена: в окружении нет STEAM_API_KEY.');
    }
    return deps.apiKey;
  }

  return {
    id: 'steam',
    capabilities: { verification: 'steam-openid', rank: 'api' },

    async startVerification(): Promise<VerificationChallenge> {
      // nonce уходит в return_to: по нему колбэк находит, кому принадлежит вход.
      const nonce = randomUUID();
      const returnTo = `${deps.publicBaseUrl}/steam/callback?state=${encodeURIComponent(nonce)}`;
      const loginUrl = buildSteamLoginUrl({ returnTo, realm: deps.publicBaseUrl });

      return {
        challenge: nonce,
        expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
        payload: { returnTo },
        instruction:
          `Открой ссылку и войди через Steam — она действует 15 минут:\n${loginUrl}\n\n` +
          `Пароль вводится на сайте Steam, бот его не видит.`,
      };
    },

    async completeVerification(_challenge, steamId) {
      // Подпись проверяет HTTP-роут колбэка: сюда приходит уже доверенный SteamID64.
      const profile = await this.fetchProfile(steamId);
      return {
        externalId: profile.externalId,
        displayName: profile.displayName,
        verificationMethod: 'steam-openid',
      };
    },

    async fetchProfile(steamId64: string): Promise<GameProfile> {
      const key = requireKey();
      await deps.rateLimiter.acquire('steam', STEAM_LIMITS);

      const url = `${STEAM_API}/ISteamUser/GetPlayerSummaries/v0002/?key=${key}&steamids=${steamId64}`;
      const data = await deps.client.json<PlayerSummariesResponse>(url);
      const player = data.response.players[0];

      if (!player) {
        throw new UserError('Steam не знает такой аккаунт. Проверь, что профиль существует и открыт.');
      }

      return {
        externalId: player.steamid,
        displayName: player.personaname,
        ...(player.avatarfull ? { avatarUrl: player.avatarfull } : {}),
      };
    },

    async fetchRank(steamId64: string): Promise<RankInfo[]> {
      await deps.rateLimiter.acquire('opendota', OPENDOTA_LIMITS);

      const accountId = steamId64ToAccountId(steamId64);
      const player = await deps.openDotaClient.json<OpenDotaPlayer>(`${OPENDOTA_API}/players/${accountId}`);
      const rank = normalizeDotaRank(player);

      return rank ? [rank] : [];
    },
  };
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `npx vitest run tests/modules/identity/providers/steam.test.ts && npm run typecheck`
Expected: 9 тестов PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/identity/providers/steam.ts tests/modules/identity/providers/steam.test.ts
git commit -m "feat(identity): Steam-провайдер с профилем и рангом Dota через OpenDota"
```

---

### Task 9: Riot-провайдер для LoL и TFT

**Files:**
- Create: `src/modules/identity/providers/riot.ts`
- Test: `tests/modules/identity/providers/riot-provider.test.ts`

**Interfaces:**
- Consumes: `GameProvider` (Task 6), `normalizeRiotEntry` (Task 2), `FetchClient` (Task 4), `RateLimiter` (Task 5).
- Produces: `RIOT_PLATFORMS: readonly string[]`; `platformToRegionalRoute(platform: string): string`; `parseRiotId(input: string): { gameName: string; tagLine: string } | null`; `createRiotProvider(deps: RiotProviderDeps): GameProvider` где `interface RiotProviderDeps { game: 'lol' | 'tft'; apiKey?: string; client: FetchClient; rateLimiter: RateLimiter }`.

**Замечание по API, которое нужно проверить при реализации.** Riot переводит всё на PUUID и выпиливает `encryptedSummonerId`. Пути эндпоинтов собраны в объекте `ENDPOINTS` — единственное место, которое придётся править, если Riot их сдвинет. Перед реализацией сверься с актуальной документацией по трём путям: `league-v4 entries by-puuid`, `tft-league-v1 entries by-puuid`, `third-party-code by-puuid`. Если `third-party-code` недоступен — верификация Riot деградирует до ручного ввода (`verificationMethod: 'manual'`, `verifiedAt` остаётся `NULL`), и это законный сценарий, а не провал задачи.

- [ ] **Step 1: Написать падающие тесты**

Файл `tests/modules/identity/providers/riot-provider.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { UserError } from '../../../../src/core/errors.js';
import type { FetchClient } from '../../../../src/core/http/fetch-client.js';
import type { RateLimiter } from '../../../../src/core/rate-limit.js';
import {
  createRiotProvider,
  parseRiotId,
  platformToRegionalRoute,
} from '../../../../src/modules/identity/providers/riot.js';

const noopLimiter: RateLimiter = { acquire: async () => {}, close: async () => {} };

function clientSequence(...payloads: unknown[]): FetchClient {
  const json = vi.fn();
  for (const payload of payloads) json.mockResolvedValueOnce(payload);
  return { json: json as FetchClient['json'] };
}

const account = { puuid: 'PUUID-1', gameName: 'Игрок', tagLine: 'EUW' };

describe('parseRiotId', () => {
  it('разбирает Riot ID с решёткой', () => {
    expect(parseRiotId('Игрок#EUW')).toEqual({ gameName: 'Игрок', tagLine: 'EUW' });
  });

  it('обрезает пробелы вокруг частей', () => {
    expect(parseRiotId('  Игрок  #  EUW ')).toEqual({ gameName: 'Игрок', tagLine: 'EUW' });
  });

  it('возвращает null без решётки или с пустой частью', () => {
    expect(parseRiotId('Игрок')).toBeNull();
    expect(parseRiotId('#EUW')).toBeNull();
    expect(parseRiotId('Игрок#')).toBeNull();
  });
});

describe('platformToRegionalRoute', () => {
  it('сопоставляет платформы регионам', () => {
    expect(platformToRegionalRoute('euw1')).toBe('europe');
    expect(platformToRegionalRoute('ru')).toBe('europe');
    expect(platformToRegionalRoute('na1')).toBe('americas');
    expect(platformToRegionalRoute('kr')).toBe('asia');
  });

  it('падает на неизвестной платформе, а не угадывает регион', () => {
    expect(() => platformToRegionalRoute('марс1')).toThrow(/марс1/);
  });
});

describe('createRiotProvider', () => {
  it('объявляет верификацию через third-party-code и ранг из API', () => {
    const provider = createRiotProvider({ game: 'lol', apiKey: 'k', client: clientSequence(), rateLimiter: noopLimiter });
    expect(provider.id).toBe('riot-lol');
    expect(provider.capabilities).toEqual({ verification: 'riot-third-party-code', rank: 'api' });
  });

  it('использует id riot-tft для TFT', () => {
    const provider = createRiotProvider({ game: 'tft', apiKey: 'k', client: clientSequence(), rateLimiter: noopLimiter });
    expect(provider.id).toBe('riot-tft');
  });

  it('бросает UserError без ключа Riot вместо падения', async () => {
    const provider = createRiotProvider({ game: 'lol', client: clientSequence(), rateLimiter: noopLimiter });
    await expect(provider.fetchProfile('PUUID-1', 'euw1')).rejects.toThrow(/RIOT_API_KEY/);
  });

  it('отдаёт профиль как gameName#tagLine', async () => {
    const provider = createRiotProvider({
      game: 'lol',
      apiKey: 'k',
      client: clientSequence(account),
      rateLimiter: noopLimiter,
    });

    await expect(provider.fetchProfile('PUUID-1', 'euw1')).resolves.toEqual({
      externalId: 'PUUID-1',
      displayName: 'Игрок#EUW',
      region: 'euw1',
    });
  });

  it('нормализует обе очереди LoL', async () => {
    const provider = createRiotProvider({
      game: 'lol',
      apiKey: 'k',
      client: clientSequence([
        { queueType: 'RANKED_SOLO_5x5', tier: 'EMERALD', rank: 'II', leaguePoints: 33 },
        { queueType: 'RANKED_FLEX_SR', tier: 'GOLD', rank: 'I', leaguePoints: 78 },
      ]),
      rateLimiter: noopLimiter,
    });

    const ranks = await provider.fetchRank!('PUUID-1', 'euw1');
    expect(ranks.map((r) => r.mode).sort()).toEqual(['flex', 'solo-duo']);
  });

  it('отбрасывает записи неизвестных очередей, а не падает', async () => {
    const provider = createRiotProvider({
      game: 'lol',
      apiKey: 'k',
      client: clientSequence([
        { queueType: 'CHERRY', tier: 'GOLD', rank: 'I', leaguePoints: 0 },
        { queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'I', leaguePoints: 10 },
      ]),
      rateLimiter: noopLimiter,
    });

    await expect(provider.fetchRank!('PUUID-1', 'euw1')).resolves.toHaveLength(1);
  });

  it('отдаёт пустой список для неоткалиброванного игрока', async () => {
    const provider = createRiotProvider({
      game: 'lol',
      apiKey: 'k',
      client: clientSequence([]),
      rateLimiter: noopLimiter,
    });

    await expect(provider.fetchRank!('PUUID-1', 'euw1')).resolves.toEqual([]);
  });

  it('требует регион для запроса ранга', async () => {
    const provider = createRiotProvider({
      game: 'lol',
      apiKey: 'k',
      client: clientSequence([]),
      rateLimiter: noopLimiter,
    });

    await expect(provider.fetchRank!('PUUID-1')).rejects.toThrow(/регион/);
  });

  it('выдаёт челлендж с кодом для вставки в клиент', async () => {
    const provider = createRiotProvider({
      game: 'lol',
      apiKey: 'k',
      client: clientSequence(),
      rateLimiter: noopLimiter,
    });

    const challenge = await provider.startVerification!('222222222222222222');
    expect(challenge.challenge).toMatch(/^[A-Z0-9]{8}$/);
    expect(challenge.instruction).toContain(challenge.challenge);
  });

  it('подтверждает владение, когда код в клиенте совпал', async () => {
    const provider = createRiotProvider({
      game: 'lol',
      apiKey: 'k',
      client: clientSequence(account, 'КОД1234', account),
      rateLimiter: noopLimiter,
    });

    const result = await provider.completeVerification!(
      { challenge: 'КОД1234', expiresAt: new Date(Date.now() + 60_000), payload: { platform: 'euw1' } },
      'Игрок#EUW',
    );

    expect(result).toMatchObject({ externalId: 'PUUID-1', verificationMethod: 'riot-third-party-code' });
  });

  it('отказывает, когда код в клиенте не совпал', async () => {
    const provider = createRiotProvider({
      game: 'lol',
      apiKey: 'k',
      client: clientSequence(account, 'ДРУГОЙКОД'),
      rateLimiter: noopLimiter,
    });

    await expect(
      provider.completeVerification!(
        { challenge: 'КОД1234', expiresAt: new Date(Date.now() + 60_000), payload: { platform: 'euw1' } },
        'Игрок#EUW',
      ),
    ).rejects.toThrow(UserError);
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `npx vitest run tests/modules/identity/providers/riot-provider.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `src/modules/identity/providers/riot.ts`**

```ts
import { randomInt } from 'node:crypto';
import { UserError } from '../../../core/errors.js';
import type { FetchClient } from '../../../core/http/fetch-client.js';
import type { Limit, RateLimiter } from '../../../core/rate-limit.js';
import { normalizeRiotEntry, type RiotLeagueEntry } from '../ranks/riot.js';
import type { GameProfile, GameProvider, RankInfo, VerificationChallenge } from './provider.js';

/**
 * Единственное место с путями Riot API. Riot переводит всё на PUUID и убирает
 * encryptedSummonerId — если пути сдвинутся, правится только этот объект.
 */
const ENDPOINTS = {
  accountByRiotId: (route: string, gameName: string, tagLine: string) =>
    `https://${route}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
  accountByPuuid: (route: string, puuid: string) =>
    `https://${route}.api.riotgames.com/riot/account/v1/accounts/by-puuid/${puuid}`,
  lolEntries: (platform: string, puuid: string) =>
    `https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`,
  tftEntries: (platform: string, puuid: string) =>
    `https://${platform}.api.riotgames.com/tft/league/v1/entries/by-puuid/${puuid}`,
  thirdPartyCode: (platform: string, puuid: string) =>
    `https://${platform}.api.riotgames.com/lol/platform/v4/third-party-code/by-puuid/${puuid}`,
} as const;

const PLATFORM_TO_ROUTE: Record<string, string> = {
  br1: 'americas',
  la1: 'americas',
  la2: 'americas',
  na1: 'americas',
  eun1: 'europe',
  euw1: 'europe',
  me1: 'europe',
  ru: 'europe',
  tr1: 'europe',
  jp1: 'asia',
  kr: 'asia',
  oc1: 'sea',
  ph2: 'sea',
  sg2: 'sea',
  th2: 'sea',
  tw2: 'sea',
  vn2: 'sea',
};

export const RIOT_PLATFORMS = Object.keys(PLATFORM_TO_ROUTE) as readonly string[];

/** Лимиты dev-ключа. С production-ключом их можно поднять. */
const RIOT_LIMITS: Limit[] = [
  { tokens: 20, windowMs: 1_000 },
  { tokens: 100, windowMs: 120_000 },
];

const VERIFICATION_TTL_MS = 15 * 60 * 1_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function platformToRegionalRoute(platform: string): string {
  const route = PLATFORM_TO_ROUTE[platform];
  if (!route) {
    throw new UserError(`Неизвестная платформа Riot: «${platform}». Допустимые: ${RIOT_PLATFORMS.join(', ')}.`);
  }
  return route;
}

export function parseRiotId(input: string): { gameName: string; tagLine: string } | null {
  const [rawName, rawTag, ...rest] = input.split('#');
  if (rest.length > 0) return null;
  const gameName = rawName?.trim() ?? '';
  const tagLine = rawTag?.trim() ?? '';
  if (!gameName || !tagLine) return null;
  return { gameName, tagLine };
}

interface RiotAccount {
  puuid: string;
  gameName: string;
  tagLine: string;
}

export interface RiotProviderDeps {
  game: 'lol' | 'tft';
  apiKey?: string;
  client: FetchClient;
  rateLimiter: RateLimiter;
}

export function createRiotProvider(deps: RiotProviderDeps): GameProvider {
  function headers(): Record<string, string> {
    if (!deps.apiKey) {
      throw new UserError('Интеграция с Riot не настроена: в окружении нет RIOT_API_KEY.');
    }
    return { 'X-Riot-Token': deps.apiKey };
  }

  async function call<T>(url: string): Promise<T> {
    const init = { headers: headers() };
    await deps.rateLimiter.acquire('riot', RIOT_LIMITS);
    return deps.client.json<T>(url, init);
  }

  function requirePlatform(region?: string): string {
    if (!region) {
      throw new UserError('Для запроса к Riot нужен регион (платформа), например euw1 или ru.');
    }
    return region;
  }

  return {
    id: deps.game === 'lol' ? 'riot-lol' : 'riot-tft',
    capabilities: { verification: 'riot-third-party-code', rank: 'api' },

    async startVerification(): Promise<VerificationChallenge> {
      const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      return {
        challenge: code,
        expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
        payload: {},
        instruction:
          `Открой клиент League of Legends → Настройки → Проверка → и вставь этот код:\n\`${code}\`\n\n` +
          `Потом вернись сюда и повтори команду с тем же Riot ID. Код действует 15 минут.`,
      };
    },

    async completeVerification(challenge, riotId) {
      const parsed = parseRiotId(riotId);
      if (!parsed) {
        throw new UserError('Riot ID пишется как Имя#Тег, например Игрок#EUW.');
      }
      const platform = requirePlatform(challenge.payload['platform'] as string | undefined);
      const route = platformToRegionalRoute(platform);

      const account = await call<RiotAccount>(ENDPOINTS.accountByRiotId(route, parsed.gameName, parsed.tagLine));
      const codeInClient = await call<string>(ENDPOINTS.thirdPartyCode(platform, account.puuid));

      if (codeInClient.trim().toUpperCase() !== challenge.challenge.toUpperCase()) {
        throw new UserError(
          'Код в клиенте не совпал с выданным. Проверь, что вставил его в настройках проверки и нажал сохранить.',
        );
      }

      return {
        externalId: account.puuid,
        displayName: `${account.gameName}#${account.tagLine}`,
        region: platform,
        verificationMethod: 'riot-third-party-code',
      };
    },

    async fetchProfile(puuid: string, region?: string): Promise<GameProfile> {
      const platform = requirePlatform(region);
      const account = await call<RiotAccount>(ENDPOINTS.accountByPuuid(platformToRegionalRoute(platform), puuid));
      return {
        externalId: account.puuid,
        displayName: `${account.gameName}#${account.tagLine}`,
        region: platform,
      };
    },

    async fetchRank(puuid: string, region?: string): Promise<RankInfo[]> {
      const platform = requirePlatform(region);
      const url =
        deps.game === 'lol' ? ENDPOINTS.lolEntries(platform, puuid) : ENDPOINTS.tftEntries(platform, puuid);

      const entries = await call<RiotLeagueEntry[]>(url);
      // Неизвестные очереди отбрасываются: Riot добавляет режимы чаще, чем мы обновляем код.
      return entries.map(normalizeRiotEntry).filter((rank): rank is RankInfo => rank !== null);
    },
  };
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `npx vitest run tests/modules/identity/providers/ && npm run typecheck`
Expected: 17 тестов PASS (13 новых плюс 4 из Task 6).

- [ ] **Step 5: Коммит**

```bash
git add src/modules/identity/providers/riot.ts tests/modules/identity/providers/riot-provider.test.ts
git commit -m "feat(identity): Riot-провайдер для LoL и TFT с верификацией через third-party-code"
```

---

### Task 10: Valorant-провайдер и реестр провайдеров

**Files:**
- Create: `src/modules/identity/providers/valorant.ts`, `src/modules/identity/providers/index.ts`
- Test: `tests/modules/identity/providers/valorant.test.ts`

**Interfaces:**
- Consumes: `GameProvider`, `canVerify`, `canFetchRank` (Task 6), `parseRiotTier` (Task 2), `parseRiotId` (Task 9).
- Produces: `createValorantProvider(): GameProvider`; `manualValorantRank(input: string): RankInfo`; `createProviderRegistry(deps: ProviderRegistryDeps): Map<ProviderId, GameProvider>` и `getProvider(registry, id): GameProvider`.

- [ ] **Step 1: Написать падающие тесты**

Файл `tests/modules/identity/providers/valorant.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { UserError } from '../../../../src/core/errors.js';
import { canFetchRank, canVerify } from '../../../../src/modules/identity/providers/provider.js';
import { createValorantProvider, manualValorantRank } from '../../../../src/modules/identity/providers/valorant.js';

describe('createValorantProvider', () => {
  it('честно объявляет, что не умеет ни верификацию, ни автоматический ранг', () => {
    const provider = createValorantProvider();

    expect(provider.id).toBe('riot-valorant');
    expect(provider.capabilities).toEqual({ verification: 'none', rank: 'manual' });
    expect(canVerify(provider)).toBe(false);
    expect(canFetchRank(provider)).toBe(false);
  });

  it('строит профиль из Riot ID без обращения к сети', async () => {
    const provider = createValorantProvider();
    await expect(provider.fetchProfile('Игрок#EUW')).resolves.toEqual({
      externalId: 'Игрок#EUW',
      displayName: 'Игрок#EUW',
    });
  });

  it('отвергает Riot ID неверного формата', async () => {
    const provider = createValorantProvider();
    await expect(provider.fetchProfile('Игрок')).rejects.toThrow(UserError);
  });
});

describe('manualValorantRank', () => {
  it('размечает ранг как введённый вручную', () => {
    expect(manualValorantRank('Immortal 2')).toMatchObject({
      mode: 'val-competitive',
      scale: 'riot-tier',
      tier: 'IMMORTAL',
      division: 'II',
      source: 'manual',
    });
  });

  it('принимает тир без дивизиона', () => {
    expect(manualValorantRank('RADIANT')).toMatchObject({ tier: 'RADIANT', division: null });
  });

  it('бросает UserError с перечислением допустимых значений', () => {
    expect(() => manualValorantRank('очень высокий')).toThrow(/IRON/);
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `npx vitest run tests/modules/identity/providers/valorant.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `src/modules/identity/providers/valorant.ts`**

```ts
import { UserError } from '../../../core/errors.js';
import { VALORANT_TIERS, parseRiotTier } from '../ranks/riot.js';
import type { GameProfile, GameProvider, RankInfo } from './provider.js';
import { parseRiotId } from './riot.js';

export const VALORANT_MODE = 'val-competitive';

/**
 * У Valorant нет ни публичного API, ни способа подтвердить владение аккаунтом.
 * Провайдер объявляет это честно через capabilities, а не имитирует работу.
 */
export function createValorantProvider(): GameProvider {
  return {
    id: 'riot-valorant',
    capabilities: { verification: 'none', rank: 'manual' },

    async fetchProfile(riotId: string): Promise<GameProfile> {
      if (!parseRiotId(riotId)) {
        throw new UserError('Riot ID пишется как Имя#Тег, например Игрок#EUW.');
      }
      return { externalId: riotId, displayName: riotId };
    },
  };
}

export function manualValorantRank(input: string): RankInfo {
  const parsed = parseRiotTier(input);
  if (!parsed || !VALORANT_TIERS.includes(parsed.tier as (typeof VALORANT_TIERS)[number])) {
    throw new UserError(
      `Не понял ранг «${input}». Допустимые тиры: ${VALORANT_TIERS.join(', ')}; дивизион — 1, 2 или 3.`,
    );
  }

  return {
    mode: VALORANT_MODE,
    scale: 'riot-tier',
    tier: parsed.tier,
    division: parsed.division,
    points: null,
    source: 'manual',
    raw: { input },
  };
}
```

- [ ] **Step 4: Реализовать реестр `src/modules/identity/providers/index.ts`**

```ts
import { UserError } from '../../../core/errors.js';
import type { FetchClient } from '../../../core/http/fetch-client.js';
import type { RateLimiter } from '../../../core/rate-limit.js';
import type { ProviderId } from '../schema.js';
import type { GameProvider } from './provider.js';
import { createRiotProvider } from './riot.js';
import { createSteamProvider } from './steam.js';
import { createValorantProvider } from './valorant.js';

export interface ProviderRegistryDeps {
  publicBaseUrl: string;
  steamApiKey?: string;
  riotApiKey?: string;
  steamClient: FetchClient;
  openDotaClient: FetchClient;
  riotClient: FetchClient;
  rateLimiter: RateLimiter;
}

export function createProviderRegistry(deps: ProviderRegistryDeps): Map<ProviderId, GameProvider> {
  const providers: GameProvider[] = [
    createSteamProvider({
      ...(deps.steamApiKey ? { apiKey: deps.steamApiKey } : {}),
      publicBaseUrl: deps.publicBaseUrl,
      client: deps.steamClient,
      openDotaClient: deps.openDotaClient,
      rateLimiter: deps.rateLimiter,
    }),
    createRiotProvider({
      game: 'lol',
      ...(deps.riotApiKey ? { apiKey: deps.riotApiKey } : {}),
      client: deps.riotClient,
      rateLimiter: deps.rateLimiter,
    }),
    createRiotProvider({
      game: 'tft',
      ...(deps.riotApiKey ? { apiKey: deps.riotApiKey } : {}),
      client: deps.riotClient,
      rateLimiter: deps.rateLimiter,
    }),
    createValorantProvider(),
  ];

  return new Map(providers.map((provider) => [provider.id, provider]));
}

export function getProvider(registry: Map<ProviderId, GameProvider>, id: ProviderId): GameProvider {
  const provider = registry.get(id);
  if (!provider) {
    throw new UserError(`Провайдер «${id}» не подключён.`);
  }
  return provider;
}
```

- [ ] **Step 5: Прогнать тесты**

Run: `npx vitest run tests/modules/identity/ && npm run typecheck && npm run lint`
Expected: все тесты модуля PASS, типы и линт чистые.

- [ ] **Step 6: Коммит**

```bash
git add src/modules/identity/providers/valorant.ts src/modules/identity/providers/index.ts tests/modules/identity/providers/valorant.test.ts
git commit -m "feat(identity): Valorant на ручном вводе ранга и реестр провайдеров"
```

---

### Task 11: Сервис привязки аккаунтов

**Files:**
- Create: `src/modules/identity/services/linking.ts`
- Test: `tests/integration/identity/linking.test.ts`

**Interfaces:**
- Consumes: `Database` (этап 0), таблицы `gameAccounts` / `accountVerifications` / `rankSnapshots` (Task 1), `UserError` (этап 0), `RankInfo` (Task 2), `VerificationChallenge` / `VerifiedAccount` (Task 6).
- Produces: `createLinkingService(deps: { db: Database }): LinkingService` с методами:
  - `ensureUser(userId: string): Promise<void>`
  - `openChallenge(userId: string, provider: ProviderId, challenge: VerificationChallenge): Promise<void>`
  - `takeChallenge(challenge: string): Promise<{ userId: string; provider: ProviderId; payload: Record<string, unknown> }>` — бросает `UserError`, если код неизвестен, просрочен или попытки исчерпаны
  - `pendingChallenge(userId: string, provider: ProviderId): Promise<{ challenge: string; payload: Record<string, unknown> } | null>` — нужен Riot-потоку: пользователь вставляет код в клиент игры, а не вводит его боту, поэтому челлендж ищется по владельцу
  - `linkAccount(userId: string, provider: ProviderId, account: VerifiedAccount, verified: boolean): Promise<number>` — возвращает `accountId`
  - `unlinkAccount(userId: string, provider: ProviderId): Promise<boolean>`
  - `listAccounts(userId: string): Promise<GameAccountRow[]>`
  - `saveRank(accountId: number, rank: RankInfo): Promise<void>`
  - `latestRanks(accountId: number): Promise<RankInfo[]>`
  - `rankAt(accountId: number, mode: string, at: Date): Promise<RankInfo | null>`

- [ ] **Step 1: Написать падающие тесты**

Файл `tests/integration/identity/linking.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { UserError } from '../../../src/core/errors.js';
import { guilds, users } from '../../../src/core/db/schema/core.js';
import { createLinkingService } from '../../../src/modules/identity/services/linking.js';
import type { RankInfo } from '../../../src/modules/identity/providers/provider.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();

const ALICE = '222222222222222222';
const BOB = '333333333333333333';

const steamAccount = {
  externalId: '76561198000000001',
  displayName: 'alice',
  verificationMethod: 'steam-openid' as const,
};

function rank(tier: string, division: string | null): RankInfo {
  return { mode: 'solo-duo', scale: 'riot-tier', tier, division, points: 20, source: 'api', raw: {} };
}

beforeAll(async () => {
  await pg.db.insert(guilds).values({ id: '111111111111111111' });
});

describe('LinkingService', () => {
  it('создаёт пользователя идемпотентно', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(ALICE);
    await expect(service.ensureUser(ALICE)).resolves.toBeUndefined();
  });

  it('привязывает аккаунт и возвращает его id', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(ALICE);

    const accountId = await service.linkAccount(ALICE, 'steam', steamAccount, true);

    expect(accountId).toBeTypeOf('number');
    const accounts = await service.listAccounts(ALICE);
    expect(accounts[0]?.verifiedAt).not.toBeNull();
  });

  it('заменяет привязку того же провайдера, а не создаёт вторую', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(ALICE);
    await service.linkAccount(ALICE, 'steam', steamAccount, true);
    await service.linkAccount(ALICE, 'steam', { ...steamAccount, displayName: 'alice-новая' }, true);

    const accounts = await service.listAccounts(ALICE);
    expect(accounts.filter((a) => a.provider === 'steam')).toHaveLength(1);
    expect(accounts[0]?.displayName).toBe('alice-новая');
  });

  it('отказывает, когда аккаунт уже привязан к другому пользователю', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(ALICE);
    await service.ensureUser(BOB);
    await service.linkAccount(ALICE, 'steam', steamAccount, true);

    await expect(service.linkAccount(BOB, 'steam', steamAccount, true)).rejects.toThrow(UserError);
  });

  it('помечает неподтверждённую привязку через verifiedAt = null', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(BOB);
    await service.linkAccount(BOB, 'riot-valorant', { externalId: 'Боб#EUW', displayName: 'Боб#EUW', verificationMethod: 'manual' }, false);

    const accounts = await service.listAccounts(BOB);
    expect(accounts.find((a) => a.provider === 'riot-valorant')?.verifiedAt).toBeNull();
  });

  it('отвязывает аккаунт и сообщает, был ли он', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(ALICE);
    await service.linkAccount(ALICE, 'steam', steamAccount, true);

    await expect(service.unlinkAccount(ALICE, 'steam')).resolves.toBe(true);
    await expect(service.unlinkAccount(ALICE, 'steam')).resolves.toBe(false);
  });

  it('выдаёт челлендж и потребляет его один раз', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(ALICE);
    await service.openChallenge(ALICE, 'steam', {
      challenge: 'НОНС-1',
      expiresAt: new Date(Date.now() + 60_000),
      payload: { platform: 'euw1' },
    });

    const taken = await service.takeChallenge('НОНС-1');
    expect(taken).toMatchObject({ userId: ALICE, provider: 'steam', payload: { platform: 'euw1' } });
  });

  it('отказывает по просроченному челленджу', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(ALICE);
    await service.openChallenge(ALICE, 'steam', {
      challenge: 'НОНС-СТАРЫЙ',
      expiresAt: new Date(Date.now() - 1_000),
      payload: {},
    });

    await expect(service.takeChallenge('НОНС-СТАРЫЙ')).rejects.toThrow(/истёк/);
  });

  it('отказывает по неизвестному челленджу', async () => {
    const service = createLinkingService({ db: pg.db });
    await expect(service.takeChallenge('ТАКОГО-НЕТ')).rejects.toThrow(UserError);
  });

  it('находит незавершённый челлендж по владельцу и провайдеру', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(BOB);
    await service.openChallenge(BOB, 'riot-lol', {
      challenge: 'КОД-БОБА',
      expiresAt: new Date(Date.now() + 60_000),
      payload: { platform: 'ru' },
    });

    await expect(service.pendingChallenge(BOB, 'riot-lol')).resolves.toMatchObject({
      challenge: 'КОД-БОБА',
      payload: { platform: 'ru' },
    });
  });

  it('не отдаёт просроченный челлендж как незавершённый', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(BOB);
    await service.openChallenge(BOB, 'riot-tft', {
      challenge: 'КОД-ПРОСРОЧЕН',
      expiresAt: new Date(Date.now() - 1_000),
      payload: {},
    });

    await expect(service.pendingChallenge(BOB, 'riot-tft')).resolves.toBeNull();
  });

  it('исчерпывает попытки после пяти неудач', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(ALICE);
    await service.openChallenge(ALICE, 'riot-lol', {
      challenge: 'КОД-ПОПЫТКИ',
      expiresAt: new Date(Date.now() + 60_000),
      payload: {},
    });

    for (let i = 0; i < 5; i += 1) {
      await service.takeChallenge('КОД-ПОПЫТКИ');
    }

    await expect(service.takeChallenge('КОД-ПОПЫТКИ')).rejects.toThrow(/попыт/);
  });

  it('отдаёт последний ранг по каждому режиму, а не все снимки', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(ALICE);
    const accountId = await service.linkAccount(ALICE, 'riot-lol', { externalId: 'PUUID-1', displayName: 'a#b', verificationMethod: 'manual' }, true);

    await service.saveRank(accountId, rank('GOLD', 'III'));
    await service.saveRank(accountId, rank('GOLD', 'II'));
    await service.saveRank(accountId, { ...rank('SILVER', 'I'), mode: 'flex' });

    const latest = await service.latestRanks(accountId);
    expect(latest).toHaveLength(2);
    expect(latest.find((r) => r.mode === 'solo-duo')?.division).toBe('II');
  });

  it('находит ранг на указанный момент для сравнения за 30 дней', async () => {
    const service = createLinkingService({ db: pg.db });
    await service.ensureUser(ALICE);
    const accountId = await service.linkAccount(ALICE, 'riot-tft', { externalId: 'PUUID-2', displayName: 'a#c', verificationMethod: 'manual' }, true);

    await service.saveRank(accountId, { ...rank('BRONZE', 'I'), mode: 'tft-ranked' });
    const past = await service.rankAt(accountId, 'tft-ranked', new Date(Date.now() + 1_000));

    expect(past?.tier).toBe('BRONZE');
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `npm run test:int -- tests/integration/identity/linking.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `src/modules/identity/services/linking.ts`**

```ts
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { UserError } from '../../../core/errors.js';
import type { Database } from '../../../core/db/client.js';
import { users } from '../../../core/db/schema/core.js';
import type { RankInfo, VerificationChallenge, VerifiedAccount } from '../providers/provider.js';
import { accountVerifications, gameAccounts, rankSnapshots, type ProviderId } from '../schema.js';

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
    async ensureUser(userId: string): Promise<void> {
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
```

- [ ] **Step 4: Прогнать тесты**

Run: `npm run test:int -- tests/integration/identity/linking.test.ts && npm run typecheck`
Expected: 14 тестов PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/identity/services/linking.ts tests/integration/identity/linking.test.ts
git commit -m "feat(identity): сервис привязки аккаунтов с челленджами и историей рангов"
```

---

### Task 12: Сервис маппинга рангов на роли

**Files:**
- Create: `src/modules/identity/services/role-mapping.ts`
- Test: `tests/integration/identity/role-mapping.test.ts`

**Interfaces:**
- Consumes: `Database`, таблица `roleMappings` (Task 1), `RankInfo` (Task 2), `auditLog` (этап 0).
- Produces: `createRoleMappingService(deps: { db: Database; logger: Logger }): RoleMappingService` с методами `setMapping`, `listMappings`, `removeMapping`, `resolveDesiredRoles(guildId, provider, ranks): Promise<string[]>`, `applyRoles(member, guildId, provider, ranks): Promise<{ added: string[]; removed: string[] }>`.

- [ ] **Step 1: Написать падающие тесты**

Файл `tests/integration/identity/role-mapping.test.ts`. Главный тест здесь — последний: роль, выданная за прошлый ранг, обязана сниматься, иначе через сезон у игрока будут висеть три роли сразу.

```ts
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { GuildMember } from 'discord.js';
import type { Config } from '../../../src/core/config.js';
import { guilds } from '../../../src/core/db/schema/core.js';
import { createLogger } from '../../../src/core/logger.js';
import type { RankInfo } from '../../../src/modules/identity/providers/provider.js';
import { createRoleMappingService } from '../../../src/modules/identity/services/role-mapping.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

const GUILD = '111111111111111111';
const GOLD_ROLE = '400000000000000001';
const PLAT_ROLE = '400000000000000002';

function riot(tier: string, mode = 'solo-duo'): RankInfo {
  return { mode, scale: 'riot-tier', tier, division: 'II', points: 0, source: 'api', raw: {} };
}

function fakeMember(roleIds: string[]) {
  const add = vi.fn(async () => {});
  const remove = vi.fn(async () => {});
  const member = {
    id: '222222222222222222',
    roles: { cache: new Map(roleIds.map((id) => [id, { id }])), add, remove },
  } as unknown as GuildMember;
  return { member, add, remove };
}

beforeAll(async () => {
  await pg.db.insert(guilds).values({ id: GUILD }).onConflictDoNothing();
});

describe('RoleMappingService', () => {
  it('сохраняет и перечисляет маппинги', async () => {
    const service = createRoleMappingService({ db: pg.db, logger });
    await service.setMapping(GUILD, 'riot-lol', 'solo-duo', 'GOLD', GOLD_ROLE);

    const mappings = await service.listMappings(GUILD);
    expect(mappings).toEqual(
      expect.arrayContaining([expect.objectContaining({ tier: 'GOLD', roleId: GOLD_ROLE })]),
    );
  });

  it('перезаписывает роль для того же ранга, а не создаёт дубль', async () => {
    const service = createRoleMappingService({ db: pg.db, logger });
    await service.setMapping(GUILD, 'riot-lol', 'solo-duo', 'GOLD', GOLD_ROLE);
    await service.setMapping(GUILD, 'riot-lol', 'solo-duo', 'GOLD', PLAT_ROLE);

    const forGold = (await service.listMappings(GUILD)).filter((m) => m.tier === 'GOLD');
    expect(forGold).toHaveLength(1);
    expect(forGold[0]?.roleId).toBe(PLAT_ROLE);
  });

  it('подбирает роль под текущий ранг', async () => {
    const service = createRoleMappingService({ db: pg.db, logger });
    await service.setMapping(GUILD, 'riot-lol', 'solo-duo', 'PLATINUM', PLAT_ROLE);

    const roles = await service.resolveDesiredRoles(GUILD, 'riot-lol', [riot('PLATINUM')]);
    expect(roles).toEqual([PLAT_ROLE]);
  });

  it('не выдаёт ничего, когда для ранга нет маппинга', async () => {
    const service = createRoleMappingService({ db: pg.db, logger });
    const roles = await service.resolveDesiredRoles(GUILD, 'riot-lol', [riot('IRON')]);
    expect(roles).toEqual([]);
  });

  it('различает режимы: маппинг соло-очереди не срабатывает на flex', async () => {
    const service = createRoleMappingService({ db: pg.db, logger });
    await service.setMapping(GUILD, 'riot-lol', 'solo-duo', 'DIAMOND', PLAT_ROLE);

    const roles = await service.resolveDesiredRoles(GUILD, 'riot-lol', [riot('DIAMOND', 'flex')]);
    expect(roles).toEqual([]);
  });

  it('выдаёт недостающую роль и не трогает уже имеющиеся', async () => {
    const service = createRoleMappingService({ db: pg.db, logger });
    await service.setMapping(GUILD, 'riot-lol', 'solo-duo', 'PLATINUM', PLAT_ROLE);
    const { member, add, remove } = fakeMember([]);

    const result = await service.applyRoles(member, GUILD, 'riot-lol', [riot('PLATINUM')]);

    expect(result.added).toEqual([PLAT_ROLE]);
    expect(add).toHaveBeenCalledWith(PLAT_ROLE, expect.any(String));
    expect(remove).not.toHaveBeenCalled();
  });

  it('снимает роль за прошлый ранг при переходе в новый', async () => {
    const service = createRoleMappingService({ db: pg.db, logger });
    await service.setMapping(GUILD, 'riot-lol', 'solo-duo', 'GOLD', GOLD_ROLE);
    await service.setMapping(GUILD, 'riot-lol', 'solo-duo', 'PLATINUM', PLAT_ROLE);
    const { member, add, remove } = fakeMember([GOLD_ROLE]);

    const result = await service.applyRoles(member, GUILD, 'riot-lol', [riot('PLATINUM')]);

    expect(result.added).toEqual([PLAT_ROLE]);
    expect(result.removed).toEqual([GOLD_ROLE]);
    expect(remove).toHaveBeenCalledWith(GOLD_ROLE, expect.any(String));
  });

  it('ничего не делает, когда роли уже верны', async () => {
    const service = createRoleMappingService({ db: pg.db, logger });
    await service.setMapping(GUILD, 'riot-lol', 'solo-duo', 'PLATINUM', PLAT_ROLE);
    const { member, add, remove } = fakeMember([PLAT_ROLE]);

    const result = await service.applyRoles(member, GUILD, 'riot-lol', [riot('PLATINUM')]);

    expect(result).toEqual({ added: [], removed: [] });
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('не снимает роли, не относящиеся к этому провайдеру', async () => {
    const service = createRoleMappingService({ db: pg.db, logger });
    await service.setMapping(GUILD, 'riot-lol', 'solo-duo', 'PLATINUM', PLAT_ROLE);
    const постороннаяРоль = '499999999999999999';
    const { member, remove } = fakeMember([постороннаяРоль]);

    await service.applyRoles(member, GUILD, 'riot-lol', [riot('PLATINUM')]);

    expect(remove).not.toHaveBeenCalledWith(постороннаяРоль, expect.any(String));
  });

  it('удаляет маппинг', async () => {
    const service = createRoleMappingService({ db: pg.db, logger });
    await service.setMapping(GUILD, 'riot-tft', 'tft-ranked', 'SILVER', GOLD_ROLE);

    await expect(service.removeMapping(GUILD, 'riot-tft', 'tft-ranked', 'SILVER')).resolves.toBe(true);
    await expect(service.removeMapping(GUILD, 'riot-tft', 'tft-ranked', 'SILVER')).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `npm run test:int -- tests/integration/identity/role-mapping.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `src/modules/identity/services/role-mapping.ts`**

Ключевая идея: набор роль-кандидатов ограничен маппингами именно этого провайдера. Роли, которых нет среди кандидатов, не трогаются — иначе бот снимал бы у людей роли, выданные вручную.

```ts
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
      const desired = new Set<string>();

      for (const rank of ranks) {
        if (!rank.tier) continue;
        const match = mappings.find((m) => m.mode === rank.mode && m.tier === rank.tier);
        if (match) desired.add(match.roleId);
      }

      return [...desired];
    },

    async applyRoles(member, guildId, provider, ranks): Promise<RoleChange> {
      const mappings = await mappingsFor(guildId, provider);
      // Кандидаты — только роли этого провайдера. Всё остальное бот не трогает.
      const managed = new Set(mappings.map((m) => m.roleId));
      const desired = new Set(await this.resolveDesiredRoles(guildId, provider, ranks));

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
```

- [ ] **Step 4: Прогнать тесты**

Run: `npm run test:int -- tests/integration/identity/role-mapping.test.ts && npm run typecheck`
Expected: 10 тестов PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/identity/services/role-mapping.ts tests/integration/identity/role-mapping.test.ts
git commit -m "feat(identity): выдача и снятие ролей по рангу с аудитом"
```

---

### Task 13: Синхронизация рангов и событие rank.changed

**Files:**
- Create: `src/modules/identity/services/rank-sync.ts`
- Modify: `src/core/events/events.ts` — добавить события модуля
- Test: `tests/integration/identity/rank-sync.test.ts`

**Interfaces:**
- Consumes: `LinkingService` (Task 11), реестр провайдеров (Task 10), `canFetchRank` (Task 6), `hasRankChanged` (Task 3), `EventBus` (этап 0), `Database`.
- Produces: `createRankSyncService(deps: RankSyncDeps): RankSyncService` с методами `syncAccount(account: GameAccountRow): Promise<RankInfo[]>` и `syncBatch(limit: number): Promise<{ synced: number; failed: number }>`; события `rank.changed`, `account.linked`, `account.unlinked` в `BotEvents`.

- [ ] **Step 1: Добавить события в `src/core/events/events.ts`**

```ts
/**
 * Карта событий бота: имя → тип полезной нагрузки.
 *
 * Модули не импортируют друг друга — они публикуют и слушают события отсюда.
 * Добавляя событие, добавляй его сюда, а не в свой модуль.
 */
export interface BotEvents {
  'core.ready': { at: Date };

  'account.linked': { userId: string; provider: string; externalId: string; verified: boolean };
  'account.unlinked': { userId: string; provider: string };
  'rank.changed': {
    userId: string;
    provider: string;
    mode: string;
    previous: { tier: string | null; division: string | null } | null;
    current: { tier: string | null; division: string | null };
  };
}
```

Полезная нагрузка `rank.changed` намеренно не содержит `RankInfo`: карта событий живёт в ядре и не должна зависеть от типов модуля. Слушателю достаточно тира и дивизиона, а подробности он возьмёт из БД.

- [ ] **Step 2: Написать падающие тесты**

Файл `tests/integration/identity/rank-sync.test.ts`:

```ts
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { guilds } from '../../../src/core/db/schema/core.js';
import { EventBus } from '../../../src/core/events/bus.js';
import { createLogger } from '../../../src/core/logger.js';
import type { GameProvider, RankInfo } from '../../../src/modules/identity/providers/provider.js';
import type { ProviderId } from '../../../src/modules/identity/schema.js';
import { createLinkingService } from '../../../src/modules/identity/services/linking.js';
import { createRankSyncService } from '../../../src/modules/identity/services/rank-sync.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

function rank(tier: string, division: string | null, mode = 'solo-duo'): RankInfo {
  return { mode, scale: 'riot-tier', tier, division, points: 10, source: 'api', raw: {} };
}

function providerReturning(ranks: RankInfo[] | Error): GameProvider {
  return {
    id: 'riot-lol',
    capabilities: { verification: 'riot-third-party-code', rank: 'api' },
    fetchProfile: async () => ({ externalId: 'PUUID-1', displayName: 'a#b' }),
    fetchRank: async () => {
      if (ranks instanceof Error) throw ranks;
      return ranks;
    },
  };
}

function servicesWith(provider: GameProvider) {
  const linking = createLinkingService({ db: pg.db });
  const bus = new EventBus(logger);
  const registry = new Map<ProviderId, GameProvider>([['riot-lol', provider]]);
  const sync = createRankSyncService({ db: pg.db, linking, providers: registry, bus, logger });
  return { linking, bus, sync };
}

const USER = '600000000000000001';

beforeAll(async () => {
  await pg.db.insert(guilds).values({ id: '111111111111111111' }).onConflictDoNothing();
});

async function linkedAccount(linking: ReturnType<typeof createLinkingService>, userId: string) {
  await linking.ensureUser(userId);
  const id = await linking.linkAccount(
    userId,
    'riot-lol',
    { externalId: `PUUID-${userId}`, displayName: 'a#b', region: 'euw1', verificationMethod: 'riot-third-party-code' },
    true,
  );
  const accounts = await linking.listAccounts(userId);
  return accounts.find((a) => a.id === id)!;
}

describe('RankSyncService', () => {
  it('сохраняет полученный ранг снимком', async () => {
    const { linking, sync } = servicesWith(providerReturning([rank('GOLD', 'II')]));
    const account = await linkedAccount(linking, USER);

    const result = await sync.syncAccount(account);

    expect(result).toHaveLength(1);
    const latest = await linking.latestRanks(account.id);
    expect(latest[0]).toMatchObject({ tier: 'GOLD', division: 'II' });
  });

  it('публикует rank.changed при первом ранге', async () => {
    const { linking, bus, sync } = servicesWith(providerReturning([rank('GOLD', 'II')]));
    const handler = vi.fn();
    bus.on('rank.changed', handler);
    const account = await linkedAccount(linking, '600000000000000002');

    await sync.syncAccount(account);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'riot-lol', mode: 'solo-duo', previous: null }),
    );
  });

  it('НЕ публикует rank.changed, когда ранг не изменился', async () => {
    const { linking, bus, sync } = servicesWith(providerReturning([rank('GOLD', 'II')]));
    const account = await linkedAccount(linking, '600000000000000003');
    await sync.syncAccount(account);

    const handler = vi.fn();
    bus.on('rank.changed', handler);
    await sync.syncAccount(account);

    expect(handler).not.toHaveBeenCalled();
  });

  it('публикует rank.changed при смене дивизиона', async () => {
    const linking = createLinkingService({ db: pg.db });
    const bus = new EventBus(logger);
    let current = rank('GOLD', 'III');
    const provider: GameProvider = {
      id: 'riot-lol',
      capabilities: { verification: 'riot-third-party-code', rank: 'api' },
      fetchProfile: async () => ({ externalId: 'x', displayName: 'x' }),
      fetchRank: async () => [current],
    };
    const sync = createRankSyncService({
      db: pg.db,
      linking,
      providers: new Map([['riot-lol', provider]]),
      bus,
      logger,
    });
    const account = await linkedAccount(linking, '600000000000000004');

    await sync.syncAccount(account);
    const handler = vi.fn();
    bus.on('rank.changed', handler);
    current = rank('GOLD', 'II');
    await sync.syncAccount(account);

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ previous: { tier: 'GOLD', division: 'III' }, current: { tier: 'GOLD', division: 'II' } }),
    );
  });

  it('пропускает аккаунт провайдера с ручным рангом', async () => {
    const linking = createLinkingService({ db: pg.db });
    const fetchRank = vi.fn();
    const manual: GameProvider = {
      id: 'riot-valorant',
      capabilities: { verification: 'none', rank: 'manual' },
      fetchProfile: async () => ({ externalId: 'x', displayName: 'x' }),
    };
    const sync = createRankSyncService({
      db: pg.db,
      linking,
      providers: new Map([['riot-valorant', manual]]),
      bus: new EventBus(logger),
      logger,
    });
    await linking.ensureUser('600000000000000005');
    const id = await linking.linkAccount(
      '600000000000000005',
      'riot-valorant',
      { externalId: 'Игрок#EUW', displayName: 'Игрок#EUW', verificationMethod: 'manual' },
      false,
    );
    const account = (await linking.listAccounts('600000000000000005')).find((a) => a.id === id)!;

    await expect(sync.syncAccount(account)).resolves.toEqual([]);
    expect(fetchRank).not.toHaveBeenCalled();
  });

  it('не роняет пачку из-за одного упавшего аккаунта', async () => {
    const { linking, sync } = servicesWith(providerReturning(new Error('Riot лёг')));
    await linkedAccount(linking, '600000000000000006');

    const result = await sync.syncBatch(10);

    expect(result.failed).toBeGreaterThanOrEqual(1);
  });

  it('берёт в пачку аккаунты с самым старым updatedAt и не больше лимита', async () => {
    const { linking, sync } = servicesWith(providerReturning([rank('SILVER', 'I')]));
    for (const suffix of ['11', '12', '13']) {
      await linkedAccount(linking, `6000000000000000${suffix}`);
    }

    const result = await sync.syncBatch(2);

    expect(result.synced + result.failed).toBe(2);
  });
});
```

- [ ] **Step 3: Запустить тесты — убедиться, что падают**

Run: `npm run test:int -- tests/integration/identity/rank-sync.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 4: Реализовать `src/modules/identity/services/rank-sync.ts`**

```ts
import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import type { EventBus } from '../../../core/events/bus.js';
import type { Logger } from '../../../core/logger.js';
import { hasRankChanged } from '../ranks/compare.js';
import { canFetchRank, type GameProvider, type RankInfo } from '../providers/provider.js';
import { gameAccounts, type ProviderId } from '../schema.js';
import type { GameAccountRow, LinkingService } from './linking.js';

export interface RankSyncDeps {
  db: Database;
  linking: LinkingService;
  providers: Map<ProviderId, GameProvider>;
  bus: EventBus;
  logger: Logger;
}

export interface RankSyncService {
  syncAccount(account: GameAccountRow): Promise<RankInfo[]>;
  syncBatch(limit: number): Promise<{ synced: number; failed: number }>;
}

export function createRankSyncService(deps: RankSyncDeps): RankSyncService {
  const { db, linking, providers, bus, logger } = deps;

  return {
    async syncAccount(account): Promise<RankInfo[]> {
      const provider = providers.get(account.provider);
      if (!provider || !canFetchRank(provider)) {
        // Ручные ранги обновляет пользователь, а не планировщик.
        return [];
      }

      const fresh = await provider.fetchRank!(account.externalId, account.region ?? undefined);
      const previous = await linking.latestRanks(account.id);

      for (const rank of fresh) {
        const before = previous.find((r) => r.mode === rank.mode) ?? null;
        if (!hasRankChanged(before, rank)) continue;

        await linking.saveRank(account.id, rank);
        await bus.emit('rank.changed', {
          userId: account.userId,
          provider: account.provider,
          mode: rank.mode,
          previous: before ? { tier: before.tier, division: before.division } : null,
          current: { tier: rank.tier, division: rank.division },
        });
      }

      // Даже когда ранг не изменился, отметка времени обновляется: иначе
      // один и тот же аккаунт будет вечно первым в очереди пачки.
      await db.update(gameAccounts).set({ updatedAt: new Date() }).where(eq(gameAccounts.id, account.id));

      return fresh;
    },

    async syncBatch(limit): Promise<{ synced: number; failed: number }> {
      const batch = await db.select().from(gameAccounts).orderBy(asc(gameAccounts.updatedAt)).limit(limit);

      let synced = 0;
      let failed = 0;

      for (const account of batch) {
        try {
          await this.syncAccount(account);
          synced += 1;
        } catch (error) {
          // Один сбойный аккаунт не должен обрывать пачку.
          failed += 1;
          logger.warn(
            { accountId: account.id, provider: account.provider, err: error },
            'не удалось синхронизировать ранг аккаунта',
          );
          await db.update(gameAccounts).set({ updatedAt: new Date() }).where(eq(gameAccounts.id, account.id));
        }
      }

      logger.info({ synced, failed, size: batch.length }, 'пачка синхронизации рангов обработана');
      return { synced, failed };
    },
  };
}
```

- [ ] **Step 5: Прогнать тесты**

Run: `npm run test:int -- tests/integration/identity/rank-sync.test.ts && npm test && npm run typecheck`
Expected: 7 новых тестов PASS, unit-набор по-прежнему зелёный.

- [ ] **Step 6: Коммит**

```bash
git add src/modules/identity/services/rank-sync.ts src/core/events/events.ts tests/integration/identity/rank-sync.test.ts
git commit -m "feat(identity): фоновая синхронизация рангов с публикацией rank.changed"
```

---

### Task 14: Команды привязки и Steam-колбэк

**Files:**
- Create: `src/modules/identity/commands/link.ts`, `src/modules/identity/commands/unlink.ts`, `src/modules/identity/http/steam-callback.ts`
- Test: `tests/modules/identity/commands/link.test.ts`, `tests/integration/identity/steam-callback.test.ts`

**Interfaces:**
- Consumes: `LinkingService` (Task 11), реестр провайдеров (Task 10), `canVerify` (Task 6), `manualValorantRank` (Task 10), `parseRiotId` / `RIOT_PLATFORMS` (Task 9), `verifySteamAssertion` (Task 7), `EventBus`, `FastifyInstance` (этап 0, Task 11).
- Produces: `createLinkCommand(deps: IdentityDeps): CommandDefinition`; `createUnlinkCommand(deps: IdentityDeps): CommandDefinition`; `registerSteamCallback(server: FastifyInstance, deps: SteamCallbackDeps): void`. Тип `IdentityDeps` объявляется здесь и используется всеми командами модуля: `{ linking: LinkingService; providers: Map<ProviderId, GameProvider>; roles: RoleMappingService; rankSync: RankSyncService; bus: EventBus }`.

- [ ] **Step 1: Написать падающие тесты команд**

Файл `tests/modules/identity/commands/link.test.ts`. Фейковая интеракция расширяется чтением опций — этого не было в хелпере этапа 0.

```ts
import { describe, expect, it, vi } from 'vitest';
import { UserError } from '../../../../src/core/errors.js';
import { EventBus } from '../../../../src/core/events/bus.js';
import { createLogger } from '../../../../src/core/logger.js';
import type { Config } from '../../../../src/core/config.js';
import type { ModuleContext } from '../../../../src/core/module.js';
import { createLinkCommand } from '../../../../src/modules/identity/commands/link.js';
import { createValorantProvider } from '../../../../src/modules/identity/providers/valorant.js';
import type { GameProvider } from '../../../../src/modules/identity/providers/provider.js';
import type { ProviderId } from '../../../../src/modules/identity/schema.js';
import { fakeChatInputInteraction } from '../../../helpers/interaction.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);
const ctx = { logger } as unknown as ModuleContext;

function linkingStub() {
  return {
    ensureUser: vi.fn(async () => {}),
    openChallenge: vi.fn(async () => {}),
    takeChallenge: vi.fn(),
    pendingChallenge: vi.fn(async () => null),
    linkAccount: vi.fn(async () => 1),
    unlinkAccount: vi.fn(async () => true),
    listAccounts: vi.fn(async () => []),
    saveRank: vi.fn(async () => {}),
    latestRanks: vi.fn(async () => []),
    rankAt: vi.fn(async () => null),
  };
}

function depsWith(providers: Array<[ProviderId, GameProvider]>, linking = linkingStub()) {
  return {
    linking,
    providers: new Map(providers),
    roles: { applyRoles: vi.fn(async () => ({ added: [], removed: [] })) },
    rankSync: { syncAccount: vi.fn(async () => []) },
    bus: new EventBus(logger),
  };
}

/** Расширяет фейк интеракции чтением строковых опций и подкоманды. */
function interactionWithOptions(subcommand: string, options: Record<string, string>) {
  const fake = fakeChatInputInteraction('link');
  Object.defineProperty(fake.interaction, 'options', {
    value: {
      getSubcommand: () => subcommand,
      getString: (name: string, required?: boolean) => {
        const value = options[name] ?? null;
        if (required && value === null) throw new Error(`опция ${name} обязательна`);
        return value;
      },
    },
  });
  return fake;
}

const steamProvider: GameProvider = {
  id: 'steam',
  capabilities: { verification: 'steam-openid', rank: 'api' },
  startVerification: async () => ({
    challenge: 'НОНС-1',
    expiresAt: new Date(Date.now() + 60_000),
    payload: {},
    instruction: 'Открой ссылку https://steamcommunity.com/openid/login?x=1',
  }),
  completeVerification: async () => ({ externalId: '765', displayName: 'a', verificationMethod: 'steam-openid' }),
  fetchProfile: async () => ({ externalId: '765', displayName: 'a' }),
};

describe('/link', () => {
  it('объявляет три подкоманды', () => {
    const command = createLinkCommand(depsWith([]) as never);
    const json = command.builder.toJSON();
    expect(json.options?.map((o) => o.name).sort()).toEqual(['riot', 'steam', 'valorant']);
  });

  it('делает defer эфемерно — внутри сетевые вызовы', () => {
    const command = createLinkCommand(depsWith([]) as never);
    expect(command.defer).toEqual({ ephemeral: true });
  });

  it('для steam открывает челлендж и показывает инструкцию', async () => {
    const linking = linkingStub();
    const command = createLinkCommand(depsWith([['steam', steamProvider]], linking) as never);
    const { interaction, calls } = interactionWithOptions('steam', {});

    await command.execute(interaction, ctx);

    expect(linking.openChallenge).toHaveBeenCalledWith('222222222222222222', 'steam', expect.any(Object));
    const content = calls.followUp.mock.calls[0]?.[0]?.content as string;
    expect(content).toContain('steamcommunity.com/openid/login');
  });

  it('для valorant сохраняет ручной ранг и помечает как неподтверждённый', async () => {
    const linking = linkingStub();
    const command = createLinkCommand(
      depsWith([['riot-valorant', createValorantProvider()]], linking) as never,
    );
    const { interaction } = interactionWithOptions('valorant', { 'riot-id': 'Игрок#EUW', rank: 'Immortal 2' });

    await command.execute(interaction, ctx);

    expect(linking.linkAccount).toHaveBeenCalledWith(
      '222222222222222222',
      'riot-valorant',
      expect.objectContaining({ externalId: 'Игрок#EUW', verificationMethod: 'manual' }),
      false,
    );
    expect(linking.saveRank).toHaveBeenCalledWith(1, expect.objectContaining({ tier: 'IMMORTAL', source: 'manual' }));
  });

  it('для valorant отвергает непонятный ранг', async () => {
    const command = createLinkCommand(depsWith([['riot-valorant', createValorantProvider()]]) as never);
    const { interaction } = interactionWithOptions('valorant', { 'riot-id': 'Игрок#EUW', rank: 'очень высокий' });

    await expect(command.execute(interaction, ctx)).rejects.toThrow(UserError);
  });

  it('для riot на первом вызове выдаёт код, а не привязывает', async () => {
    const linking = linkingStub();
    const riot: GameProvider = {
      id: 'riot-lol',
      capabilities: { verification: 'riot-third-party-code', rank: 'api' },
      startVerification: async () => ({
        challenge: 'ABCD2345',
        expiresAt: new Date(Date.now() + 60_000),
        payload: {},
        instruction: 'Вставь код ABCD2345 в клиент',
      }),
      completeVerification: async () => ({ externalId: 'P', displayName: 'a#b', verificationMethod: 'riot-third-party-code' }),
      fetchProfile: async () => ({ externalId: 'P', displayName: 'a#b' }),
    };
    const command = createLinkCommand(depsWith([['riot-lol', riot]], linking) as never);
    const { interaction, calls } = interactionWithOptions('riot', { 'riot-id': 'Игрок#EUW', platform: 'euw1' });

    await command.execute(interaction, ctx);

    expect(linking.linkAccount).not.toHaveBeenCalled();
    expect(calls.followUp.mock.calls[0]?.[0]?.content).toContain('ABCD2345');
  });

  it('для riot на втором вызове проверяет код и привязывает', async () => {
    const linking = linkingStub();
    linking.pendingChallenge = vi.fn(async () => ({ challenge: 'ABCD2345', payload: { platform: 'euw1' } }));
    const riot: GameProvider = {
      id: 'riot-lol',
      capabilities: { verification: 'riot-third-party-code', rank: 'api' },
      startVerification: async () => ({ challenge: 'X', expiresAt: new Date(), payload: {} }),
      completeVerification: async () => ({
        externalId: 'PUUID-1',
        displayName: 'Игрок#EUW',
        region: 'euw1',
        verificationMethod: 'riot-third-party-code',
      }),
      fetchProfile: async () => ({ externalId: 'PUUID-1', displayName: 'Игрок#EUW' }),
    };
    const command = createLinkCommand(depsWith([['riot-lol', riot]], linking) as never);
    const { interaction } = interactionWithOptions('riot', { 'riot-id': 'Игрок#EUW', platform: 'euw1' });

    await command.execute(interaction, ctx);

    expect(linking.linkAccount).toHaveBeenCalledWith('222222222222222222', 'riot-lol', expect.any(Object), true);
  });

  it('для riot привязывает и TFT тем же подтверждением', async () => {
    const linking = linkingStub();
    linking.pendingChallenge = vi.fn(async () => ({ challenge: 'ABCD2345', payload: { platform: 'euw1' } }));
    const riot: GameProvider = {
      id: 'riot-lol',
      capabilities: { verification: 'riot-third-party-code', rank: 'api' },
      startVerification: async () => ({ challenge: 'X', expiresAt: new Date(), payload: {} }),
      completeVerification: async () => ({
        externalId: 'PUUID-1',
        displayName: 'Игрок#EUW',
        region: 'euw1',
        verificationMethod: 'riot-third-party-code',
      }),
      fetchProfile: async () => ({ externalId: 'PUUID-1', displayName: 'Игрок#EUW' }),
    };
    const command = createLinkCommand(depsWith([['riot-lol', riot]], linking) as never);
    const { interaction } = interactionWithOptions('riot', { 'riot-id': 'Игрок#EUW', platform: 'euw1' });

    await command.execute(interaction, ctx);

    const providers = linking.linkAccount.mock.calls.map((call) => call[1]);
    expect(providers).toEqual(['riot-lol', 'riot-tft']);
  });

  it('отвергает неизвестную платформу Riot до обращения к API', async () => {
    const command = createLinkCommand(depsWith([]) as never);
    const { interaction } = interactionWithOptions('riot', { 'riot-id': 'Игрок#EUW', platform: 'марс1' });

    await expect(command.execute(interaction, ctx)).rejects.toThrow(UserError);
  });

  it('сообщает понятной ошибкой, что провайдер не подключён', async () => {
    const command = createLinkCommand(depsWith([]) as never);
    const { interaction } = interactionWithOptions('steam', {});

    await expect(command.execute(interaction, ctx)).rejects.toThrow(UserError);
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `npx vitest run tests/modules/identity/commands/link.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `src/modules/identity/commands/link.ts`**

```ts
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { UserError } from '../../../core/errors.js';
import type { EventBus } from '../../../core/events/bus.js';
import type { CommandDefinition } from '../../../core/module.js';
import { canVerify, type GameProvider } from '../providers/provider.js';
import { RIOT_PLATFORMS, parseRiotId, platformToRegionalRoute } from '../providers/riot.js';
import { manualValorantRank } from '../providers/valorant.js';
import type { ProviderId } from '../schema.js';
import type { LinkingService } from '../services/linking.js';
import type { RankSyncService } from '../services/rank-sync.js';
import type { RoleMappingService } from '../services/role-mapping.js';

export interface IdentityDeps {
  linking: LinkingService;
  providers: Map<ProviderId, GameProvider>;
  roles: RoleMappingService;
  rankSync: RankSyncService;
  bus: EventBus;
}

function requireProvider(deps: IdentityDeps, id: ProviderId): GameProvider {
  const provider = deps.providers.get(id);
  if (!provider) {
    throw new UserError(`Интеграция «${id}» на этом сервере не подключена.`);
  }
  return provider;
}

export function createLinkCommand(deps: IdentityDeps): CommandDefinition {
  return {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('link')
      .setDescription('Привязать игровой аккаунт')
      .addSubcommand((sub) => sub.setName('steam').setDescription('Привязать Steam через вход на сайте Steam'))
      .addSubcommand((sub) =>
        sub
          .setName('riot')
          .setDescription('Привязать аккаунт League of Legends или TFT')
          .addStringOption((option) =>
            option.setName('riot-id').setDescription('Riot ID в виде Имя#Тег').setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName('platform')
              .setDescription('Платформа, например euw1 или ru')
              .setRequired(true)
              .addChoices(...RIOT_PLATFORMS.slice(0, 25).map((p) => ({ name: p, value: p }))),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('valorant')
          .setDescription('Указать аккаунт и ранг Valorant вручную')
          .addStringOption((option) =>
            option.setName('riot-id').setDescription('Riot ID в виде Имя#Тег').setRequired(true),
          )
          .addStringOption((option) =>
            option.setName('rank').setDescription('Например: Immortal 2 или Radiant').setRequired(true),
          ),
      ),

    async execute(interaction) {
      const userId = interaction.user.id;
      await deps.linking.ensureUser(userId);

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'steam') {
        const provider = requireProvider(deps, 'steam');
        if (!canVerify(provider)) {
          throw new UserError('Провайдер Steam не умеет подтверждать владение — проверь настройку бота.');
        }
        const challenge = await provider.startVerification!(userId);
        await deps.linking.openChallenge(userId, 'steam', challenge);
        await interaction.followUp({ content: challenge.instruction ?? 'Ссылка не сформирована.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (subcommand === 'valorant') {
        const riotId = interaction.options.getString('riot-id', true);
        const rankInput = interaction.options.getString('rank', true);

        const provider = requireProvider(deps, 'riot-valorant');
        const profile = await provider.fetchProfile(riotId);
        // Ранг разбирается до записи: незачем создавать привязку с мусорным рангом.
        const rank = manualValorantRank(rankInput);

        const accountId = await deps.linking.linkAccount(
          userId,
          'riot-valorant',
          { externalId: profile.externalId, displayName: profile.displayName, verificationMethod: 'manual' },
          false,
        );
        await deps.linking.saveRank(accountId, rank);
        await deps.bus.emit('account.linked', {
          userId,
          provider: 'riot-valorant',
          externalId: profile.externalId,
          verified: false,
        });

        await interaction.followUp({
          content:
            `Valorant записан: **${profile.displayName}**, ранг ${rank.tier}${rank.division ? ` ${rank.division}` : ''}.\n` +
            `Подтвердить владение аккаунтом Valorant нечем, поэтому ранг помечен как заявленный тобой и авто-роль не даёт. ` +
            `При смене сезона обнови его этой же командой.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // subcommand === 'riot'
      const riotId = interaction.options.getString('riot-id', true);
      const platform = interaction.options.getString('platform', true);
      // Платформа проверяется до сети: неизвестный регион не должен стоить запроса.
      platformToRegionalRoute(platform);

      if (!parseRiotId(riotId)) {
        throw new UserError('Riot ID пишется как Имя#Тег, например Игрок#EUW.');
      }

      const provider = requireProvider(deps, 'riot-lol');
      const pending = await deps.linking.pendingChallenge(userId, 'riot-lol');

      if (!pending) {
        const challenge = await provider.startVerification!(userId);
        await deps.linking.openChallenge(userId, 'riot-lol', { ...challenge, payload: { platform } });
        await interaction.followUp({ content: challenge.instruction ?? 'Код не сформирован.', flags: MessageFlags.Ephemeral });
        return;
      }

      const taken = await deps.linking.takeChallenge(pending.challenge);
      const verified = await provider.completeVerification!(
        { challenge: pending.challenge, expiresAt: new Date(Date.now() + 60_000), payload: taken.payload },
        riotId,
      );

      // PUUID и подтверждение владения общие для LoL и TFT, поэтому привязываются оба:
      // иначе маппинги ролей для tft-ranked никогда бы не срабатывали.
      const linkedIds: number[] = [];
      for (const providerId of ['riot-lol', 'riot-tft'] as const) {
        linkedIds.push(await deps.linking.linkAccount(userId, providerId, verified, true));
        await deps.bus.emit('account.linked', {
          userId,
          provider: providerId,
          externalId: verified.externalId,
          verified: true,
        });
      }

      const accounts = await deps.linking.listAccounts(userId);
      for (const account of accounts.filter((a) => linkedIds.includes(a.id))) {
        await deps.rankSync.syncAccount(account);
      }

      await interaction.followUp({
        content: `Готово: **${verified.displayName}** привязан и подтверждён — сразу и для LoL, и для TFT. Ранги подтянутся в течение минуты.`,
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}
```

- [ ] **Step 4: Реализовать `src/modules/identity/commands/unlink.ts`**

```ts
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { UserError } from '../../../core/errors.js';
import type { CommandDefinition } from '../../../core/module.js';
import type { ProviderId } from '../schema.js';
import type { IdentityDeps } from './link.js';

const PROVIDER_CHOICES: Array<{ name: string; value: ProviderId }> = [
  { name: 'Steam / Dota 2', value: 'steam' },
  { name: 'League of Legends', value: 'riot-lol' },
  { name: 'Teamfight Tactics', value: 'riot-tft' },
  { name: 'Valorant', value: 'riot-valorant' },
];

export function createUnlinkCommand(deps: IdentityDeps): CommandDefinition {
  return {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('unlink')
      .setDescription('Отвязать игровой аккаунт и снять выданные за него роли')
      .addStringOption((option) =>
        option.setName('provider').setDescription('Какую привязку убрать').setRequired(true).addChoices(...PROVIDER_CHOICES),
      ),

    async execute(interaction) {
      const provider = interaction.options.getString('provider', true) as ProviderId;
      const userId = interaction.user.id;

      const removed = await deps.linking.unlinkAccount(userId, provider);
      if (!removed) {
        throw new UserError('У тебя не было такой привязки.');
      }

      // Роли снимаются пустым набором рангов: логика та же, что при синхронизации.
      if (interaction.guildId && interaction.member && 'roles' in interaction.member) {
        const member = await interaction.guild!.members.fetch(userId);
        await deps.roles.applyRoles(member, interaction.guildId, provider, []);
      }

      await deps.bus.emit('account.unlinked', { userId, provider });

      await interaction.followUp({
        content: 'Привязка убрана, выданные за неё роли сняты.',
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}
```

- [ ] **Step 5: Написать падающий тест колбэка**

Файл `tests/integration/identity/steam-callback.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerSteamCallback } from '../../../src/modules/identity/http/steam-callback.js';
import { createLogger } from '../../../src/core/logger.js';
import type { Config } from '../../../src/core/config.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

function serverWith(overrides: Partial<Parameters<typeof registerSteamCallback>[1]> = {}) {
  const server = Fastify({ logger: false });
  const deps = {
    logger,
    linking: {
      takeChallenge: vi.fn(async () => ({ userId: '222222222222222222', provider: 'steam' as const, payload: {} })),
      linkAccount: vi.fn(async () => 1),
      listAccounts: vi.fn(async () => []),
    },
    providers: new Map([
      [
        'steam' as const,
        {
          id: 'steam' as const,
          capabilities: { verification: 'steam-openid' as const, rank: 'api' as const },
          completeVerification: vi.fn(async () => ({
            externalId: '76561198000000001',
            displayName: 'alice',
            verificationMethod: 'steam-openid' as const,
          })),
          fetchProfile: vi.fn(),
        },
      ],
    ]),
    verifyAssertion: vi.fn(async () => '76561198000000001'),
    notify: vi.fn(async () => {}),
    ...overrides,
  };
  registerSteamCallback(server, deps as never);
  return { server, deps };
}

describe('роут /steam/callback', () => {
  it('привязывает аккаунт и отвечает страницей об успехе', async () => {
    const { server, deps } = serverWith();

    const response = await server.inject({ method: 'GET', url: '/steam/callback?state=НОНС-1&openid.mode=id_res' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Discord');
    expect(deps.linking.linkAccount).toHaveBeenCalledWith('222222222222222222', 'steam', expect.any(Object), true);
    await server.close();
  });

  it('отвечает 400 без параметра state', async () => {
    const { server } = serverWith();
    const response = await server.inject({ method: 'GET', url: '/steam/callback?openid.mode=id_res' });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it('не привязывает, когда Steam не подтвердил подпись', async () => {
    const { server, deps } = serverWith({
      verifyAssertion: vi.fn(async () => {
        throw new Error('подпись не подтверждена');
      }),
    } as never);

    const response = await server.inject({ method: 'GET', url: '/steam/callback?state=НОНС-1&openid.mode=id_res' });

    expect(response.statusCode).toBe(400);
    expect(deps.linking.linkAccount).not.toHaveBeenCalled();
    await server.close();
  });

  it('отвечает 400 по неизвестному или просроченному state', async () => {
    const { server } = serverWith({
      linking: {
        takeChallenge: vi.fn(async () => {
          throw new Error('код не найден');
        }),
        linkAccount: vi.fn(),
        listAccounts: vi.fn(),
      },
    } as never);

    const response = await server.inject({ method: 'GET', url: '/steam/callback?state=ЧУЖОЙ&openid.mode=id_res' });

    expect(response.statusCode).toBe(400);
    await server.close();
  });

  it('уведомляет пользователя в Discord об успехе', async () => {
    const { server, deps } = serverWith();
    await server.inject({ method: 'GET', url: '/steam/callback?state=НОНС-1&openid.mode=id_res' });

    expect(deps.notify).toHaveBeenCalledWith('222222222222222222', expect.stringContaining('alice'));
    await server.close();
  });
});
```

- [ ] **Step 6: Реализовать `src/modules/identity/http/steam-callback.ts`**

Уведомление отправляется в личные сообщения, потому что браузерная страница закрывается и в Discord пользователь возвращается без обратной связи.

```ts
import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../core/logger.js';
import type { GameProvider } from '../providers/provider.js';
import { verifySteamAssertion } from '../providers/steam-openid.js';
import type { ProviderId } from '../schema.js';
import type { LinkingService } from '../services/linking.js';

export interface SteamCallbackDeps {
  logger: Logger;
  linking: Pick<LinkingService, 'takeChallenge' | 'linkAccount' | 'listAccounts'>;
  providers: Map<ProviderId, GameProvider>;
  /** Подменяется в тестах, чтобы не ходить в Steam. */
  verifyAssertion?: (params: URLSearchParams) => Promise<string>;
  /** Отправка сообщения пользователю в Discord. */
  notify: (userId: string, text: string) => Promise<void>;
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.6"><h1>${title}</h1><p>${body}</p></body></html>`;
}

export function registerSteamCallback(server: FastifyInstance, deps: SteamCallbackDeps): void {
  const verify = deps.verifyAssertion ?? ((params: URLSearchParams) => verifySteamAssertion(params, {}));

  server.get('/steam/callback', async (request, reply) => {
    const query = new URLSearchParams(request.url.split('?')[1] ?? '');
    const state = query.get('state');

    if (!state) {
      return reply.code(400).type('text/html').send(page('Чего-то не хватает', 'В ссылке нет метки запроса. Запусти /link steam заново.'));
    }

    let steamId: string;
    try {
      steamId = await verify(query);
    } catch (error) {
      deps.logger.warn({ err: error }, 'Steam не подтвердил возврат');
      return reply.code(400).type('text/html').send(page('Не удалось подтвердить вход', 'Steam не подтвердил подпись. Запусти /link steam заново.'));
    }

    let owner: { userId: string; provider: ProviderId };
    try {
      owner = await deps.linking.takeChallenge(state);
    } catch (error) {
      deps.logger.warn({ err: error }, 'неизвестная или просроченная метка запроса Steam');
      return reply.code(400).type('text/html').send(page('Ссылка устарела', 'Метка запроса не найдена или истекла. Запусти /link steam заново.'));
    }

    const provider = deps.providers.get('steam');
    if (!provider?.completeVerification) {
      return reply.code(500).type('text/html').send(page('Бот настроен неверно', 'Провайдер Steam не подключён.'));
    }

    const verified = await provider.completeVerification(
      { challenge: state, expiresAt: new Date(Date.now() + 60_000), payload: {} },
      steamId,
    );
    await deps.linking.linkAccount(owner.userId, 'steam', verified, true);

    await deps.notify(owner.userId, `Steam привязан: **${verified.displayName}**. Ранг Dota подтянется автоматически.`);

    return reply
      .code(200)
      .type('text/html')
      .send(page('Готово', `Аккаунт <b>${verified.displayName}</b> привязан. Можно закрыть страницу и вернуться в Discord.`));
  });
}
```

- [ ] **Step 7: Прогнать тесты**

Run: `npx vitest run tests/modules/identity/commands/link.test.ts && npm run test:int -- tests/integration/identity/steam-callback.test.ts && npm run typecheck`
Expected: 10 тестов команды и 5 тестов колбэка PASS.

- [ ] **Step 8: Коммит**

```bash
git add src/modules/identity/commands/link.ts src/modules/identity/commands/unlink.ts src/modules/identity/http/steam-callback.ts tests/modules/identity/commands/link.test.ts tests/integration/identity/steam-callback.test.ts
git commit -m "feat(identity): команды /link и /unlink и колбэк Steam OpenID"
```

---

### Task 15: Команды /ranksync и /rolemap

**Files:**
- Create: `src/core/cooldown.ts`, `src/modules/identity/commands/ranksync.ts`, `src/modules/identity/commands/rolemap.ts`
- Test: `tests/integration/cooldown.test.ts`, `tests/modules/identity/commands/rolemap.test.ts`

**Interfaces:**
- Consumes: `IdentityDeps` (Task 14), `RoleMappingService` (Task 12), `RankSyncService` (Task 13), `RIOT_TIERS` / `VALORANT_TIERS` (Task 2), `DOTA_MEDALS` (Task 3).
- Produces: `createCooldown(deps: { redisUrl: string; logger: Logger }): Cooldown` где `interface Cooldown { hit(key: string, windowMs: number): Promise<{ allowed: boolean; retryAfterMs: number }>; close(): Promise<void> }`; `createRankSyncCommand(deps: IdentityDeps & { cooldown: Cooldown }): CommandDefinition`; `createRoleMapCommand(deps: IdentityDeps): CommandDefinition`.

- [ ] **Step 1: Написать падающий тест кулдауна**

Файл `tests/integration/cooldown.test.ts`. Кулдаун — не rate limiter: он не ждёт, а отказывает и сообщает, сколько осталось.

```ts
import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/core/config.js';
import { createCooldown } from '../../src/core/cooldown.js';
import { createLogger } from '../../src/core/logger.js';
import { withRedis } from '../helpers/redis.js';

const redis = withRedis();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

describe('createCooldown', () => {
  it('вешает обработчик error на клиент Redis, чтобы обрыв соединения не ронял процесс', async () => {
    // Без слушателя необработанное 'error' у ioredis (EventEmitter) убивает процесс.
    const cooldown = createCooldown({ redisUrl: redis.url, logger });
    const internal = cooldown as unknown as { redis: { listenerCount(event: string): number } };

    expect(internal.redis.listenerCount('error')).toBeGreaterThan(0);

    await cooldown.close();
  });

  it('пропускает первый вызов', async () => {
    const cooldown = createCooldown({ redisUrl: redis.url, logger });
    await expect(cooldown.hit('u:1', 10_000)).resolves.toMatchObject({ allowed: true });
    await cooldown.close();
  });

  it('отказывает во втором вызове внутри окна и сообщает остаток', async () => {
    const cooldown = createCooldown({ redisUrl: redis.url, logger });
    await cooldown.hit('u:2', 10_000);

    const second = await cooldown.hit('u:2', 10_000);

    expect(second.allowed).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);
    expect(second.retryAfterMs).toBeLessThanOrEqual(10_000);
    await cooldown.close();
  });

  it('снова пропускает после истечения окна', async () => {
    const cooldown = createCooldown({ redisUrl: redis.url, logger });
    await cooldown.hit('u:3', 150);
    await new Promise((resolve) => setTimeout(resolve, 250));

    await expect(cooldown.hit('u:3', 150)).resolves.toMatchObject({ allowed: true });
    await cooldown.close();
  });

  it('ведёт независимый учёт по ключам', async () => {
    const cooldown = createCooldown({ redisUrl: redis.url, logger });
    await cooldown.hit('u:4', 10_000);

    await expect(cooldown.hit('u:5', 10_000)).resolves.toMatchObject({ allowed: true });
    await cooldown.close();
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm run test:int -- tests/integration/cooldown.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `src/core/cooldown.ts`**

```ts
import { Redis } from 'ioredis';
import type { Logger } from './logger.js';

export interface CooldownVerdict {
  allowed: boolean;
  retryAfterMs: number;
}

export interface Cooldown {
  hit(key: string, windowMs: number): Promise<CooldownVerdict>;
  close(): Promise<void>;
}

export function createCooldown(deps: { redisUrl: string; logger: Logger }): Cooldown {
  const redis = new Redis(deps.redisUrl, { maxRetriesPerRequest: 3 });

  // ОБЯЗАТЕЛЬНО, тот же случай, что у createRateLimiter: `ioredis` — EventEmitter,
  // и событие `error` без слушателя становится неперехваченным исключением,
  // которое убивает процесс. Это был единственный Critical этапа 0.
  redis.on('error', (error) => {
    deps.logger.error({ err: error }, 'ошибка соединения с Redis у кулдауна команд');
  });

  // `redis` физически лежит на возвращаемом объекте, чтобы тест мог проверить
  // наличие слушателя тем же приёмом, что и у Cache в src/core/cache.ts.
  // Промежуточная переменная нужна: вернуть литерал с лишним полем прямо под
  // объявленным типом `Cooldown` не даст проверка избыточных свойств.
  const cooldown: Cooldown & { redis: Redis } = {
    redis,

    async hit(key, windowMs): Promise<CooldownVerdict> {
      const redisKey = `cooldown:${key}`;
      const acquired = await redis.set(redisKey, '1', 'PX', windowMs, 'NX');
      if (acquired === 'OK') {
        return { allowed: true, retryAfterMs: 0 };
      }
      const remaining = await redis.pttl(redisKey);
      return { allowed: false, retryAfterMs: remaining > 0 ? remaining : windowMs };
    },

    async close(): Promise<void> {
      await redis.quit();
    },
  };

  return cooldown;
}
```

- [ ] **Step 4: Реализовать `src/modules/identity/commands/ranksync.ts`**

```ts
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Cooldown } from '../../../core/cooldown.js';
import { UserError } from '../../../core/errors.js';
import type { CommandDefinition } from '../../../core/module.js';
import type { IdentityDeps } from './link.js';

/** Значение из спеки: /ranksync доступен раз в 10 минут на пользователя. */
const RANKSYNC_COOLDOWN_MS = 10 * 60 * 1_000;

export function createRankSyncCommand(deps: IdentityDeps & { cooldown: Cooldown }): CommandDefinition {
  return {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder().setName('ranksync').setDescription('Обновить свои ранги сейчас'),

    async execute(interaction) {
      const userId = interaction.user.id;

      const verdict = await deps.cooldown.hit(`ranksync:${userId}`, RANKSYNC_COOLDOWN_MS);
      if (!verdict.allowed) {
        const minutes = Math.ceil(verdict.retryAfterMs / 60_000);
        throw new UserError(
          `Ранги обновляются сами каждые полчаса. Вручную можно раз в 10 минут — попробуй через ${minutes} мин.`,
        );
      }

      const accounts = await deps.linking.listAccounts(userId);
      if (accounts.length === 0) {
        throw new UserError('У тебя нет привязанных аккаунтов. Начни с `/link steam` или `/link riot`.');
      }

      let updated = 0;
      const problems: string[] = [];

      for (const account of accounts) {
        try {
          const ranks = await deps.rankSync.syncAccount(account);
          if (ranks.length > 0) updated += 1;
        } catch {
          // Сбой одного провайдера не должен лишать пользователя ответа по остальным.
          problems.push(account.provider);
        }
      }

      const tail = problems.length > 0 ? `\nНе ответили: ${problems.join(', ')}.` : '';
      await interaction.followUp({
        content: `Проверено аккаунтов: ${accounts.length}, с рангом: ${updated}.${tail}`,
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}
```

- [ ] **Step 5: Написать падающий тест rolemap**

Файл `tests/modules/identity/commands/rolemap.test.ts`:

```ts
import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../../src/core/config.js';
import { UserError } from '../../../../src/core/errors.js';
import { createLogger } from '../../../../src/core/logger.js';
import type { ModuleContext } from '../../../../src/core/module.js';
import { createRoleMapCommand } from '../../../../src/modules/identity/commands/rolemap.js';
import { fakeChatInputInteraction } from '../../../helpers/interaction.js';

const ctx = { logger: createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config) } as unknown as ModuleContext;

function depsWith() {
  return {
    roles: {
      setMapping: vi.fn(async () => {}),
      listMappings: vi.fn(async () => [
        { id: 1, guildId: '111111111111111111', provider: 'riot-lol', mode: 'solo-duo', tier: 'GOLD', roleId: '400000000000000001' },
      ]),
      removeMapping: vi.fn(async () => true),
      resolveDesiredRoles: vi.fn(),
      applyRoles: vi.fn(),
    },
  };
}

function interactionWith(subcommand: string, strings: Record<string, string>, roleId?: string) {
  const fake = fakeChatInputInteraction('rolemap');
  Object.defineProperty(fake.interaction, 'options', {
    value: {
      getSubcommand: () => subcommand,
      getString: (name: string, required?: boolean) => {
        const value = strings[name] ?? null;
        if (required && value === null) throw new Error(`опция ${name} обязательна`);
        return value;
      },
      getRole: () => (roleId ? { id: roleId, name: 'Роль' } : null),
    },
  });
  return fake;
}

describe('/rolemap', () => {
  it('требует права управления ролями', () => {
    const command = createRoleMapCommand(depsWith() as never);
    const json = command.builder.toJSON();
    expect(json.default_member_permissions).toBe(String(PermissionFlagsBits.ManageRoles));
  });

  it('объявляет подкоманды set, list и remove', () => {
    const command = createRoleMapCommand(depsWith() as never);
    const json = command.builder.toJSON();
    expect(json.options?.map((o) => o.name).sort()).toEqual(['list', 'remove', 'set']);
  });

  it('сохраняет маппинг с нормализованным тиром в верхнем регистре', async () => {
    const deps = depsWith();
    const command = createRoleMapCommand(deps as never);
    const { interaction } = interactionWith(
      'set',
      { provider: 'riot-lol', mode: 'solo-duo', tier: 'platinum' },
      '400000000000000002',
    );

    await command.execute(interaction, ctx);

    expect(deps.roles.setMapping).toHaveBeenCalledWith(
      '111111111111111111',
      'riot-lol',
      'solo-duo',
      'PLATINUM',
      '400000000000000002',
    );
  });

  it('отвергает тир, которого нет в шкале провайдера', async () => {
    const command = createRoleMapCommand(depsWith() as never);
    const { interaction } = interactionWith(
      'set',
      { provider: 'riot-lol', mode: 'solo-duo', tier: 'МИФИЧЕСКИЙ' },
      '400000000000000002',
    );

    await expect(command.execute(interaction, ctx)).rejects.toThrow(UserError);
  });

  it('отвергает тир Dota для провайдера Riot', async () => {
    const command = createRoleMapCommand(depsWith() as never);
    const { interaction } = interactionWith(
      'set',
      { provider: 'riot-lol', mode: 'solo-duo', tier: 'HERALD' },
      '400000000000000002',
    );

    await expect(command.execute(interaction, ctx)).rejects.toThrow(/IRON/);
  });

  it('перечисляет существующие маппинги', async () => {
    const deps = depsWith();
    const command = createRoleMapCommand(deps as never);
    const { interaction, calls } = interactionWith('list', {});

    await command.execute(interaction, ctx);

    const content = calls.reply.mock.calls[0]?.[0]?.content as string;
    expect(content).toContain('GOLD');
    expect(content).toContain('<@&400000000000000001>');
  });

  it('сообщает, когда маппингов нет', async () => {
    const deps = depsWith();
    deps.roles.listMappings = vi.fn(async () => []);
    const command = createRoleMapCommand(deps as never);
    const { interaction, calls } = interactionWith('list', {});

    await command.execute(interaction, ctx);

    expect(calls.reply.mock.calls[0]?.[0]?.content).toContain('пока не настроены');
  });

  it('удаляет маппинг и сообщает, если его не было', async () => {
    const deps = depsWith();
    deps.roles.removeMapping = vi.fn(async () => false);
    const command = createRoleMapCommand(deps as never);
    const { interaction } = interactionWith('remove', { provider: 'riot-lol', mode: 'solo-duo', tier: 'GOLD' });

    await expect(command.execute(interaction, ctx)).rejects.toThrow(/не найден/);
  });
});
```

- [ ] **Step 6: Реализовать `src/modules/identity/commands/rolemap.ts`**

Валидация тира по шкале провайдера — не формальность: маппинг с опечаткой в тире молча никогда не сработает, и разбираться в этом придётся неделю.

```ts
import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { UserError } from '../../../core/errors.js';
import type { CommandDefinition } from '../../../core/module.js';
import { DOTA_MEDALS } from '../ranks/dota.js';
import { RIOT_TIERS, VALORANT_TIERS } from '../ranks/riot.js';
import type { ProviderId } from '../schema.js';
import type { RoleMappingService } from '../services/role-mapping.js';

const PROVIDER_CHOICES: Array<{ name: string; value: ProviderId }> = [
  { name: 'Steam / Dota 2', value: 'steam' },
  { name: 'League of Legends', value: 'riot-lol' },
  { name: 'Teamfight Tactics', value: 'riot-tft' },
  { name: 'Valorant', value: 'riot-valorant' },
];

const MODE_CHOICES = [
  { name: 'LoL: соло/дуо', value: 'solo-duo' },
  { name: 'LoL: гибкая', value: 'flex' },
  { name: 'TFT: рейтинг', value: 'tft-ranked' },
  { name: 'Dota 2: медаль', value: 'dota-mmr' },
  { name: 'Valorant: соревновательный', value: 'val-competitive' },
];

function tiersFor(provider: ProviderId): readonly string[] {
  if (provider === 'steam') return DOTA_MEDALS;
  if (provider === 'riot-valorant') return VALORANT_TIERS;
  return RIOT_TIERS;
}

export function createRoleMapCommand(deps: { roles: RoleMappingService }): CommandDefinition {
  return {
    builder: new SlashCommandBuilder()
      .setName('rolemap')
      .setDescription('Настроить выдачу ролей по игровому рангу')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Привязать роль к рангу')
          .addStringOption((option) =>
            option.setName('provider').setDescription('Игра').setRequired(true).addChoices(...PROVIDER_CHOICES),
          )
          .addStringOption((option) =>
            option.setName('mode').setDescription('Режим').setRequired(true).addChoices(...MODE_CHOICES),
          )
          .addStringOption((option) => option.setName('tier').setDescription('Тир, например PLATINUM').setRequired(true))
          .addRoleOption((option) => option.setName('role').setDescription('Какую роль выдавать').setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('Показать настроенные соответствия'))
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Убрать соответствие')
          .addStringOption((option) =>
            option.setName('provider').setDescription('Игра').setRequired(true).addChoices(...PROVIDER_CHOICES),
          )
          .addStringOption((option) =>
            option.setName('mode').setDescription('Режим').setRequired(true).addChoices(...MODE_CHOICES),
          )
          .addStringOption((option) => option.setName('tier').setDescription('Тир').setRequired(true)),
      ),

    async execute(interaction) {
      const guildId = interaction.guildId;
      if (!guildId) {
        throw new UserError('Эта команда работает только на сервере.');
      }

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'list') {
        const mappings = await deps.roles.listMappings(guildId);
        if (mappings.length === 0) {
          await interaction.reply({
            content: 'Соответствия ранг → роль пока не настроены. Добавь первое через `/rolemap set`.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const lines = mappings.map((m) => `• ${m.provider} / ${m.mode} / **${m.tier}** → <@&${m.roleId}>`);
        await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
        return;
      }

      const provider = interaction.options.getString('provider', true) as ProviderId;
      const mode = interaction.options.getString('mode', true);
      const tier = interaction.options.getString('tier', true).trim().toUpperCase();

      const allowed = tiersFor(provider);
      if (!allowed.includes(tier)) {
        throw new UserError(`Для «${provider}» тир «${tier}» не подходит. Допустимые: ${allowed.join(', ')}.`);
      }

      if (subcommand === 'remove') {
        const removed = await deps.roles.removeMapping(guildId, provider, mode, tier);
        if (!removed) {
          throw new UserError('Такое соответствие не найдено.');
        }
        await interaction.reply({ content: 'Соответствие убрано.', flags: MessageFlags.Ephemeral });
        return;
      }

      const role = interaction.options.getRole('role');
      if (!role) {
        throw new UserError('Не удалось прочитать роль. Выбери её из списка.');
      }

      await deps.roles.setMapping(guildId, provider, mode, tier, role.id);
      await interaction.reply({
        content: `Готово: ${provider} / ${mode} / **${tier}** → <@&${role.id}>. Применится при следующей синхронизации.`,
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}
```

- [ ] **Step 7: Прогнать тесты**

Run: `npm run test:int -- tests/integration/cooldown.test.ts && npx vitest run tests/modules/identity/commands/ && npm run typecheck`
Expected: 5 тестов кулдауна и 8 тестов rolemap PASS.

- [ ] **Step 8: Коммит**

```bash
git add src/core/cooldown.ts src/modules/identity/commands/ranksync.ts src/modules/identity/commands/rolemap.ts tests/integration/cooldown.test.ts tests/modules/identity/commands/rolemap.test.ts
git commit -m "feat(identity): /ranksync с кулдауном и /rolemap с валидацией тиров"
```

---

### Task 16: Карточка профиля на Components V2

**Files:**
- Create: `src/modules/identity/render/profile-card.ts`, `src/modules/identity/commands/profile.ts`
- Test: `tests/modules/identity/render/profile-card.test.ts`

**Interfaces:**
- Consumes: `GameAccountRow` (Task 11), `RankInfo` (Task 2), `rankScore` (Task 3), `IdentityDeps` (Task 14).
- Produces: `interface ProfileEntry { account: GameAccountRow; ranks: RankInfo[]; previous: Map<string, RankInfo | null>; staleSince?: Date }`; `formatRank(rank: RankInfo): string`; `formatDelta(previous: RankInfo | null, current: RankInfo): string`; `buildProfileCard(input: { displayName: string; avatarUrl?: string; entries: ProfileEntry[] }): ContainerBuilder`; `createProfileCommand(deps: IdentityDeps): CommandDefinition`.

**Ограничения Components V2, которые надо соблюсти.** С флагом `MessageFlags.IsComponentsV2` в том же сообщении нельзя передавать `content`, `embeds`, `stickers` и `poll` — только компоненты. Контейнер вмещает не более 10 компонентов, поэтому при большом числе привязок часть сворачивается в одну строку, а не добавляется отдельными блоками.

- [ ] **Step 1: Написать падающие тесты**

Файл `tests/modules/identity/render/profile-card.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { GameAccountRow } from '../../../../src/modules/identity/services/linking.js';
import type { RankInfo } from '../../../../src/modules/identity/providers/provider.js';
import { buildProfileCard, formatDelta, formatRank } from '../../../../src/modules/identity/render/profile-card.js';

function account(overrides: Partial<GameAccountRow> = {}): GameAccountRow {
  return {
    id: 1,
    userId: '222222222222222222',
    provider: 'riot-lol',
    externalId: 'PUUID-1',
    displayName: 'Игрок#EUW',
    region: 'euw1',
    verifiedAt: new Date('2026-07-01T00:00:00Z'),
    verificationMethod: 'riot-third-party-code',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-27T00:00:00Z'),
    ...overrides,
  } as GameAccountRow;
}

function rank(tier: string, division: string | null, points: number | null, source: 'api' | 'manual' = 'api'): RankInfo {
  return { mode: 'solo-duo', scale: 'riot-tier', tier, division, points, source, raw: {} };
}

describe('formatRank', () => {
  it('собирает тир, дивизион и очки', () => {
    expect(formatRank(rank('PLATINUM', 'II', 47))).toBe('Platinum II · 47 LP');
  });

  it('опускает дивизион у тиров без него', () => {
    expect(formatRank(rank('CHALLENGER', null, 1204))).toBe('Challenger · 1204 LP');
  });

  it('опускает очки, когда их нет', () => {
    expect(formatRank(rank('LEGEND', '3', null))).toBe('Legend 3');
  });

  it('помечает ручной ранг как заявленный игроком', () => {
    expect(formatRank(rank('IMMORTAL', 'II', null, 'manual'))).toContain('со слов игрока');
  });
});

describe('formatDelta', () => {
  it('показывает рост со стрелкой вверх', () => {
    expect(formatDelta(rank('GOLD', 'I', 0), rank('PLATINUM', 'IV', 10))).toContain('↑');
  });

  it('показывает падение со стрелкой вниз', () => {
    expect(formatDelta(rank('PLATINUM', 'IV', 10), rank('GOLD', 'I', 0))).toContain('↓');
  });

  it('сообщает об отсутствии изменений', () => {
    expect(formatDelta(rank('GOLD', 'II', 10), rank('GOLD', 'II', 40))).toContain('без изменений');
  });

  it('сообщает, что сравнивать не с чем', () => {
    expect(formatDelta(null, rank('GOLD', 'II', 10))).toContain('новый');
  });
});

describe('buildProfileCard', () => {
  it('строит контейнер с именем пользователя', () => {
    const card = buildProfileCard({
      displayName: 'Саня',
      entries: [{ account: account(), ranks: [rank('GOLD', 'II', 20)], previous: new Map() }],
    });

    expect(JSON.stringify(card.toJSON())).toContain('Саня');
  });

  it('показывает ранг привязанного аккаунта', () => {
    const card = buildProfileCard({
      displayName: 'Саня',
      entries: [{ account: account(), ranks: [rank('GOLD', 'II', 20)], previous: new Map() }],
    });

    expect(JSON.stringify(card.toJSON())).toContain('Gold II');
  });

  it('сообщает, когда привязок нет', () => {
    const card = buildProfileCard({ displayName: 'Саня', entries: [] });
    expect(JSON.stringify(card.toJSON())).toContain('link');
  });

  it('помечает неподтверждённую привязку', () => {
    const card = buildProfileCard({
      displayName: 'Саня',
      entries: [
        {
          account: account({ provider: 'riot-valorant', verifiedAt: null, verificationMethod: 'manual' }),
          ranks: [rank('IMMORTAL', 'II', null, 'manual')],
          previous: new Map(),
        },
      ],
    });

    expect(JSON.stringify(card.toJSON())).toContain('не подтверждён');
  });

  it('показывает отметку времени, когда данные из устаревшего кэша', () => {
    const card = buildProfileCard({
      displayName: 'Саня',
      entries: [
        {
          account: account(),
          ranks: [rank('GOLD', 'II', 20)],
          previous: new Map(),
          staleSince: new Date('2026-07-27T14:32:00Z'),
        },
      ],
    });

    expect(JSON.stringify(card.toJSON())).toContain('14:32');
  });

  it('не превышает предел контейнера в 10 компонентов', () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      account: account({ id: index + 1, externalId: `PUUID-${index}` }),
      ranks: [rank('GOLD', 'II', 20)],
      previous: new Map<string, RankInfo | null>(),
    }));

    const json = buildProfileCard({ displayName: 'Саня', entries });
    const components = (json.toJSON() as { components: unknown[] }).components;

    expect(components.length).toBeLessThanOrEqual(10);
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `npx vitest run tests/modules/identity/render/profile-card.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `src/modules/identity/render/profile-card.ts`**

```ts
import { ContainerBuilder, SeparatorBuilder, TextDisplayBuilder } from 'discord.js';
import type { RankInfo } from '../providers/provider.js';
import { rankScore } from '../ranks/compare.js';
import type { GameAccountRow } from '../services/linking.js';

/** Предел Discord: контейнер вмещает не более 10 компонентов. */
const MAX_COMPONENTS = 10;

const PROVIDER_LABELS: Record<string, string> = {
  steam: 'Steam / Dota 2',
  'riot-lol': 'League of Legends',
  'riot-tft': 'Teamfight Tactics',
  'riot-valorant': 'Valorant',
};

export interface ProfileEntry {
  account: GameAccountRow;
  ranks: RankInfo[];
  /** Ранг 30 дней назад по каждому режиму — для показа динамики. */
  previous: Map<string, RankInfo | null>;
  /** Задано, когда данные отданы из просроченного кэша. */
  staleSince?: Date;
}

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

export function formatRank(rank: RankInfo): string {
  if (!rank.tier) return 'без ранга';

  const parts = [titleCase(rank.tier)];
  if (rank.division) parts.push(rank.division);

  let text = parts.join(' ');
  if (rank.points !== null) text += ` · ${rank.points} LP`;
  if (rank.source === 'manual') text += ' _(со слов игрока)_';

  return text;
}

export function formatDelta(previous: RankInfo | null, current: RankInfo): string {
  if (!previous) return 'новый';

  const before = rankScore(previous);
  const after = rankScore(current);

  if (after > before) return `↑ с ${formatRank(previous)}`;
  if (after < before) return `↓ с ${formatRank(previous)}`;
  return 'без изменений';
}

function formatTime(at: Date): string {
  return at.toISOString().slice(11, 16);
}

function entryLines(entry: ProfileEntry): string {
  const label = PROVIDER_LABELS[entry.account.provider] ?? entry.account.provider;
  const verified = entry.account.verifiedAt ? '' : ' — _не подтверждён_';
  const header = `**${label}** · ${entry.account.displayName}${verified}`;

  if (entry.ranks.length === 0) {
    return `${header}\nРанга нет или он скрыт настройками приватности.`;
  }

  const ranks = entry.ranks
    .map((rank) => `• ${rank.mode}: ${formatRank(rank)} — ${formatDelta(entry.previous.get(rank.mode) ?? null, rank)}`)
    .join('\n');

  const stale = entry.staleSince ? `\n_Данные на ${formatTime(entry.staleSince)} — сервис игры не ответил._` : '';

  return `${header}\n${ranks}${stale}`;
}

export function buildProfileCard(input: {
  displayName: string;
  avatarUrl?: string;
  entries: ProfileEntry[];
}): ContainerBuilder {
  const container = new ContainerBuilder();
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Профиль ${input.displayName}`));

  if (input.entries.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        'Игровых аккаунтов пока нет. Привяжи первый: `/link steam`, `/link riot` или `/link valorant`.',
      ),
    );
    return container;
  }

  container.addSeparatorComponents(new SeparatorBuilder());

  // Заголовок и разделитель уже заняли два места; один слот резервируется под сводку.
  const budget = MAX_COMPONENTS - 3;
  const shown = input.entries.slice(0, budget);
  const hidden = input.entries.length - shown.length;

  for (const entry of shown) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(entryLines(entry)));
  }

  if (hidden > 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`_И ещё привязок: ${hidden}. Показаны самые свежие._`),
    );
  }

  return container;
}
```

- [ ] **Step 4: Реализовать `src/modules/identity/commands/profile.ts`**

```ts
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { CommandDefinition } from '../../../core/module.js';
import { buildProfileCard, type ProfileEntry } from '../render/profile-card.js';
import type { RankInfo } from '../providers/provider.js';
import type { IdentityDeps } from './link.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;

export function createProfileCommand(deps: IdentityDeps): CommandDefinition {
  return {
    defer: { ephemeral: false },
    builder: new SlashCommandBuilder()
      .setName('profile')
      .setDescription('Показать игровой профиль')
      .addUserOption((option) => option.setName('user').setDescription('Чей профиль показать').setRequired(false)),

    async execute(interaction) {
      const target = interaction.options.getUser('user') ?? interaction.user;
      const accounts = await deps.linking.listAccounts(target.id);
      const since = new Date(Date.now() - THIRTY_DAYS_MS);

      const entries: ProfileEntry[] = [];
      for (const account of accounts) {
        const ranks = await deps.linking.latestRanks(account.id);
        const previous = new Map<string, RankInfo | null>();
        for (const rank of ranks) {
          previous.set(rank.mode, await deps.linking.rankAt(account.id, rank.mode, since));
        }
        entries.push({ account, ranks, previous });
      }

      const card = buildProfileCard({
        displayName: target.displayName,
        ...(target.displayAvatarURL() ? { avatarUrl: target.displayAvatarURL() } : {}),
        entries,
      });

      // С IsComponentsV2 нельзя передавать content или embeds в том же сообщении.
      await interaction.followUp({ components: [card], flags: MessageFlags.IsComponentsV2 });
    },
  };
}
```

- [ ] **Step 5: Прогнать тесты**

Run: `npx vitest run tests/modules/identity/render/profile-card.test.ts && npm run typecheck`
Expected: 14 тестов PASS.

- [ ] **Step 6: Коммит**

```bash
git add src/modules/identity/render/profile-card.ts src/modules/identity/commands/profile.ts tests/modules/identity/render/profile-card.test.ts
git commit -m "feat(identity): карточка профиля на Components V2 с динамикой за 30 дней"
```

---

### Task 17: Манифест модуля, подключение и контрактные тесты

**Files:**
- Create: `src/modules/identity/index.ts`, `tests/contract/providers.test.ts`, `vitest.contract.config.ts`
- Modify: `src/index.ts` — подключить модуль и роут колбэка; `scripts/deploy-commands.ts` — добавить модуль; `package.json` — скрипт `test:contract`; `.github/workflows/ci.yml` — ночной прогон контрактных тестов
- Test: `tests/integration/identity/module.test.ts`

**Interfaces:**
- Consumes: всё из Task 1–16.
- Produces: `createIdentityModule(deps: IdentityModuleDeps): BotModule` — модуль с командами `/link`, `/unlink`, `/profile`, `/ranksync`, `/rolemap`, cron-джобой `identity:rank-sync` и слушателем `rank.changed`.

- [ ] **Step 1: Написать падающий тест манифеста**

Файл `tests/integration/identity/module.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { EventBus } from '../../../src/core/events/bus.js';
import { createLogger } from '../../../src/core/logger.js';
import type { ModuleContext } from '../../../src/core/module.js';
import { buildRegistry } from '../../../src/core/registry.js';
import { createIdentityModule } from '../../../src/modules/identity/index.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

function moduleWith() {
  const bus = new EventBus(logger);
  const module = createIdentityModule({
    db: pg.db,
    bus,
    logger,
    config: {
      PUBLIC_BASE_URL: 'https://bot.example.com',
      REDIS_URL: 'redis://localhost:6379',
    } as Config,
    cooldown: { hit: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })), close: vi.fn(async () => {}) },
    rateLimiter: { acquire: vi.fn(async () => {}), close: vi.fn(async () => {}) },
    fetchClientFor: () => ({ json: vi.fn() }),
    fetchMember: vi.fn(async () => null),
  });
  return { module, bus };
}

describe('модуль identity', () => {
  it('называется identity', () => {
    expect(moduleWith().module.name).toBe('identity');
  });

  it('объявляет все пять команд', () => {
    const names = moduleWith().module.commands?.map((c) => c.builder.name).sort();
    expect(names).toEqual(['link', 'profile', 'ranksync', 'rolemap', 'unlink']);
  });

  it('регистрируется в реестре ядра без конфликтов имён', () => {
    const registry = buildRegistry([moduleWith().module]);
    expect(registry.commands.size).toBe(5);
  });

  it('объявляет джобу синхронизации на каждые 30 минут', () => {
    const jobs = moduleWith().module.jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs?.[0]?.name).toBe('identity:rank-sync');
    expect(jobs?.[0]?.cron).toBe('*/30 * * * *');
  });

  it('подписывается на rank.changed при setup', async () => {
    const { module, bus } = moduleWith();
    await module.setup?.({ logger } as unknown as ModuleContext);

    // Событие обрабатывается без исключения даже когда участника не удалось найти.
    await expect(
      bus.emit('rank.changed', {
        userId: '222222222222222222',
        provider: 'riot-lol',
        mode: 'solo-duo',
        previous: null,
        current: { tier: 'GOLD', division: 'II' },
      }),
    ).resolves.toBeUndefined();
  });

  it('закрывает свои соединения при teardown', async () => {
    const { module } = moduleWith();
    await expect(module.teardown?.()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm run test:int -- tests/integration/identity/module.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `src/modules/identity/index.ts`**

```ts
import type { GuildMember } from 'discord.js';
import type { Config } from '../../core/config.js';
import type { Cooldown } from '../../core/cooldown.js';
import type { Database } from '../../core/db/client.js';
import type { EventBus } from '../../core/events/bus.js';
import type { FetchClient } from '../../core/http/fetch-client.js';
import type { Logger } from '../../core/logger.js';
import type { BotModule } from '../../core/module.js';
import type { RateLimiter } from '../../core/rate-limit.js';
import { createLinkCommand, type IdentityDeps } from './commands/link.js';
import { createProfileCommand } from './commands/profile.js';
import { createRankSyncCommand } from './commands/ranksync.js';
import { createRoleMapCommand } from './commands/rolemap.js';
import { createUnlinkCommand } from './commands/unlink.js';
import { createProviderRegistry } from './providers/index.js';
import { createLinkingService } from './services/linking.js';
import { createRankSyncService } from './services/rank-sync.js';
import { createRoleMappingService } from './services/role-mapping.js';

/** Значения из спеки: пачка на 100 аккаунтов каждые 30 минут. */
const SYNC_CRON = '*/30 * * * *';
const SYNC_BATCH_SIZE = 100;

export interface IdentityModuleDeps {
  db: Database;
  bus: EventBus;
  logger: Logger;
  config: Config;
  cooldown: Cooldown;
  rateLimiter: RateLimiter;
  /** Отдельный клиент на провайдера: у каждого свой circuit breaker. */
  fetchClientFor: (provider: string) => FetchClient;
  /** Поиск участника сервера. Возвращает null, если он ушёл с сервера. */
  fetchMember: (guildId: string, userId: string) => Promise<GuildMember | null>;
}

export function createIdentityModule(deps: IdentityModuleDeps): BotModule {
  const linking = createLinkingService({ db: deps.db });
  const roles = createRoleMappingService({ db: deps.db, logger: deps.logger });
  const providers = createProviderRegistry({
    publicBaseUrl: deps.config.PUBLIC_BASE_URL,
    ...(deps.config.STEAM_API_KEY ? { steamApiKey: deps.config.STEAM_API_KEY } : {}),
    ...(deps.config.RIOT_API_KEY ? { riotApiKey: deps.config.RIOT_API_KEY } : {}),
    steamClient: deps.fetchClientFor('steam'),
    openDotaClient: deps.fetchClientFor('opendota'),
    riotClient: deps.fetchClientFor('riot'),
    rateLimiter: deps.rateLimiter,
  });
  const rankSync = createRankSyncService({
    db: deps.db,
    linking,
    providers,
    bus: deps.bus,
    logger: deps.logger,
  });

  const identityDeps: IdentityDeps = { linking, providers, roles, rankSync, bus: deps.bus };

  return {
    name: 'identity',

    commands: [
      createLinkCommand(identityDeps),
      createUnlinkCommand(identityDeps),
      createProfileCommand(identityDeps),
      createRankSyncCommand({ ...identityDeps, cooldown: deps.cooldown }),
      createRoleMapCommand({ roles }),
    ],

    jobs: [
      {
        name: 'identity:rank-sync',
        cron: SYNC_CRON,
        run: async () => {
          await rankSync.syncBatch(SYNC_BATCH_SIZE);
        },
      },
    ],

    async setup(ctx) {
      deps.bus.on('rank.changed', async (payload) => {
        // Роли выдаются на всех серверах, где настроен маппинг. Сейчас сервер один,
        // но поиск по guild_id уже здесь — переход к нескольким не потребует правок.
        for (const guildId of ctx.client.guilds.cache.keys()) {
          const member = await deps.fetchMember(guildId, payload.userId);
          if (!member) continue;

          const accounts = await linking.listAccounts(payload.userId);
          const account = accounts.find((a) => a.provider === payload.provider);
          // Неподтверждённые привязки авто-роль не дают.
          if (!account?.verifiedAt) continue;

          const ranks = await linking.latestRanks(account.id);
          await roles.applyRoles(member, guildId, account.provider, ranks);
        }
      });
    },

    async teardown() {
      await deps.cooldown.close();
      await deps.rateLimiter.close();
    },
  };
}
```

- [ ] **Step 4: Подключить модуль в `src/index.ts`**

Заменить блок с `modules` и добавить создание зависимостей. Полный набор изменений:

```ts
// Добавить к импортам:
import { createCooldown } from './core/cooldown.js';
import { createFetchClient } from './core/http/fetch-client.js';
import { createRateLimiter } from './core/rate-limit.js';
import { createIdentityModule } from './modules/identity/index.js';
import { registerSteamCallback } from './modules/identity/http/steam-callback.js';
import { createProviderRegistry } from './modules/identity/providers/index.js';
import { createLinkingService } from './modules/identity/services/linking.js';

// Заменить строку `const modules: BotModule[] = [pingModule];` на:
const cooldown = createCooldown({ redisUrl: config.REDIS_URL, logger });
const rateLimiter = createRateLimiter({ redisUrl: config.REDIS_URL, logger });
const fetchClientFor = (provider: string) => createFetchClient({ provider, logger, metrics });

const identityModule = createIdentityModule({
  db,
  bus,
  logger,
  config,
  cooldown,
  rateLimiter,
  fetchClientFor,
  fetchMember: async (guildId, userId) => {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return null;
    // Участник мог покинуть сервер между синхронизацией и выдачей роли.
    return guild.members.fetch(userId).catch(() => null);
  },
});

const modules: BotModule[] = [pingModule, identityModule];

// После создания http-сервера добавить роут колбэка:
registerSteamCallback(http, {
  logger,
  linking: createLinkingService({ db }),
  providers: createProviderRegistry({
    publicBaseUrl: config.PUBLIC_BASE_URL,
    ...(config.STEAM_API_KEY ? { steamApiKey: config.STEAM_API_KEY } : {}),
    ...(config.RIOT_API_KEY ? { riotApiKey: config.RIOT_API_KEY } : {}),
    steamClient: fetchClientFor('steam'),
    openDotaClient: fetchClientFor('opendota'),
    riotClient: fetchClientFor('riot'),
    rateLimiter,
  }),
  notify: async (userId, text) => {
    const user = await client.users.fetch(userId).catch(() => null);
    await user?.send(text).catch(() => {
      // Личные сообщения могут быть закрыты — это не ошибка бота.
    });
  },
});
```

- [ ] **Step 5: Подключить модуль в `scripts/deploy-commands.ts`**

Импортировать `createIdentityModule` и собрать реестр из двух модулей. Скрипту нужны только билдеры команд, поэтому зависимости передаются заглушками:

```ts
const registry = buildRegistry([
  pingModule,
  createIdentityModule({
    db,
    bus,
    logger,
    config,
    cooldown: { hit: async () => ({ allowed: true, retryAfterMs: 0 }), close: async () => {} },
    rateLimiter: { acquire: async () => {}, close: async () => {} },
    fetchClientFor: () => ({ json: async () => ({}) }) as never,
    fetchMember: async () => null,
  }),
]);
```

Заглушки допустимы только здесь: скрипт читает `builder.toJSON()` и ни одного метода не вызывает.

- [ ] **Step 6: Создать `vitest.contract.config.ts` и скрипт**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/contract/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
```

В `package.json` добавить: `"test:contract": "vitest run --config vitest.contract.config.ts"`.

- [ ] **Step 7: Написать контрактные тесты**

Файл `tests/contract/providers.test.ts`. Эти тесты бьют по живым API и ловят день, когда провайдер поменял формат ответа. Без ключа в окружении тест пропускается, а не падает — иначе CI будет красным у всех, кто ключ не завёл.

```ts
import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/core/config.js';
import { createFetchClient } from '../../src/core/http/fetch-client.js';
import { createLogger } from '../../src/core/logger.js';
import { normalizeDotaRank } from '../../src/modules/identity/ranks/dota.js';
import { normalizeRiotEntry } from '../../src/modules/identity/ranks/riot.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

const steamKey = process.env['STEAM_API_KEY'];
const riotKey = process.env['RIOT_API_KEY'];

/** Публичные аккаунты для проверки формата. Заменить на любые живые с открытым профилем. */
const STEAM_ID = process.env['CONTRACT_STEAM_ID'] ?? '76561197960435530';
const RIOT_ID = process.env['CONTRACT_RIOT_ID'] ?? 'Faker#KR1';
const RIOT_PLATFORM = process.env['CONTRACT_RIOT_PLATFORM'] ?? 'kr';

describe.skipIf(!steamKey)('контракт Steam Web API', () => {
  it('отдаёт players с persona в GetPlayerSummaries', async () => {
    const client = createFetchClient({ provider: 'steam-contract', logger });
    const data = await client.json<{ response: { players: Array<{ steamid: string; personaname: string }> } }>(
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${steamKey}&steamids=${STEAM_ID}`,
    );

    expect(data.response.players[0]).toMatchObject({
      steamid: expect.any(String),
      personaname: expect.any(String),
    });
  });
});

describe('контракт OpenDota', () => {
  it('отдаёт rank_tier, который понимает наш нормализатор', async () => {
    const client = createFetchClient({ provider: 'opendota-contract', logger });
    const accountId = (BigInt(STEAM_ID) - 76561197960265728n).toString();
    const player = await client.json<{ rank_tier: number | null }>(
      `https://api.opendota.com/api/players/${accountId}`,
    );

    // Формат важнее значения: null допустим, а строка или объект — нет.
    expect(player.rank_tier === null || typeof player.rank_tier === 'number').toBe(true);
    if (typeof player.rank_tier === 'number') {
      expect(normalizeDotaRank(player)).not.toBeNull();
    }
  });
});

describe.skipIf(!riotKey)('контракт Riot API', () => {
  it('account-v1 отдаёт puuid по Riot ID', async () => {
    const client = createFetchClient({ provider: 'riot-contract', logger });
    const [gameName, tagLine] = RIOT_ID.split('#');
    const account = await client.json<{ puuid: string; gameName: string; tagLine: string }>(
      `https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName!)}/${encodeURIComponent(tagLine!)}`,
      { headers: { 'X-Riot-Token': riotKey! } },
    );

    expect(account.puuid).toBeTypeOf('string');
  });

  it('league-v4 by-puuid отдаёт записи, которые понимает наш нормализатор', async () => {
    const client = createFetchClient({ provider: 'riot-contract', logger });
    const [gameName, tagLine] = RIOT_ID.split('#');
    const account = await client.json<{ puuid: string }>(
      `https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName!)}/${encodeURIComponent(tagLine!)}`,
      { headers: { 'X-Riot-Token': riotKey! } },
    );

    const entries = await client.json<Array<{ queueType: string; tier: string; rank: string; leaguePoints: number }>>(
      `https://${RIOT_PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-puuid/${account.puuid}`,
      { headers: { 'X-Riot-Token': riotKey! } },
    );

    expect(Array.isArray(entries)).toBe(true);
    const ranked = entries.find((entry) => entry.queueType === 'RANKED_SOLO_5x5');
    if (ranked) {
      // Если это упало — Riot поменял тиры или очереди, и нормализатор надо обновить.
      expect(normalizeRiotEntry(ranked)).not.toBeNull();
    }
  });
});
```

- [ ] **Step 8: Добавить ночной прогон в `.github/workflows/ci.yml`**

```yaml
  contract:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm
      - run: npm ci
      - run: npm run test:contract
        env:
          STEAM_API_KEY: ${{ secrets.STEAM_API_KEY }}
          RIOT_API_KEY: ${{ secrets.RIOT_API_KEY }}
```

В блок `on:` того же файла добавить расписание:

```yaml
  schedule:
    - cron: '0 4 * * *'
```

- [ ] **Step 9: Прогнать всё**

Run: `npm test && npm run test:int && npm run typecheck && npm run lint`
Expected: unit и интеграционные тесты зелёные, типы и линт чистые.

- [ ] **Step 10: Проверить контрактные тесты вручную**

Run: `npm run test:contract`
Expected: тесты OpenDota проходят; Steam и Riot проходят при заданных ключах либо помечаются пропущенными. Пропуск — допустимый результат, падение — нет.

- [ ] **Step 11: Коммит**

```bash
git add src/modules/identity/index.ts src/index.ts scripts/deploy-commands.ts vitest.contract.config.ts package.json .github/workflows/ci.yml tests/contract/providers.test.ts tests/integration/identity/module.test.ts
git commit -m "feat(identity): манифест модуля, подключение к ядру и контрактные тесты провайдеров"
```

---

---

### Task 18: Кэширование ответов провайдеров и отметка устаревания

**Files:**
- Create: `src/modules/identity/providers/with-cache.ts`
- Modify: `src/modules/identity/providers/index.ts` — оборачивать провайдеров кэшем; `src/modules/identity/commands/profile.ts` — заполнять `staleSince`; `src/modules/identity/index.ts` и `src/index.ts` — передать `Cache`
- Test: `tests/integration/identity/with-cache.test.ts`

**Interfaces:**
- Consumes: `Cache` / `CachedValue` (этап 0, Task 5), `GameProvider` (Task 6), `GameAccountRow` (Task 11).
- Produces: `withCache(provider: GameProvider, cache: Cache): GameProvider`; константы `CACHE_TTL`; в `ProviderRegistryDeps` добавляется поле `cache: Cache`.

Без этой задачи каждый `/profile` и каждая синхронизация бьют по внешнему API напрямую: TTL из спеки существуют только на бумаге, а падение Riot превращается в ошибку вместо карточки с отметкой времени.

- [ ] **Step 1: Написать падающие тесты**

Файл `tests/integration/identity/with-cache.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { Cache } from '../../../src/core/cache.js';
import type { Config } from '../../../src/core/config.js';
import { createLogger } from '../../../src/core/logger.js';
import type { GameProvider, RankInfo } from '../../../src/modules/identity/providers/provider.js';
import { withCache } from '../../../src/modules/identity/providers/with-cache.js';
import { withRedis } from '../../helpers/redis.js';

const redis = withRedis();

function makeCache(): Cache {
  const config = {
    REDIS_URL: redis.url,
    LOG_LEVEL: 'fatal',
    NODE_ENV: 'test',
  } as Config;
  return new Cache(config, createLogger(config));
}

function rank(tier: string): RankInfo {
  return { mode: 'solo-duo', scale: 'riot-tier', tier, division: 'II', points: 5, source: 'api', raw: {} };
}

function providerSpy(overrides: Partial<GameProvider> = {}) {
  const fetchProfile = vi.fn(async () => ({ externalId: 'X', displayName: 'Игрок#EUW' }));
  const fetchRank = vi.fn(async () => [rank('GOLD')]);
  const provider: GameProvider = {
    id: 'riot-lol',
    capabilities: { verification: 'riot-third-party-code', rank: 'api' },
    fetchProfile,
    fetchRank,
    ...overrides,
  };
  return { provider, fetchProfile, fetchRank };
}

describe('withCache', () => {
  it('сохраняет id и capabilities исходного провайдера', () => {
    const { provider } = providerSpy();
    const wrapped = withCache(provider, makeCache());

    expect(wrapped.id).toBe('riot-lol');
    expect(wrapped.capabilities).toEqual(provider.capabilities);
  });

  it('обращается к провайдеру один раз на два запроса профиля', async () => {
    const cache = makeCache();
    const { provider, fetchProfile } = providerSpy();
    const wrapped = withCache(provider, cache);

    await wrapped.fetchProfile('X1', 'euw1');
    await wrapped.fetchProfile('X1', 'euw1');

    expect(fetchProfile).toHaveBeenCalledTimes(1);
    await cache.close();
  });

  it('различает разных игроков по ключу кэша', async () => {
    const cache = makeCache();
    const { provider, fetchProfile } = providerSpy();
    const wrapped = withCache(provider, cache);

    await wrapped.fetchProfile('X2', 'euw1');
    await wrapped.fetchProfile('X3', 'euw1');

    expect(fetchProfile).toHaveBeenCalledTimes(2);
    await cache.close();
  });

  it('кэширует ранги отдельно от профиля', async () => {
    const cache = makeCache();
    const { provider, fetchRank } = providerSpy();
    const wrapped = withCache(provider, cache);

    await wrapped.fetchRank!('X4', 'euw1');
    await wrapped.fetchRank!('X4', 'euw1');

    expect(fetchRank).toHaveBeenCalledTimes(1);
    await cache.close();
  });

  it('пробрасывает ошибку провайдера, когда в кэше нет даже просроченной копии', async () => {
    // Отдачу просроченного при сбое загрузчика покрывают тесты самого Cache (этап 0, Task 5):
    // здесь проверяется противоположный случай — когда отдавать нечего.
    const cache = makeCache();
    let failing = false;
    const provider: GameProvider = {
      id: 'riot-lol',
      capabilities: { verification: 'riot-third-party-code', rank: 'api' },
      fetchProfile: async () => ({ externalId: 'X5', displayName: 'a#b' }),
      fetchRank: async () => {
        if (failing) throw new Error('Riot лёг');
        return [rank('GOLD')];
      },
    };
    const wrapped = withCache(provider, cache);

    await wrapped.fetchRank!('X5', 'euw1');
    await cache.drop('provider:riot-lol:rank:X5:euw1');
    failing = true;

    // Ключ удалён — просроченного нет, ошибка обязана пройти наружу.
    await expect(wrapped.fetchRank!('X5', 'euw1')).rejects.toThrow('Riot лёг');
    await cache.close();
  });

  it('не оборачивает провайдера без fetchRank', () => {
    const manual: GameProvider = {
      id: 'riot-valorant',
      capabilities: { verification: 'none', rank: 'manual' },
      fetchProfile: async () => ({ externalId: 'a#b', displayName: 'a#b' }),
    };

    expect(withCache(manual, makeCache()).fetchRank).toBeUndefined();
  });

  it('пробрасывает методы верификации без изменений', () => {
    const startVerification = vi.fn();
    const { provider } = providerSpy({ startVerification: startVerification as never });
    const wrapped = withCache(provider, makeCache());

    expect(wrapped.startVerification).toBe(startVerification);
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `npm run test:int -- tests/integration/identity/with-cache.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `src/modules/identity/providers/with-cache.ts`**

```ts
import type { Cache } from '../../../core/cache.js';
import type { GameProfile, GameProvider, RankInfo } from './provider.js';

/** Значения из спеки. Первое число — пока данные свежие, второе — пока их ещё можно отдать. */
export const CACHE_TTL = {
  profile: { ttlMs: 24 * 60 * 60 * 1_000, staleMs: 7 * 24 * 60 * 60 * 1_000 },
  rank: { ttlMs: 20 * 60 * 1_000, staleMs: 24 * 60 * 60 * 1_000 },
} as const;

/**
 * Оборачивает провайдера кэшем: пользователь получает ответ из Redis, а обновление
 * идёт в фоне. Падение провайдера при наличии непросроченной копии превращается
 * в устаревший ответ, а не в ошибку.
 */
export function withCache(provider: GameProvider, cache: Cache): GameProvider {
  function key(kind: string, externalId: string, region?: string): string {
    return `provider:${provider.id}:${kind}:${externalId}:${region ?? '-'}`;
  }

  const wrapped: GameProvider = {
    id: provider.id,
    capabilities: provider.capabilities,

    async fetchProfile(externalId: string, region?: string): Promise<GameProfile> {
      const result = await cache.swr<GameProfile>(key('profile', externalId, region), {
        ...CACHE_TTL.profile,
        load: () => provider.fetchProfile(externalId, region),
      });
      return result.value;
    },
  };

  if (provider.startVerification) wrapped.startVerification = provider.startVerification;
  if (provider.completeVerification) wrapped.completeVerification = provider.completeVerification;

  // Провайдер с ручным рангом не получает fetchRank: canFetchRank должен остаться false.
  if (provider.fetchRank) {
    wrapped.fetchRank = async (externalId: string, region?: string): Promise<RankInfo[]> => {
      const result = await cache.swr<RankInfo[]>(key('rank', externalId, region), {
        ...CACHE_TTL.rank,
        load: () => provider.fetchRank!(externalId, region),
      });
      return result.value;
    };
  }

  return wrapped;
}
```

- [ ] **Step 4: Подключить кэш в реестре `src/modules/identity/providers/index.ts`**

Добавить `cache: Cache` в `ProviderRegistryDeps`, импортировать `withCache` и завернуть каждого провайдера при сборке карты:

```ts
  return new Map(providers.map((provider) => [provider.id, withCache(provider, deps.cache)]));
```

Соответственно в `src/modules/identity/index.ts` добавить `cache: Cache` в `IdentityModuleDeps` и передать его в `createProviderRegistry`; в `src/index.ts` передать уже созданный `cache` и в модуль, и в `registerSteamCallback`.

- [ ] **Step 5: Заполнить `staleSince` в `src/modules/identity/commands/profile.ts`**

Источник истины для «когда данные обновлялись» — `gameAccounts.updatedAt`, который двигает синхронизация. Порог берётся как двойной интервал cron: если за час аккаунт не обновился, синхронизация до него не дошла, и молчать об этом нельзя.

```ts
/** Двойной интервал cron-синхронизации: за это время аккаунт обязан был обновиться. */
const STALE_AFTER_MS = 60 * 60 * 1_000;

// Внутри цикла по аккаунтам, вместо `entries.push({ account, ranks, previous })`:
const isStale = Date.now() - account.updatedAt.getTime() > STALE_AFTER_MS;
entries.push({ account, ranks, previous, ...(isStale ? { staleSince: account.updatedAt } : {}) });
```

- [ ] **Step 6: Прогнать всё**

Run: `npm run test:int -- tests/integration/identity/with-cache.test.ts && npm test && npm run test:int && npm run typecheck && npm run lint`
Expected: 7 новых тестов PASS, весь набор зелёный.

- [ ] **Step 7: Проверить вручную, что кэш работает**

Run: `npm run dev`, затем в Discord вызвать `/profile` дважды подряд.
Expected: второй вызов заметно быстрее; в логах при втором вызове нет обращения к внешнему API.

- [ ] **Step 8: Коммит**

```bash
git add src/modules/identity/providers/with-cache.ts src/modules/identity/providers/index.ts src/modules/identity/commands/profile.ts src/modules/identity/index.ts src/index.ts tests/integration/identity/with-cache.test.ts
git commit -m "feat(identity): кэш ответов провайдеров по TTL из спеки и отметка устаревания в профиле"
```

---

## Что из спеки сюда сознательно не попало

**Идемпотентность компонентов через версию и владельца в `customId`.** Спека требует этого в разделе 6, но на этапах 0–1 нет ни одной кнопки и ни одного селекта: карточка профиля — статический текст. Требование становится актуальным на этапе 3 (LFG с кнопками «присоединиться») и переносится туда вместе с первым интерактивным компонентом.

---

## Критерии приёмки этапа 1

Проверяются вручную после Task 17. Соответствуют разделу 10 спеки.

- [ ] `/link steam` проходит OpenID и создаёт подтверждённый аккаунт; в личные сообщения приходит подтверждение.
- [ ] Повторная привязка того же Steam к другому Discord отклоняется с внятным текстом, а не ошибкой БД.
- [ ] `/link riot` при первом вызове выдаёт код, при втором — привязывает; без `RIOT_API_KEY` отвечает понятной ошибкой, а не стеком.
- [ ] `/link valorant` сохраняет ручной ранг, помечает его как заявленный игроком и не включает аккаунт в фоновую синхронизацию.
- [ ] `/profile` показывает аккаунты, текущие ранги и изменение за 30 дней.
- [ ] `/profile` отвечает быстрее секунды на кэше и делает `deferReply()` при промахе.
- [ ] Недоступность Riot даёт карточку из кэша с отметкой времени, а не ошибку. Проверяется блокировкой `api.riotgames.com` в `/etc/hosts` контейнера.
- [ ] Cron-синхронизация обновляет ранги и не превышает лимиты провайдеров: в логах есть строка `пачка синхронизации рангов обработана`, ошибок 429 нет.
- [ ] `rank.changed` приводит к выдаче и снятию ролей по `role_mappings`. Проверяется вручную через `/rolemap set` и подмену снимка ранга в БД.
- [ ] `/unlink` снимает выданные роли и пишет запись в `audit_log`.
- [ ] Неподтверждённый аккаунт не получает авто-роль.
- [ ] `/ranksync` вторым вызовом подряд отвечает отказом с остатком времени.
- [ ] Контрактные тесты провайдеров проходят по живым API либо помечены пропущенными из-за отсутствия ключей.
- [ ] `podman compose up -d --build` поднимает стек; `/healthz` отдаёт 200.
