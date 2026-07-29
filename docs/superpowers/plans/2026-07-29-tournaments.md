# Этап 5: турниры — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Организатор проводит на сервере турнир single elimination по Dota 2, LoL, TFT, Valorant или игре без интеграции: участники записываются сами, сетка строится жеребьёвкой, результаты репортят и подтверждают сами игроки, спорное разбирает администратор, а победитель определяется без того, чтобы организатор весь вечер вбивал результаты руками.

**Architecture:** Модуль `tournaments` внутри ядра этапа 0. Сетка сводит **участников** (`tournament_entrants`), а участник — это либо один игрок, либо команда; развилка «соло или команда» живёт только в регистрации, движок сетки о ней не знает. Продвижение победителя не хранится ссылками, а вычисляется по номеру круга и слота. Все переходы состояний — условный `UPDATE ... WHERE state = 'ожидаемое'` (compare-and-set), поэтому двойное нажатие кнопки, повторная доставка интеракции и гонка автоподтверждения с ручным дают ровно одно продвижение. Работа с Discord (ветки, объявления) вынесена за границу транзакции и за интерфейс `DiscordGateway`: отказ Discord никогда не отменяет записанный результат.

**Tech Stack:** Тот же, что на этапах 0 и 1. Новых зависимостей нет: drizzle 0.45 (транзакции, `for('update')`), discord.js 14 (приватные ветки, кнопки), croner (автоподтверждение), vitest 4.

**Spec:** [docs/superpowers/specs/2026-07-29-tournaments-and-web-design.md](../specs/2026-07-29-tournaments-and-web-design.md), разделы 1-6 и 8-10. Раздел 7 (веб-витрина) — отдельный план, этот его не касается.
**Предыдущие планы:** [2026-07-27-stage0-bot-core.md](2026-07-27-stage0-bot-core.md), [2026-07-27-stage1-identity-profile.md](2026-07-27-stage1-identity-profile.md) — должны быть выполнены полностью.

## Global Constraints

Ограничения этапов 0 и 1 остаются в силе целиком. Повторяются те, о которые спотыкаются, плюс новые, специфичные для турниров.

**Из этапов 0 и 1:**

- **ESM:** относительные импорты с расширением `.js`, даже когда файл на диске `.ts`.
- **Эфемерные ответы:** `flags: MessageFlags.Ephemeral`, никогда `ephemeral: true`.
- **Окно ответа Discord — 3 секунды.** `defer` объявляет **всё**, что ходит в БД или в Discord API, без исключений. Запрос в Postgres — это тоже ожидание: на этапе 1 `/rolemap` осталась без `defer` по ошибочному рассуждению «не делает сетевых вызовов». Все пять команд этого этапа читают или пишут БД, поэтому все пять объявляют `defer: { ephemeral: true }`.
- **Snowflake — `string`.** Времена — `timestamptz` UTC. Идентификаторы турниров, участников и матчей — `serial`/`integer` (это наши внутренние номера, не снежинки).
- **Зависимости приходят аргументом**, не глобальным импортом.
- **Ассерты на ограничения БД пишутся через `cause`, не через текст ошибки.** Drizzle 0.45 оборачивает ошибку Postgres в `DrizzleQueryError`, у которого `.message` — это `"Failed query: …"`, а SQLSTATE и имя ограничения лежат в `.cause`. Поэтому `.rejects.toThrow(/имя_ограничения/)` **не работает**, нужно `.rejects.toMatchObject({ cause: { code: '23505', message: expect.stringMatching(/имя_ограничения/) } })`. Прецедент: `tests/integration/db/core-schema.test.ts:33-41`.
- **Заглушки `vi.fn` объявляются с типовым параметром** — `vi.fn<Service['method']>(async () => …)`. У нульарной заглушки `Parameters<T>` — пустой кортеж, и при `noUncheckedIndexedAccess` обращение `mock.calls[0]?.[1]` даёт `TS2493`. Индексный доступ к `mock.calls` в тестах этого плана не используется вообще: фейк интеракции отдаёт готовый список ответов (`replies()`, `lastText()`).
- **Каждому клиенту `ioredis` обязателен слушатель `error`.** Модуль турниров **не создаёт ни одного клиента Redis** (см. ниже) — если он появится, слушатель обязателен.

**Новые, специфичные для турниров:**

- **Модуль турниров не обращается к игровым провайдерам вообще.** Ни `GameProvider`, ни `FetchClient`, ни `RateLimiter`, ни `Cache` в его зависимостях нет. Подтверждённость привязки и ранги читаются из наших же таблиц `game_accounts` и `rank_snapshots`. Следствия: в этом модуле не бывает `ProviderError`, не бывает разбора внешних ответов схемой и не бывает «инвариант проверен на голой заглушке, а в проде объект обёрнут кэшем» — оборачивать нечего. Единственное место, которое знает о таблицах этапа 1, — `src/modules/tournaments/identity-port.ts`.
- **Никаких таймеров в памяти.** Автоподтверждение — cron-джоба: процесс перезапускается, `setTimeout` на 60 минут этого не переживёт.
- **Ни одного вызова Discord API внутри транзакции БД.** Ветки, объявления и личные сообщения — только после `commit`.
- **Каждый переход состояния — условный UPDATE.** `select` → проверка в JS → `update` без условия по состоянию запрещён: между чтением и записью встаёт второе нажатие кнопки. Условие по текущему состоянию идёт в `WHERE` того же `UPDATE`, а факт перехода определяется по `.returning()`: пустой массив означает «переход не мой, кто-то успел раньше».
- **Сетка не пересобирается после старта** ни при каких условиях. Снятие участника даёт сопернику walkover (`/match walkover`), а не сдвиг сетки.
- **Ветка под матч — удобство, а не носитель состояния.** Не удалось создать — матч создан и играется; отказ логируется и показывается организатору.
- **Спор не разрешается ботом никогда.** `disputed` выходит только через `/match resolve` администратора.

Значения из спеки, зафиксированные и не подлежащие изменению при реализации:

| Параметр | Значение |
|---|---|
| Формат | `'single-elim'`; колонка `format`, не enum — double elimination добавится значением |
| Размер сетки | ближайшая сверху степень двойки от числа участников |
| `max_entrants` | от 2 до 64 |
| `team_size` | ровно 1 для `'solo'`, от 2 до 10 для `'team'` |
| Запасные | не больше 2 сверх `team_size` (роль `'sub'`) |
| `best_of` | 1, 3 или 5; по умолчанию 1; применяется ко всем матчам турнира |
| Окно автоподтверждения | 60 минут с момента репорта |
| Cron автоподтверждения | каждые 5 минут, до 50 матчей за прогон |
| Длина названия турнира | 1–80 символов |
| Длина названия команды | 1–40 символов |
| Жеребьёвка | `'random'` или `'rank'`; `'rank'` использует `rankScore` этапа 1, средний по составу |
| Пропуски (bye) | достаются старшим сеяным |
| Права организатора | `PermissionFlagsBits.ManageGuild` («Управление сервером»), проверка в коде |
| Кулдауны | не вводятся ни для одной команды: кулдаун на репорт останавливает сетку |
| Кэш | модуль не кэширует ничего; кэш страниц витрины — задача плана витрины |

**Что осталось за границей этого плана:** веб-витрина (раздел 7 спеки) целиком, включая маршруты `/t/:id`, лидерборды, флаг `profile_public` и кэш страниц. `/bracket` даёт ссылку вида `${PUBLIC_BASE_URL}/t/${id}` — страница по ней появится в плане витрины, ссылка от этого не меняется.

## Структура файлов

| Файл | Ответственность |
|---|---|
| `src/modules/tournaments/schema.ts` | пять таблиц и все строковые union-типы модуля |
| `src/modules/tournaments/games.ts` | игра турнира → провайдер, режим ранга, возможность подтверждения |
| `src/modules/tournaments/identity-port.ts` | единственное место, читающее таблицы этапа 1: привязка и сила игрока |
| `src/modules/tournaments/bracket/seeding.ts` | размер сетки, расстановка сеяных, перемешивание, присвоение сидов |
| `src/modules/tournaments/bracket/advance.ts` | вычисление следующего слота, число кругов и матчей в круге |
| `src/modules/tournaments/bracket/build.ts` | план матчей всей сетки с уже разведёнными пропусками |
| `src/modules/tournaments/bracket/render.ts` | компактный текст сетки для Discord |
| `src/modules/tournaments/services/db-errors.ts` | распознавание нарушения уникальности Postgres по имени ограничения |
| `src/modules/tournaments/services/view.ts` | чтение сетки из БД в форму, которую рисует `render.ts` |
| `src/modules/tournaments/deps.ts` | один тип зависимостей на все команды модуля |
| `src/modules/tournaments/commands/guards.ts` | проверка сервера и права организатора |
| `src/modules/tournaments/services/tournaments.ts` | создание турнира и переходы жизненного цикла |
| `src/modules/tournaments/services/registration.ts` | запись соло-участников, снятие, чек-ин |
| `src/modules/tournaments/services/teams.ts` | составы: создание, приглашение, исключение, выход, снятие |
| `src/modules/tournaments/services/start.ts` | старт: жеребьёвка, сетка, сиды — в одной транзакции |
| `src/modules/tournaments/services/matches.ts` | репорт, подтверждение, спор, решение администратора, walkover, автоподтверждение, продвижение |
| `src/modules/tournaments/services/announce.ts` | ветки под матчи, объявления кругов, архивация |
| `src/modules/tournaments/discord/gateway.ts` | адаптер discord.js под `DiscordGateway` |
| `src/modules/tournaments/commands/tournament.ts` | `/tournament create|open|close|start|cancel|join|leave` |
| `src/modules/tournaments/commands/team.ts` | `/team create|invite|kick|leave|disband` |
| `src/modules/tournaments/commands/match.ts` | `/match report|confirm|dispute|resolve|walkover` |
| `src/modules/tournaments/commands/checkin.ts` | `/checkin` |
| `src/modules/tournaments/commands/bracket.ts` | `/bracket` |
| `src/modules/tournaments/buttons.ts` | кнопки подтверждения и спора под сообщением о репорте |
| `src/modules/tournaments/index.ts` | манифест модуля, cron автоподтверждения, подписки на шину |

---

### Task 1: Схема модуля tournaments

**Files:**
- Create: `src/modules/tournaments/schema.ts`
- Modify: `src/core/db/schema/index.ts` — добавить третью строку реэкспорта
- Test: `tests/integration/db/tournaments-schema.test.ts`

**Interfaces:**
- Consumes: `guilds`, `users` из `src/core/db/schema/core.ts`; хелпер `withPostgres()` из `tests/helpers/postgres.ts`.
- Produces: таблицы `tournaments`, `tournamentEntrants`, `tournamentEntrantMembers`, `tournamentMatches`, `tournamentMatchReports`; типы `TournamentGame = 'dota2' | 'lol' | 'tft' | 'valorant' | 'other'`, `TournamentFormat = 'single-elim'`, `EntryMode = 'solo' | 'team'`, `SeedingMode = 'random' | 'rank'`, `TournamentState = 'draft' | 'registration' | 'running' | 'finished' | 'cancelled'`, `MatchState = 'pending' | 'ready' | 'reported' | 'confirmed' | 'disputed' | 'walkover'`, `EntrantRole = 'captain' | 'player' | 'sub'`, `ReportKind = 'report' | 'confirm' | 'auto-confirm' | 'dispute' | 'admin-resolve' | 'walkover' | 'bye'`. Имена ограничений, на которые опирается остальной код: `tournament_entrants_name_uq`, `tournament_entrants_captain_uq`, `tournament_members_entrant_user_uq`, `tournament_members_tournament_user_uq`, `tournament_matches_round_slot_uq`.

- [ ] **Step 1: Написать схему `src/modules/tournaments/schema.ts`**

```ts
import { boolean, index, integer, pgTable, serial, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { guilds, users } from '../../core/db/schema/core.js';

/**
 * Игра турнира — не то же, что ProviderId. ProviderId описывает источник данных
 * (steam, riot-lol, …), а турнир проводится по игре: Dota 2 обслуживается провайдером
 * steam, а турнир по игре, для которой провайдера нет вовсе ('other'), — законный
 * сценарий, просто без требования подтверждённой привязки и без жеребьёвки по рангу.
 */
export type TournamentGame = 'dota2' | 'lol' | 'tft' | 'valorant' | 'other';
/** Колонка, а не enum: double elimination и Swiss добавятся значением, без миграции типа. */
export type TournamentFormat = 'single-elim';
export type EntryMode = 'solo' | 'team';
export type SeedingMode = 'random' | 'rank';
export type TournamentState = 'draft' | 'registration' | 'running' | 'finished' | 'cancelled';
/** 'walkover' — результат без игры: пропуск в сетке или неявка соперника. */
export type MatchState = 'pending' | 'ready' | 'reported' | 'confirmed' | 'disputed' | 'walkover';
export type EntrantRole = 'captain' | 'player' | 'sub';
export type ReportKind = 'report' | 'confirm' | 'auto-confirm' | 'dispute' | 'admin-resolve' | 'walkover' | 'bye';

export const tournaments = pgTable(
  'tournaments',
  {
    id: serial('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    game: text('game').$type<TournamentGame>().notNull(),
    format: text('format').$type<TournamentFormat>().notNull().default('single-elim'),
    entryMode: text('entry_mode').$type<EntryMode>().notNull(),
    /** Сколько игроков в составе. Для 'solo' равно 1. */
    teamSize: integer('team_size').notNull().default(1),
    maxEntrants: integer('max_entrants').notNull(),
    seeding: text('seeding').$type<SeedingMode>().notNull().default('random'),
    state: text('state').$type<TournamentState>().notNull().default('draft'),
    /**
     * Параметр создания: матчей в момент создания турнира ещё нет, а число карт
     * выбирается сразу. При построении сетки копируется в каждый матч — там он и
     * становится свойством матча (tournament_matches.best_of).
     */
    bestOf: integer('best_of').notNull().default(1),
    requireVerified: boolean('require_verified').notNull().default(true),
    announceChannelId: text('announce_channel_id'),
    /** Канал, в котором создаются ветки под матчи. */
    matchParentId: text('match_parent_id'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [index('tournaments_guild_state_idx').on(table.guildId, table.state)],
);

/**
 * Единое понятие для одиночек и команд: сетка сводит участников, а участник —
 * это либо один игрок, либо команда. Развилка живёт только в регистрации.
 */
export const tournamentEntrants = pgTable(
  'tournament_entrants',
  {
    id: serial('id').primaryKey(),
    tournamentId: integer('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    /** Ник игрока или название команды. */
    displayName: text('display_name').notNull(),
    /** Для соло — он же и есть участник. */
    captainUserId: text('captain_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Заполняется при старте. */
    seed: integer('seed'),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
    /** Снятие не удаляет строку: сетка уже могла быть построена и ссылаться на неё. */
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('tournament_entrants_name_uq').on(table.tournamentId, table.displayName),
    unique('tournament_entrants_captain_uq').on(table.tournamentId, table.captainUserId),
    index('tournament_entrants_tournament_idx').on(table.tournamentId),
  ],
);

export const tournamentEntrantMembers = pgTable(
  'tournament_entrant_members',
  {
    id: serial('id').primaryKey(),
    entrantId: integer('entrant_id')
      .notNull()
      .references(() => tournamentEntrants.id, { onDelete: 'cascade' }),
    /**
     * Денормализация ради ограничения ниже: без tournament_id правило «один человек
     * не играет за две команды одного турнира» пришлось бы проверять запросом, а
     * проверка запросом — это гонка между двумя одновременными вступлениями.
     */
    tournamentId: integer('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<EntrantRole>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('tournament_members_entrant_user_uq').on(table.entrantId, table.userId),
    // Главное ограничение модели: гарантирует база, а не запрос.
    unique('tournament_members_tournament_user_uq').on(table.tournamentId, table.userId),
  ],
);

export const tournamentMatches = pgTable(
  'tournament_matches',
  {
    id: serial('id').primaryKey(),
    tournamentId: integer('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    /** 1 — первый круг. */
    round: integer('round').notNull(),
    /** Позиция в круге, от 0. */
    slot: integer('slot').notNull(),
    /**
     * NULL — участник ещё не известен (победитель предыдущего круга не определён).
     * set null, а не cascade: удаление участника не должно уносить матч целиком —
     * матч это факт сетки, а не свойство участника.
     */
    entrantAId: integer('entrant_a_id').references(() => tournamentEntrants.id, { onDelete: 'set null' }),
    entrantBId: integer('entrant_b_id').references(() => tournamentEntrants.id, { onDelete: 'set null' }),
    /**
     * До подтверждения здесь лежит ЗАЯВЛЕННЫЙ победитель: признак того, что он ещё
     * не окончательный, — state = 'reported'. Так подтверждение сводится к смене
     * состояния и не должно повторно принимать имя победителя от нажавшего кнопку.
     */
    winnerEntrantId: integer('winner_entrant_id').references(() => tournamentEntrants.id, { onDelete: 'set null' }),
    state: text('state').$type<MatchState>().notNull().default('pending'),
    bestOf: integer('best_of').notNull().default(1),
    reportedBy: text('reported_by'),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    disputedAt: timestamp('disputed_at', { withTimezone: true }),
    /** Ветка под матч. NULL — создать не удалось; матч от этого не перестаёт существовать. */
    threadId: text('thread_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('tournament_matches_round_slot_uq').on(table.tournamentId, table.round, table.slot),
    index('tournament_matches_tournament_state_idx').on(table.tournamentId, table.state),
    // Индекс под выборку джобы автоподтверждения: state = 'reported' и старый reported_at.
    index('tournament_matches_reported_idx').on(table.state, table.reportedAt),
  ],
);

/** Каждый репорт и каждое решение — отдельной строкой. Нужно для разбора споров. */
export const tournamentMatchReports = pgTable(
  'tournament_match_reports',
  {
    id: serial('id').primaryKey(),
    matchId: integer('match_id')
      .notNull()
      .references(() => tournamentMatches.id, { onDelete: 'cascade' }),
    tournamentId: integer('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ReportKind>().notNull(),
    /** NULL — решение бота: пропуск в сетке или автоподтверждение по истечении окна. */
    actorUserId: text('actor_user_id'),
    claimedWinnerId: integer('claimed_winner_id').references(() => tournamentEntrants.id, { onDelete: 'set null' }),
    /** true — решение администратора, а не участника. */
    isAdmin: boolean('is_admin').notNull().default(false),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('tournament_match_reports_match_idx').on(table.matchId, table.createdAt)],
);
```

- [ ] **Step 2: Подключить схему в точке сборки**

В `src/core/db/schema/index.ts` добавить третью строку:

```ts
export * from './core.js';
export * from '../../../modules/identity/schema.js';
export * from '../../../modules/tournaments/schema.js';
```

- [ ] **Step 3: Сгенерировать миграцию**

Run: `npm run db:generate`
Expected: появился `src/core/db/migrations/0002_*.sql` с пятью `CREATE TABLE`. Открыть и проверить глазами: все временные колонки — `timestamp with time zone`; `entrant_a_id`, `entrant_b_id`, `winner_entrant_id`, `claimed_winner_id` — `ON DELETE SET NULL`; остальные внешние ключи — `ON DELETE CASCADE`; присутствуют оба `UNIQUE` на `tournament_entrant_members`.

- [ ] **Step 4: Написать падающий интеграционный тест**

Файл `tests/integration/db/tournaments-schema.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { guilds, users } from '../../../src/core/db/schema/core.js';
import {
  tournamentEntrantMembers,
  tournamentEntrants,
  tournamentMatchReports,
  tournamentMatches,
  tournaments,
} from '../../../src/modules/tournaments/schema.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();

const GUILD = '111111111111111111';
const ALICE = '222222222222222222';
const BOB = '333333333333333333';
const CAROL = '444444444444444444';

/** Явный отказ вместо `?? 0`: подставленный ноль превратил бы падение в загадку. */
function required<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`${what} не создан`);
  return row;
}

let tournamentId = 0;
let teamOneId = 0;
let teamTwoId = 0;

beforeAll(async () => {
  await pg.db.insert(guilds).values({ id: GUILD });
  await pg.db.insert(users).values([{ id: ALICE }, { id: BOB }, { id: CAROL }]);

  const tournament = required(
    (
      await pg.db
        .insert(tournaments)
        .values({
          guildId: GUILD,
          name: 'Кубок сервера',
          game: 'lol',
          entryMode: 'team',
          teamSize: 5,
          maxEntrants: 8,
          seeding: 'rank',
          createdBy: ALICE,
        })
        .returning()
    )[0],
    'турнир',
  );
  tournamentId = tournament.id;

  teamOneId = required(
    (
      await pg.db
        .insert(tournamentEntrants)
        .values({ tournamentId, displayName: 'Красные', captainUserId: ALICE })
        .returning()
    )[0],
    'первая команда',
  ).id;

  teamTwoId = required(
    (
      await pg.db
        .insert(tournamentEntrants)
        .values({ tournamentId, displayName: 'Синие', captainUserId: BOB })
        .returning()
    )[0],
    'вторая команда',
  ).id;

  await pg.db.insert(tournamentEntrantMembers).values([
    { entrantId: teamOneId, tournamentId, userId: ALICE, role: 'captain' },
    { entrantId: teamTwoId, tournamentId, userId: BOB, role: 'captain' },
  ]);
});

describe('схема турниров', () => {
  it('подставляет черновик, single-elim, best of 1 и требование подтверждения по умолчанию', async () => {
    const [row] = await pg.db.select().from(tournaments).where(eq(tournaments.id, tournamentId));

    expect(row?.state).toBe('draft');
    expect(row?.format).toBe('single-elim');
    expect(row?.bestOf).toBe(1);
    expect(row?.requireVerified).toBe(true);
    expect(row?.startedAt).toBeNull();
  });

  it('запрещает два участника с одинаковым названием в одном турнире', async () => {
    await expect(
      pg.db.insert(tournamentEntrants).values({ tournamentId, displayName: 'Красные', captainUserId: CAROL }),
    ).rejects.toMatchObject({
      cause: { code: '23505', message: expect.stringMatching(/tournament_entrants_name_uq/) },
    });
  });

  it('запрещает одному человеку быть капитаном двух участников одного турнира', async () => {
    await expect(
      pg.db.insert(tournamentEntrants).values({ tournamentId, displayName: 'Зелёные', captainUserId: ALICE }),
    ).rejects.toMatchObject({
      cause: { code: '23505', message: expect.stringMatching(/tournament_entrants_captain_uq/) },
    });
  });

  it('запрещает одному человеку играть за две команды одного турнира', async () => {
    await expect(
      pg.db.insert(tournamentEntrantMembers).values({
        entrantId: teamTwoId,
        tournamentId,
        userId: ALICE,
        role: 'player',
      }),
    ).rejects.toMatchObject({
      cause: { code: '23505', message: expect.stringMatching(/tournament_members_tournament_user_uq/) },
    });
  });

  it('разрешает тому же человеку играть в другом турнире', async () => {
    const other = required(
      (
        await pg.db
          .insert(tournaments)
          .values({
            guildId: GUILD,
            name: 'Второй кубок',
            game: 'dota2',
            entryMode: 'solo',
            teamSize: 1,
            maxEntrants: 4,
            seeding: 'random',
            createdBy: ALICE,
          })
          .returning()
      )[0],
      'второй турнир',
    );
    const entrant = required(
      (
        await pg.db
          .insert(tournamentEntrants)
          .values({ tournamentId: other.id, displayName: 'alice', captainUserId: ALICE })
          .returning()
      )[0],
      'участник второго турнира',
    );

    await expect(
      pg.db.insert(tournamentEntrantMembers).values({
        entrantId: entrant.id,
        tournamentId: other.id,
        userId: ALICE,
        role: 'captain',
      }),
    ).resolves.toBeDefined();
  });

  it('запрещает два матча с одинаковыми кругом и слотом', async () => {
    await pg.db.insert(tournamentMatches).values({
      tournamentId,
      round: 1,
      slot: 0,
      entrantAId: teamOneId,
      entrantBId: teamTwoId,
      state: 'ready',
    });

    await expect(
      pg.db.insert(tournamentMatches).values({ tournamentId, round: 1, slot: 0 }),
    ).rejects.toMatchObject({
      cause: { code: '23505', message: expect.stringMatching(/tournament_matches_round_slot_uq/) },
    });
  });

  it('создаёт матч следующего круга без участников и без ветки', async () => {
    const [row] = await pg.db
      .insert(tournamentMatches)
      .values({ tournamentId, round: 2, slot: 0 })
      .returning();

    expect(row?.state).toBe('pending');
    expect(row?.entrantAId).toBeNull();
    expect(row?.winnerEntrantId).toBeNull();
    expect(row?.threadId).toBeNull();
    expect(row?.bestOf).toBe(1);
  });

  it('удаляет участников, составы, матчи и репорты вместе с турниром', async () => {
    const doomed = required(
      (
        await pg.db
          .insert(tournaments)
          .values({
            guildId: GUILD,
            name: 'Обречённый',
            game: 'other',
            entryMode: 'solo',
            teamSize: 1,
            maxEntrants: 2,
            seeding: 'random',
            createdBy: CAROL,
          })
          .returning()
      )[0],
      'обречённый турнир',
    );
    const entrant = required(
      (
        await pg.db
          .insert(tournamentEntrants)
          .values({ tournamentId: doomed.id, displayName: 'carol', captainUserId: CAROL })
          .returning()
      )[0],
      'участник обречённого турнира',
    );
    await pg.db
      .insert(tournamentEntrantMembers)
      .values({ entrantId: entrant.id, tournamentId: doomed.id, userId: CAROL, role: 'captain' });
    const match = required(
      (
        await pg.db
          .insert(tournamentMatches)
          .values({ tournamentId: doomed.id, round: 1, slot: 0, entrantAId: entrant.id, state: 'walkover' })
          .returning()
      )[0],
      'матч обречённого турнира',
    );
    await pg.db
      .insert(tournamentMatchReports)
      .values({ matchId: match.id, tournamentId: doomed.id, kind: 'bye', claimedWinnerId: entrant.id });

    await pg.db.delete(tournaments).where(eq(tournaments.id, doomed.id));

    expect(await pg.db.select().from(tournamentEntrants).where(eq(tournamentEntrants.tournamentId, doomed.id))).toHaveLength(0);
    expect(
      await pg.db.select().from(tournamentEntrantMembers).where(eq(tournamentEntrantMembers.tournamentId, doomed.id)),
    ).toHaveLength(0);
    expect(await pg.db.select().from(tournamentMatches).where(eq(tournamentMatches.tournamentId, doomed.id))).toHaveLength(0);
    expect(
      await pg.db.select().from(tournamentMatchReports).where(eq(tournamentMatchReports.tournamentId, doomed.id)),
    ).toHaveLength(0);
  });
});
```

- [ ] **Step 5: Прогнать тест**

Run: `npm run test:int -- tests/integration/db/tournaments-schema.test.ts`
Expected: 8 тестов PASS.

Через `npx vitest run tests/integration/...` эти тесты **не находятся**: базовый `vitest.config.ts` исключает каталог `tests/integration/**`. Интеграционные — только через `npm run test:int -- <файл>`.

- [ ] **Step 6: Коммит**

```bash
git add src/modules/tournaments/schema.ts src/core/db/schema/index.ts src/core/db/migrations tests/integration/db/tournaments-schema.test.ts
git commit -m "feat(tournaments): схема турниров, участников, составов, матчей и репортов"
```

---

### Task 2: Игры турниров и их требования

**Files:**
- Create: `src/modules/tournaments/games.ts`
- Test: `tests/modules/tournaments/games.test.ts`

**Interfaces:**
- Consumes: `TournamentGame` из `src/modules/tournaments/schema.ts` (Task 1); `ProviderId` из `src/modules/identity/schema.ts` — **импорт только типа**, `import type`, при компиляции стирается и рантайм-зависимости между модулями не создаёт.
- Produces:
  - `interface GameRequirements { provider: ProviderId | null; rankMode: string | null; verifiable: boolean; label: string }`
  - `const TOURNAMENT_GAMES: Record<TournamentGame, GameRequirements>`
  - `function requirementsFor(game: TournamentGame): GameRequirements`
  - `function isTournamentGame(value: string): value is TournamentGame`
  - `const TOURNAMENT_GAME_CHOICES: Array<{ name: string; value: TournamentGame }>` — готовый список для `addChoices` в билдере команды.

- [ ] **Step 1: Написать падающий тест**

Файл `tests/modules/tournaments/games.test.ts`. Смысл таблицы — в двух вещах, которые иначе всплывут у пользователя: у Valorant подтвердить владение аккаунтом **нечем** (у провайдера `capabilities.verification === 'none'`, привязка всегда ручная и `verified_at` всегда NULL), поэтому турнир по Valorant с требованием подтверждения не пустил бы вообще никого; а у игры `'other'` нет ни провайдера, ни режима ранга, поэтому жеребьёвка по рангу для неё бессмысленна.

```ts
import { describe, expect, it } from 'vitest';
import {
  TOURNAMENT_GAMES,
  TOURNAMENT_GAME_CHOICES,
  isTournamentGame,
  requirementsFor,
} from '../../../src/modules/tournaments/games.js';

describe('TOURNAMENT_GAMES', () => {
  it('описывает все пять игр', () => {
    expect(Object.keys(TOURNAMENT_GAMES).sort()).toEqual(['dota2', 'lol', 'other', 'tft', 'valorant']);
  });

  it('связывает игру с провайдером этапа 1', () => {
    expect(requirementsFor('dota2').provider).toBe('steam');
    expect(requirementsFor('lol').provider).toBe('riot-lol');
    expect(requirementsFor('tft').provider).toBe('riot-tft');
    expect(requirementsFor('valorant').provider).toBe('riot-valorant');
  });

  it('связывает игру с режимом ранга, по которому считается сила', () => {
    expect(requirementsFor('dota2').rankMode).toBe('dota-mmr');
    expect(requirementsFor('lol').rankMode).toBe('solo-duo');
    expect(requirementsFor('tft').rankMode).toBe('tft-ranked');
    expect(requirementsFor('valorant').rankMode).toBe('val-competitive');
  });

  it('честно объявляет, что владение аккаунтом Valorant подтвердить нечем', () => {
    expect(requirementsFor('valorant').verifiable).toBe(false);
    expect(requirementsFor('lol').verifiable).toBe(true);
    expect(requirementsFor('dota2').verifiable).toBe(true);
  });

  it('оставляет игру без интеграции без провайдера, режима и подтверждения', () => {
    expect(requirementsFor('other')).toMatchObject({ provider: null, rankMode: null, verifiable: false });
  });

  it('распознаёт известную игру и отвергает неизвестную', () => {
    expect(isTournamentGame('valorant')).toBe(true);
    expect(isTournamentGame('cs2')).toBe(false);
    expect(isTournamentGame('')).toBe(false);
  });

  it('отдаёт готовый список выбора с человеческими подписями', () => {
    expect(TOURNAMENT_GAME_CHOICES).toHaveLength(5);
    expect(TOURNAMENT_GAME_CHOICES.map((choice) => choice.value).sort()).toEqual([
      'dota2',
      'lol',
      'other',
      'tft',
      'valorant',
    ]);
    expect(TOURNAMENT_GAME_CHOICES.find((choice) => choice.value === 'lol')?.name).toBe('League of Legends');
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npx vitest run tests/modules/tournaments/games.test.ts`
Expected: FAIL — модуль `games.js` не найден.

- [ ] **Step 3: Реализовать `src/modules/tournaments/games.ts`**

```ts
import type { ProviderId } from '../identity/schema.js';
import type { TournamentGame } from './schema.js';

export interface GameRequirements {
  /** Провайдер, чья привязка подтверждает участие. null — игра без интеграции. */
  provider: ProviderId | null;
  /** Режим, чей последний снимок ранга даёт силу игрока. null — жеребьёвка по рангу невозможна. */
  rankMode: string | null;
  /**
   * Можно ли вообще подтвердить владение аккаунтом этой игры. У Valorant — нельзя:
   * провайдер объявляет verification: 'none', привязка всегда ручная, verified_at
   * всегда NULL. Турнир по Valorant с require_verified = true не пустил бы никого,
   * поэтому создание турнира обязано опускать этот флаг само, а не ждать жалоб.
   */
  verifiable: boolean;
  label: string;
}

/**
 * Значения rankMode совпадают с режимами, которые реально возвращают нормализаторы
 * этапа 1: 'dota-mmr' (ranks/dota.ts), 'solo-duo' и 'flex' (ranks/riot.ts),
 * 'tft-ranked' и 'tft-double-up' (ranks/riot.ts), 'val-competitive'
 * (providers/valorant.ts, константа VALORANT_MODE). Для жеребьёвки берётся по одному
 * основному режиму на игру: соло-очередь у LoL, обычный ранговый TFT.
 */
export const TOURNAMENT_GAMES: Record<TournamentGame, GameRequirements> = {
  dota2: { provider: 'steam', rankMode: 'dota-mmr', verifiable: true, label: 'Dota 2' },
  lol: { provider: 'riot-lol', rankMode: 'solo-duo', verifiable: true, label: 'League of Legends' },
  tft: { provider: 'riot-tft', rankMode: 'tft-ranked', verifiable: true, label: 'Teamfight Tactics' },
  valorant: { provider: 'riot-valorant', rankMode: 'val-competitive', verifiable: false, label: 'Valorant' },
  other: { provider: null, rankMode: null, verifiable: false, label: 'Другая игра' },
};

export function requirementsFor(game: TournamentGame): GameRequirements {
  return TOURNAMENT_GAMES[game];
}

export function isTournamentGame(value: string): value is TournamentGame {
  return Object.hasOwn(TOURNAMENT_GAMES, value);
}

export const TOURNAMENT_GAME_CHOICES: Array<{ name: string; value: TournamentGame }> = (
  Object.keys(TOURNAMENT_GAMES) as TournamentGame[]
).map((game) => ({ name: TOURNAMENT_GAMES[game].label, value: game }));
```

- [ ] **Step 4: Прогнать тест**

Run: `npx vitest run tests/modules/tournaments/games.test.ts && npm run typecheck`
Expected: 7 тестов PASS, тайпчек чистый.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/tournaments/games.ts tests/modules/tournaments/games.test.ts
git commit -m "feat(tournaments): таблица игр турнира с провайдером, режимом ранга и возможностью подтверждения"
```

---

### Task 3: Размер сетки, расстановка сеяных и жеребьёвка

**Files:**
- Create: `src/modules/tournaments/bracket/seeding.ts`
- Test: `tests/modules/tournaments/bracket/seeding.test.ts`

**Interfaces:**
- Consumes: `UserError` из `src/core/errors.ts`; `SeedingMode` из `src/modules/tournaments/schema.ts` (Task 1).
- Produces:
  - `function bracketSize(entrants: number): number` — ближайшая сверху степень двойки, минимум 2; `UserError` при `entrants < 2`.
  - `function seedSlotOrder(size: number): number[]` — сид на каждой позиции первого круга, длина `size`; позиции `2k` и `2k + 1` образуют матч слота `k`.
  - `function createSeededRandom(seed: number): () => number` — воспроизводимый источник случайности в `[0, 1)`.
  - `function shuffle<T>(items: readonly T[], random: () => number): T[]`.
  - `interface EntrantStrength { entrantId: number; strength: number }`
  - `interface SeededEntrant { entrantId: number; seed: number }`
  - `function orderEntrants(entrants: readonly EntrantStrength[], mode: SeedingMode, random: () => number): SeededEntrant[]` — сиды 1..N по силе (для `'rank'`) или по перемешиванию (для `'random'`).

**Арифметика, просчитанная руками (проверять реализацию по этим числам):**

`seedSlotOrder` строится удвоением: начинаем со списка `[1]` и на каждом шаге каждый сид `s` заменяем парой `s, doubled + 1 - s`, где `doubled` — новая длина списка.

| Шаг | Список |
|---|---|
| старт | `[1]` |
| `doubled = 2` | `1 → (1, 2)` ⇒ `[1, 2]` |
| `doubled = 4` | `1 → (1, 4)`, `2 → (2, 3)` ⇒ `[1, 4, 2, 3]` |
| `doubled = 8` | `1 → (1, 8)`, `4 → (4, 5)`, `2 → (2, 7)`, `3 → (3, 6)` ⇒ `[1, 8, 4, 5, 2, 7, 3, 6]` |
| `doubled = 16` | `1 → (1, 16)`, `8 → (8, 9)`, `4 → (4, 13)`, `5 → (5, 12)`, `2 → (2, 15)`, `7 → (7, 10)`, `3 → (3, 14)`, `6 → (6, 11)` ⇒ `[1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11]` |

Почему это и есть «пропуски достаются старшим сеяным», без отдельного кода про пропуски: каждая пара — это `(s, size + 1 - s)`, то есть сумма сидов в паре всегда `size + 1`, поэтому один из двух всегда `≤ size / 2`. Недостающие участники — это всегда **старшие номера** сидов (сиды нумеруются 1..N подряд, отсутствуют номера `N+1..size`). Значит отсутствовать может только больший сид пары, а меньший — присутствует всегда: `size = bracketSize(N)` даёт `N > size / 2`, а меньший сид пары не больше `size / 2 < N`. Отсюда сразу два следствия: пропуск получают ровно сиды `1..(size − N)` (самые старшие по силе), и матча с двумя пустыми слотами не бывает никогда.

Проверка «первый и второй сеяные встречаются не раньше финала». Слот матча первого круга для позиции `i` — это `floor(i / 2)`; дальше слот на каждый круг — `floor(slot / 2)`:

| Размер | Позиция сида 1 → слот | Путь по кругам | Позиция сида 2 → слот | Путь по кругам | Первый общий круг |
|---|---|---|---|---|---|
| 4 | 0 → 0 | 0, 0 | 2 → 1 | 1, 0 | круг 2 = финал |
| 8 | 0 → 0 | 0, 0, 0 | 4 → 2 | 2, 1, 0 | круг 3 = финал |
| 16 | 0 → 0 | 0, 0, 0, 0 | 8 → 4 | 4, 2, 1, 0 | круг 4 = финал |
| 32 | 0 → 0 | 0, 0, 0, 0, 0 | 16 → 8 | 8, 4, 2, 1, 0 | круг 5 = финал |

- [ ] **Step 1: Написать падающие тесты**

Файл `tests/modules/tournaments/bracket/seeding.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { UserError } from '../../../../src/core/errors.js';
import {
  bracketSize,
  createSeededRandom,
  orderEntrants,
  seedSlotOrder,
  shuffle,
} from '../../../../src/modules/tournaments/bracket/seeding.js';

/** Слоты, через которые проходит участник, начавший в слоте firstRoundSlot. */
function slotPath(firstRoundSlot: number, rounds: number): number[] {
  const path = [firstRoundSlot];
  let slot = firstRoundSlot;
  for (let round = 1; round < rounds; round += 1) {
    slot = Math.floor(slot / 2);
    path.push(slot);
  }
  return path;
}

describe('bracketSize', () => {
  it('округляет число участников вверх до ближайшей степени двойки', () => {
    expect(bracketSize(3)).toBe(4);
    expect(bracketSize(5)).toBe(8);
    expect(bracketSize(9)).toBe(16);
    expect(bracketSize(12)).toBe(16);
    expect(bracketSize(33)).toBe(64);
  });

  it('не меняет точную степень двойки', () => {
    expect(bracketSize(2)).toBe(2);
    expect(bracketSize(4)).toBe(4);
    expect(bracketSize(8)).toBe(8);
    expect(bracketSize(64)).toBe(64);
  });

  it('отказывается строить сетку меньше чем на двух участников', () => {
    expect(() => bracketSize(1)).toThrow(UserError);
    expect(() => bracketSize(0)).toThrow(UserError);
  });
});

describe('seedSlotOrder', () => {
  it('расставляет восьмерых как 1-8, 4-5, 2-7, 3-6', () => {
    expect(seedSlotOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  it('расставляет шестнадцать по стандартной сетке', () => {
    expect(seedSlotOrder(16)).toEqual([1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11]);
  });

  it('использует каждый сид ровно один раз', () => {
    for (const size of [2, 4, 8, 16, 32, 64]) {
      const order = seedSlotOrder(size);
      expect(order).toHaveLength(size);
      expect(new Set(order).size).toBe(size);
      expect(Math.min(...order)).toBe(1);
      expect(Math.max(...order)).toBe(size);
    }
  });

  it('сводит первого и второго сеяных не раньше финала', () => {
    for (const size of [4, 8, 16, 32]) {
      const order = seedSlotOrder(size);
      const rounds = Math.log2(size);
      const firstPath = slotPath(Math.floor(order.indexOf(1) / 2), rounds);
      const secondPath = slotPath(Math.floor(order.indexOf(2) / 2), rounds);

      for (let round = 0; round < rounds - 1; round += 1) {
        expect(firstPath[round]).not.toBe(secondPath[round]);
      }
      expect(firstPath[rounds - 1]).toBe(secondPath[rounds - 1]);
    }
  });

  it('отказывается работать с размером не степени двойки', () => {
    expect(() => seedSlotOrder(6)).toThrow(/степенью двойки/);
    expect(() => seedSlotOrder(1)).toThrow(/степенью двойки/);
  });
});

describe('createSeededRandom и shuffle', () => {
  it('один и тот же сид даёт один и тот же порядок', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const first = shuffle(items, createSeededRandom(42));
    const second = shuffle(items, createSeededRandom(42));

    expect(first).toEqual(second);
  });

  it('перемешивание сохраняет состав и не портит исходный список', () => {
    const items = [10, 20, 30, 40, 50];
    const mixed = shuffle(items, createSeededRandom(7));

    expect([...mixed].sort((left, right) => left - right)).toEqual([10, 20, 30, 40, 50]);
    expect(items).toEqual([10, 20, 30, 40, 50]);
  });
});

describe('orderEntrants', () => {
  it('по рангу отдаёт первый сид сильнейшему', () => {
    const seeded = orderEntrants(
      [
        { entrantId: 11, strength: 3247 },
        { entrantId: 12, strength: 7999 },
        { entrantId: 13, strength: 0 },
      ],
      'rank',
      createSeededRandom(1),
    );

    expect(seeded).toEqual([
      { entrantId: 12, seed: 1 },
      { entrantId: 11, seed: 2 },
      { entrantId: 13, seed: 3 },
    ]);
  });

  it('по рангу при равной силе упорядочивает по id — одна и та же выборка даёт одну и ту же сетку', () => {
    const entrants = [
      { entrantId: 30, strength: 0 },
      { entrantId: 10, strength: 0 },
      { entrantId: 20, strength: 0 },
    ];

    expect(orderEntrants(entrants, 'rank', createSeededRandom(1))).toEqual([
      { entrantId: 10, seed: 1 },
      { entrantId: 20, seed: 2 },
      { entrantId: 30, seed: 3 },
    ]);
    expect(orderEntrants(entrants, 'rank', createSeededRandom(999))).toEqual([
      { entrantId: 10, seed: 1 },
      { entrantId: 20, seed: 2 },
      { entrantId: 30, seed: 3 },
    ]);
  });

  it('по рангу не смотрит на источник случайности вообще', () => {
    const entrants = [
      { entrantId: 1, strength: 100 },
      { entrantId: 2, strength: 200 },
      { entrantId: 3, strength: 300 },
    ];

    expect(orderEntrants(entrants, 'rank', () => 0)).toEqual(orderEntrants(entrants, 'rank', () => 0.999));
  });

  it('случайная жеребьёвка присваивает сиды 1..N без пропусков и никого не теряет', () => {
    const entrants = [5, 4, 3, 2, 1].map((entrantId) => ({ entrantId, strength: 0 }));
    const seeded = orderEntrants(entrants, 'random', createSeededRandom(2026));

    expect(seeded.map((entrant) => entrant.seed).sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5]);
    expect(seeded.map((entrant) => entrant.entrantId).sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5]);
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `npx vitest run tests/modules/tournaments/bracket/seeding.test.ts`
Expected: FAIL — модуль `seeding.js` не найден.

- [ ] **Step 3: Реализовать `src/modules/tournaments/bracket/seeding.ts`**

```ts
import { UserError } from '../../../core/errors.js';
import type { SeedingMode } from '../schema.js';

/** Ближайшая сверху степень двойки. Недостающие места в сетке займут пропуски. */
export function bracketSize(entrants: number): number {
  if (!Number.isInteger(entrants) || entrants < 2) {
    throw new UserError('Для сетки нужно минимум два участника.');
  }
  let size = 2;
  while (size < entrants) size *= 2;
  return size;
}

/**
 * Сид на каждой позиции первого круга. Позиции 2k и 2k+1 образуют матч слота k.
 *
 * Строится удвоением: каждый сид s заменяется парой (s, doubled + 1 - s). Отсюда
 * два нужных свойства сразу:
 *  - сумма сидов в паре всегда doubled + 1, то есть сильнейший встречается со
 *    слабейшим — иначе два фаворита сходятся в первом круге и сеяние бессмысленно;
 *  - отсутствующие участники — всегда старшие номера сидов, а старший номер в паре
 *    всегда один, поэтому пропуски достаются ровно сидам 1..(size - N) и матча с
 *    двумя пустыми слотами не бывает.
 */
export function seedSlotOrder(size: number): number[] {
  if (size < 2 || (size & (size - 1)) !== 0) {
    throw new Error(`Размер сетки должен быть степенью двойки не меньше двух, получено ${size}.`);
  }

  let order = [1];
  while (order.length < size) {
    const doubled = order.length * 2;
    const next: number[] = [];
    for (const seed of order) {
      next.push(seed, doubled + 1 - seed);
    }
    order = next;
  }
  return order;
}

/**
 * mulberry32: воспроизводимый генератор в [0, 1). Нужен именно воспроизводимый —
 * спека требует, чтобы сетка при том же входе получалась той же, а Math.random
 * этого не даёт и делает тест на жеребьёвку недоказуемым.
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Fisher-Yates. Исходный список не меняется. */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    // Зажим на случай источника, вернувшего ровно 1: иначе индекс уходит за конец.
    const j = Math.min(i, Math.max(0, Math.floor(random() * (i + 1))));
    if (i === j) continue;
    const [left, right] = [result[i], result[j]] as [T, T];
    result[i] = right;
    result[j] = left;
  }
  return result;
}

export interface EntrantStrength {
  entrantId: number;
  strength: number;
}

export interface SeededEntrant {
  entrantId: number;
  seed: number;
}

/**
 * Сиды 1..N. Для 'rank' — по силе вниз, равенство разрешается по id: иначе порядок
 * зависел бы от того, как Postgres вернул строки, и «воспроизводимость при том же
 * входе» из спеки не выполнялась бы. Для 'random' сид тоже записывается — сетку
 * нужно уметь показать и повторить.
 */
export function orderEntrants(
  entrants: readonly EntrantStrength[],
  mode: SeedingMode,
  random: () => number,
): SeededEntrant[] {
  const base = [...entrants].sort((left, right) => left.entrantId - right.entrantId);
  const ordered =
    mode === 'rank'
      ? [...base].sort((left, right) => right.strength - left.strength || left.entrantId - right.entrantId)
      : shuffle(base, random);

  return ordered.map((entrant, index) => ({ entrantId: entrant.entrantId, seed: index + 1 }));
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `npx vitest run tests/modules/tournaments/bracket/seeding.test.ts && npm run typecheck`
Expected: 14 тестов PASS (3 в `bracketSize`, 5 в `seedSlotOrder`, 2 в `createSeededRandom и shuffle`, 4 в `orderEntrants`), тайпчек чистый.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/tournaments/bracket/seeding.ts tests/modules/tournaments/bracket/seeding.test.ts
git commit -m "feat(tournaments): размер сетки, стандартная расстановка сеяных и воспроизводимая жеребьёвка"
```

---

### Task 4: Продвижение по сетке и построение плана матчей

**Files:**
- Create: `src/modules/tournaments/bracket/advance.ts`, `src/modules/tournaments/bracket/build.ts`
- Test: `tests/modules/tournaments/bracket/advance.test.ts`, `tests/modules/tournaments/bracket/build.test.ts`

**Interfaces:**
- Consumes: `bracketSize`, `seedSlotOrder`, `SeededEntrant` из `src/modules/tournaments/bracket/seeding.ts` (Task 3); `MatchState` из `src/modules/tournaments/schema.ts` (Task 1); `BugError` из `src/core/errors.ts`.
- Produces:
  - `interface NextSlot { round: number; slot: number; side: 'a' | 'b' }`
  - `function nextSlot(round: number, slot: number): NextSlot`
  - `function roundsFor(size: number): number`
  - `function matchesInRound(size: number, round: number): number`
  - `interface PlannedMatch { round: number; slot: number; entrantAId: number | null; entrantBId: number | null; state: MatchState; winnerEntrantId: number | null }`
  - `function buildBracket(seeded: readonly SeededEntrant[]): { size: number; rounds: number; matches: PlannedMatch[] }`

**Арифметика, просчитанная руками.**

Формула продвижения: матч круга `r`, слот `s` ведёт в круг `r + 1`, слот `floor(s / 2)`, в сторону `a` при чётном `s` и `b` при нечётном. Проверка на обеих чётностях:

| Откуда | `floor(s / 2)` | `s % 2` | Куда |
|---|---|---|---|
| круг 1, слот 0 | 0 | 0 | круг 2, слот 0, сторона **a** |
| круг 1, слот 1 | 0 | 1 | круг 2, слот 0, сторона **b** |
| круг 1, слот 6 | 3 | 0 | круг 2, слот 3, сторона **a** |
| круг 1, слот 7 | 3 | 1 | круг 2, слот 3, сторона **b** |
| круг 3, слот 1 | 0 | 1 | круг 4, слот 0, сторона **b** |

Соседняя пара слотов `(2k, 2k + 1)` всегда сходится в один матч слота `k` следующего круга и занимает в нём разные стороны — значит ни один слот не может быть перезаписан двумя разными победителями.

Число матчей: круг `r` сетки размера `size` содержит `size / 2^r` матчей, всего кругов `log2(size)`, всего матчей `size − 1`.

| Размер | Круги | Матчей по кругам | Всего |
|---|---|---|---|
| 8 | 3 | 4 + 2 + 1 | 7 |
| 16 | 4 | 8 + 4 + 2 + 1 | 15 |

**Расчёт трёх сеток целиком** (участники пронумерованы `entrantId = 100 + seed`, чтобы номер участника читался как его сид):

*Пять участников, `size = 8`, порядок `[1, 8, 4, 5, 2, 7, 3, 6]`, пропусков 3:*

| Слот круга 1 | Сиды пары | Участники | Состояние | Победитель |
|---|---|---|---|---|
| 0 | 1, 8 | 101, — | `walkover` | 101 |
| 1 | 4, 5 | 104, 105 | `ready` | — |
| 2 | 2, 7 | 102, — | `walkover` | 102 |
| 3 | 3, 6 | 103, — | `walkover` | 103 |

Пропуски достались сидам 1, 2, 3 — трём сильнейшим. Продвижение победителей пропусков: слот 0 → круг 2, слот 0, сторона a (101); слот 2 → круг 2, слот 1, сторона a (102); слот 3 → круг 2, слот 1, сторона b (103). Итог круга 2: слот 0 = `{a: 101, b: null}` — `pending`; слот 1 = `{a: 102, b: 103}` — **`ready` сразу**, это законно: в сетке на пять участников второй и третий сеяные играют между собой раньше, чем определится вторая пара. Круг 3 (финал) пуст, `pending`. Всего матчей 4 + 2 + 1 = 7.

*Восемь участников, `size = 8`, пропусков 0:* круг 1 — четыре реальных матча `ready`: слот 0 `101 vs 108`, слот 1 `104 vs 105`, слот 2 `102 vs 107`, слот 3 `103 vs 106`. Круги 2 и 3 — `pending`, участники неизвестны. Всего 7 матчей.

*Двенадцать участников, `size = 16`, порядок `[1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11]`, пропусков 4:*

| Слот круга 1 | Сиды пары | Участники | Состояние | Победитель |
|---|---|---|---|---|
| 0 | 1, 16 | 101, — | `walkover` | 101 |
| 1 | 8, 9 | 108, 109 | `ready` | — |
| 2 | 4, 13 | 104, — | `walkover` | 104 |
| 3 | 5, 12 | 105, 112 | `ready` | — |
| 4 | 2, 15 | 102, — | `walkover` | 102 |
| 5 | 7, 10 | 107, 110 | `ready` | — |
| 6 | 3, 14 | 103, — | `walkover` | 103 |
| 7 | 6, 11 | 106, 111 | `ready` | — |

Пропуски у сидов 1, 2, 3, 4 — четырёх сильнейших, ровно `size − N = 4`. Все пропуски стоят в чётных слотах, поэтому все они уходят в сторону `a` своего матча круга 2, а сторона `b` там ждёт реального победителя: **ни один матч круга 2 не готов сразу**. Всего матчей 8 + 4 + 2 + 1 = 15, кругов 4.

**Глубина продвижения пропусков — ровно один круг**, дальше цепочка оборваться не может: чтобы матч круга 2 сам стал пропуском, оба его источника должны быть пропусками, но тогда оба его участника известны и это обычный `ready`-матч, а не пропуск. Матча с двумя пустыми слотами в круге 1 не бывает (доказано в Task 3). Поэтому в `buildBracket` разведение пропусков — один проход по первому кругу, без рекурсии.

- [ ] **Step 1: Написать падающие тесты продвижения**

Файл `tests/modules/tournaments/bracket/advance.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { matchesInRound, nextSlot, roundsFor } from '../../../../src/modules/tournaments/bracket/advance.js';

describe('nextSlot', () => {
  it('ведёт чётный слот в сторону a следующего круга', () => {
    expect(nextSlot(1, 0)).toEqual({ round: 2, slot: 0, side: 'a' });
    expect(nextSlot(1, 6)).toEqual({ round: 2, slot: 3, side: 'a' });
  });

  it('ведёт нечётный слот в сторону b следующего круга', () => {
    expect(nextSlot(1, 1)).toEqual({ round: 2, slot: 0, side: 'b' });
    expect(nextSlot(1, 7)).toEqual({ round: 2, slot: 3, side: 'b' });
    expect(nextSlot(3, 1)).toEqual({ round: 4, slot: 0, side: 'b' });
  });

  it('сводит соседнюю пару слотов в один матч на разные стороны', () => {
    for (let slot = 0; slot < 8; slot += 2) {
      const left = nextSlot(1, slot);
      const right = nextSlot(1, slot + 1);

      expect(left.slot).toBe(right.slot);
      expect(left.round).toBe(right.round);
      expect(left.side).not.toBe(right.side);
    }
  });
});

describe('roundsFor и matchesInRound', () => {
  it('считает круги и матчи по кругам', () => {
    expect(roundsFor(8)).toBe(3);
    expect(roundsFor(16)).toBe(4);
    expect(matchesInRound(8, 1)).toBe(4);
    expect(matchesInRound(8, 2)).toBe(2);
    expect(matchesInRound(8, 3)).toBe(1);
    expect(matchesInRound(16, 1)).toBe(8);
  });

  it('отказывается считать круги для размера не степени двойки', () => {
    expect(() => roundsFor(12)).toThrow(/степенью двойки/);
  });
});
```

- [ ] **Step 2: Написать падающие тесты построения сетки**

Файл `tests/modules/tournaments/bracket/build.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { UserError } from '../../../../src/core/errors.js';
import { buildBracket, type PlannedMatch } from '../../../../src/modules/tournaments/bracket/build.js';
import type { SeededEntrant } from '../../../../src/modules/tournaments/bracket/seeding.js';

/** entrantId = 100 + seed, чтобы номер участника читался как его сид. */
function seededFor(count: number): SeededEntrant[] {
  return Array.from({ length: count }, (_unused, index) => ({ entrantId: 101 + index, seed: index + 1 }));
}

function at(matches: readonly PlannedMatch[], round: number, slot: number): PlannedMatch {
  const found = matches.find((match) => match.round === round && match.slot === slot);
  if (!found) throw new Error(`матча круга ${round} слота ${slot} нет в плане`);
  return found;
}

describe('buildBracket на восьми участниках', () => {
  it('строит три круга и семь матчей', () => {
    const bracket = buildBracket(seededFor(8));

    expect(bracket.size).toBe(8);
    expect(bracket.rounds).toBe(3);
    expect(bracket.matches).toHaveLength(7);
  });

  it('сводит в первом круге 1-8, 4-5, 2-7, 3-6 и никому не даёт пропуска', () => {
    const { matches } = buildBracket(seededFor(8));

    expect(at(matches, 1, 0)).toMatchObject({ entrantAId: 101, entrantBId: 108, state: 'ready', winnerEntrantId: null });
    expect(at(matches, 1, 1)).toMatchObject({ entrantAId: 104, entrantBId: 105, state: 'ready' });
    expect(at(matches, 1, 2)).toMatchObject({ entrantAId: 102, entrantBId: 107, state: 'ready' });
    expect(at(matches, 1, 3)).toMatchObject({ entrantAId: 103, entrantBId: 106, state: 'ready' });
    expect(matches.filter((match) => match.state === 'walkover')).toHaveLength(0);
  });

  it('оставляет круги 2 и 3 пустыми и ожидающими', () => {
    const { matches } = buildBracket(seededFor(8));

    for (const match of matches.filter((candidate) => candidate.round > 1)) {
      expect(match).toMatchObject({ entrantAId: null, entrantBId: null, state: 'pending', winnerEntrantId: null });
    }
  });
});

describe('buildBracket на пяти участниках', () => {
  it('отдаёт три пропуска трём старшим сеяным', () => {
    const { matches } = buildBracket(seededFor(5));

    expect(at(matches, 1, 0)).toMatchObject({ entrantAId: 101, entrantBId: null, state: 'walkover', winnerEntrantId: 101 });
    expect(at(matches, 1, 2)).toMatchObject({ entrantAId: 102, entrantBId: null, state: 'walkover', winnerEntrantId: 102 });
    expect(at(matches, 1, 3)).toMatchObject({ entrantAId: 103, entrantBId: null, state: 'walkover', winnerEntrantId: 103 });
  });

  it('оставляет реальным матчем только 4 против 5 в слоте 1', () => {
    const { matches } = buildBracket(seededFor(5));

    expect(at(matches, 1, 1)).toMatchObject({ entrantAId: 104, entrantBId: 105, state: 'ready', winnerEntrantId: null });
    expect(matches.filter((match) => match.state === 'ready' && match.round === 1)).toHaveLength(1);
  });

  it('продвигает победителей пропусков в круг 2 и делает матч 2/1 готовым сразу', () => {
    const { matches } = buildBracket(seededFor(5));

    expect(at(matches, 2, 0)).toMatchObject({ entrantAId: 101, entrantBId: null, state: 'pending' });
    expect(at(matches, 2, 1)).toMatchObject({ entrantAId: 102, entrantBId: 103, state: 'ready' });
    expect(at(matches, 3, 0)).toMatchObject({ entrantAId: null, entrantBId: null, state: 'pending' });
  });
});

describe('buildBracket на двенадцати участниках', () => {
  it('строит четыре круга и пятнадцать матчей', () => {
    const bracket = buildBracket(seededFor(12));

    expect(bracket.size).toBe(16);
    expect(bracket.rounds).toBe(4);
    expect(bracket.matches).toHaveLength(15);
  });

  it('отдаёт четыре пропуска сидам 1-4 в чётных слотах', () => {
    const { matches } = buildBracket(seededFor(12));
    const byes = matches.filter((match) => match.state === 'walkover');

    expect(byes.map((match) => match.slot)).toEqual([0, 2, 4, 6]);
    expect(byes.map((match) => match.winnerEntrantId)).toEqual([101, 104, 102, 103]);
  });

  it('не делает готовым ни один матч второго круга: все пропуски ушли в сторону a', () => {
    const { matches } = buildBracket(seededFor(12));
    const second = matches.filter((match) => match.round === 2);

    expect(second).toHaveLength(4);
    for (const match of second) {
      expect(match.state).toBe('pending');
      expect(match.entrantAId).not.toBeNull();
      expect(match.entrantBId).toBeNull();
    }
  });
});

describe('buildBracket на краях', () => {
  it('на трёх участниках даёт пропуск только первому сеяному', () => {
    const { matches, size } = buildBracket(seededFor(3));

    expect(size).toBe(4);
    expect(matches).toHaveLength(3);
    expect(at(matches, 1, 0)).toMatchObject({ entrantAId: 101, entrantBId: null, state: 'walkover', winnerEntrantId: 101 });
    expect(at(matches, 1, 1)).toMatchObject({ entrantAId: 102, entrantBId: 103, state: 'ready' });
    expect(at(matches, 2, 0)).toMatchObject({ entrantAId: 101, entrantBId: null, state: 'pending' });
  });

  it('отказывается строить сетку на одном участнике', () => {
    expect(() => buildBracket(seededFor(1))).toThrow(UserError);
  });
});
```

- [ ] **Step 3: Запустить тесты — убедиться, что падают**

Run: `npx vitest run tests/modules/tournaments/bracket/`
Expected: FAIL — `advance.js` и `build.js` не найдены.

- [ ] **Step 4: Реализовать `src/modules/tournaments/bracket/advance.ts`**

```ts
export interface NextSlot {
  round: number;
  slot: number;
  side: 'a' | 'b';
}

/**
 * Куда продвигается победитель. Продвижение вычисляется, а не хранится: ссылка на
 * родительский матч была бы вторым источником истины о форме сетки.
 *
 * Соседняя пара слотов (2k, 2k+1) сходится в слот k следующего круга и занимает в
 * нём разные стороны, поэтому одну сторону не могут занять два разных победителя.
 */
export function nextSlot(round: number, slot: number): NextSlot {
  return { round: round + 1, slot: Math.floor(slot / 2), side: slot % 2 === 0 ? 'a' : 'b' };
}

export function roundsFor(size: number): number {
  const rounds = Math.log2(size);
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error(`Размер сетки должен быть степенью двойки не меньше двух, получено ${size}.`);
  }
  return rounds;
}

export function matchesInRound(size: number, round: number): number {
  return size / 2 ** round;
}
```

- [ ] **Step 5: Реализовать `src/modules/tournaments/bracket/build.ts`**

```ts
import { BugError } from '../../../core/errors.js';
import type { MatchState } from '../schema.js';
import { matchesInRound, nextSlot, roundsFor } from './advance.js';
import { bracketSize, seedSlotOrder, type SeededEntrant } from './seeding.js';

export interface PlannedMatch {
  round: number;
  slot: number;
  entrantAId: number | null;
  entrantBId: number | null;
  state: MatchState;
  winnerEntrantId: number | null;
}

/**
 * План всей сетки: первый круг из расстановки сеяных, остальные круги пустыми, и
 * победители пропусков уже проведены на один круг вперёд.
 *
 * Пропуск оформляется настоящим матчем в состоянии 'walkover' с известным
 * победителем, а не «сдвигом» участника сразу во второй круг: сетка остаётся
 * прямоугольной (в круге r ровно size / 2^r матчей), витрине есть что нарисовать,
 * а продвижение работает по единой формуле и не знает о пропусках ничего особенного.
 */
export function buildBracket(seeded: readonly SeededEntrant[]): {
  size: number;
  rounds: number;
  matches: PlannedMatch[];
} {
  const size = bracketSize(seeded.length);
  const rounds = roundsFor(size);
  const order = seedSlotOrder(size);
  const bySeed = new Map(seeded.map((entrant) => [entrant.seed, entrant.entrantId]));

  const matches: PlannedMatch[] = [];

  for (let slot = 0; slot < matchesInRound(size, 1); slot += 1) {
    const seedA = order[slot * 2];
    const seedB = order[slot * 2 + 1];
    if (seedA === undefined || seedB === undefined) {
      throw new BugError(`расстановка сеяных короче размера сетки: слот ${slot}, размер ${size}`);
    }

    const entrantAId = bySeed.get(seedA) ?? null;
    const entrantBId = bySeed.get(seedB) ?? null;
    if (entrantAId === null && entrantBId === null) {
      // Недостижимо по построению (см. seedSlotOrder): меньший сид пары всегда
      // присутствует. Оставлено утверждением — если инвариант когда-нибудь сломают,
      // сетка не должна тихо получиться с матчем из двух пустых слотов.
      throw new BugError(`оба участника матча круга 1 слота ${slot} отсутствуют при размере сетки ${size}`);
    }

    const isBye = entrantAId === null || entrantBId === null;
    matches.push({
      round: 1,
      slot,
      entrantAId,
      entrantBId,
      state: isBye ? 'walkover' : 'ready',
      winnerEntrantId: isBye ? (entrantAId ?? entrantBId) : null,
    });
  }

  for (let round = 2; round <= rounds; round += 1) {
    for (let slot = 0; slot < matchesInRound(size, round); slot += 1) {
      matches.push({ round, slot, entrantAId: null, entrantBId: null, state: 'pending', winnerEntrantId: null });
    }
  }

  // Разведение пропусков — ровно один проход по первому кругу. Цепочка глубже быть
  // не может: чтобы матч второго круга сам стал пропуском, оба его источника должны
  // быть пропусками, но тогда оба участника известны и это обычный готовый матч.
  for (const match of matches.filter((candidate) => candidate.round === 1 && candidate.winnerEntrantId !== null)) {
    const winnerEntrantId = match.winnerEntrantId;
    if (winnerEntrantId === null) continue;

    const target = nextSlot(match.round, match.slot);
    const next = matches.find((candidate) => candidate.round === target.round && candidate.slot === target.slot);
    if (!next) {
      throw new BugError(`нет матча круга ${target.round} слота ${target.slot} для продвижения пропуска`);
    }

    if (target.side === 'a') next.entrantAId = winnerEntrantId;
    else next.entrantBId = winnerEntrantId;

    if (next.entrantAId !== null && next.entrantBId !== null) next.state = 'ready';
  }

  return { size, rounds, matches };
}
```

- [ ] **Step 6: Прогнать тесты**

Run: `npx vitest run tests/modules/tournaments/bracket/ && npm run typecheck`
Expected: 5 тестов в `advance.test.ts` (3 + 2 по describe-блокам) и 11 в `build.test.ts` (3 + 3 + 3 + 2) — 30 PASS суммарно по каталогу (14 из Task 3 плюс 16 новых), тайпчек чистый.

- [ ] **Step 7: Коммит**

```bash
git add src/modules/tournaments/bracket/advance.ts src/modules/tournaments/bracket/build.ts tests/modules/tournaments/bracket/advance.test.ts tests/modules/tournaments/bracket/build.test.ts
git commit -m "feat(tournaments): вычисляемое продвижение по сетке и построение плана матчей с пропусками"
```

---

### Task 5: Мост к этапу 1 — привязка и сила игрока

**Files:**
- Create: `src/modules/tournaments/identity-port.ts`
- Test: `tests/integration/tournaments/identity-port.test.ts`

**Interfaces:**
- Consumes: `Database` из `src/core/db/client.ts`; `gameAccounts`, `rankSnapshots` из `src/modules/identity/schema.ts`; `rankScore` из `src/modules/identity/ranks/compare.ts`; `requirementsFor` из `src/modules/tournaments/games.ts` (Task 2); `TournamentGame` из `src/modules/tournaments/schema.ts` (Task 1).
- Produces:
  - `interface GameLink { accountId: number; displayName: string; verifiedAt: Date | null }`
  - `interface IdentityLookup { link(userId: string, game: TournamentGame): Promise<GameLink | null>; playerStrength(userId: string, game: TournamentGame): Promise<number> }`
  - `function createIdentityLookup(deps: { db: Database }): IdentityLookup`

**Зачем отдельный файл.** Это единственное место в модуле турниров, которое знает о таблицах этапа 1. Остальной код зависит от интерфейса `IdentityLookup`, поэтому связь двух модулей видна в одной точке и подменяется в тестах одной заглушкой. Порт **не решает**, годится привязка или нет: он отдаёт `verifiedAt` как есть, а требование подтверждения — свойство турнира, и решает его регистрация (Task 7). Для Valorant ранг всегда ручной (`source: 'manual'`), и жеребьёвка обязана его учитывать — поэтому сила считается по любой привязке, а не только по подтверждённой.

**Арифметика `rankScore`, просчитанная руками** (`src/modules/identity/ranks/compare.ts`: `TIER_POINTS = 1000`, `DIVISION_POINTS = 100`, `DIVISION_ORDER: IV→0, III→1, II→2, I→3, '1'→0, '2'→1, '3'→2, '4'→3, '5'→4`; индексы `RIOT_TIERS`: IRON 0, BRONZE 1, SILVER 2, GOLD 3, PLATINUM 4, EMERALD 5, DIAMOND 6, MASTER 7, GRANDMASTER 8, CHALLENGER 9; индексы `VALORANT_TIERS`: IRON 0, BRONZE 1, SILVER 2, GOLD 3, PLATINUM 4, DIAMOND 5, ASCENDANT 6, IMMORTAL 7, RADIANT 8):

| Ранг | Шкала | Расчёт | Результат |
|---|---|---|---|
| GOLD II, 47 LP | `riot-tier` | `3·1000 + 2·100 + min(47, 99)` | **3247** |
| PLATINUM IV, 0 LP | `riot-tier` | `4·1000 + 0·100 + 0` | **4000** |
| DIAMOND I, 88 LP | `riot-tier` | `6·1000 + 3·100 + 88` | **6388** |
| MASTER, 1200 LP (без дивизиона) | `riot-tier` | `7·1000 + 0 + min(1200, 999)` | **7999** |
| IMMORTAL 2 (Valorant, `points` нет) | `valorant-tier` | `7·1000 + 1·100 + 0` | **7100** |
| нет ранга (`tier` = NULL) | любая | ранний выход | **0** |

Ноль для «ранга нет» — не костыль, а рабочее свойство: он ставит игрока без ранга ниже любого имеющего ранг, и порог «выше unranked» получается сам собой.

- [ ] **Step 1: Написать падающий интеграционный тест**

Файл `tests/integration/tournaments/identity-port.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { users } from '../../../src/core/db/schema/core.js';
import { gameAccounts, rankSnapshots } from '../../../src/modules/identity/schema.js';
import { createIdentityLookup } from '../../../src/modules/tournaments/identity-port.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();

const RANKED = '500000000000000001';
const UNRANKED = '500000000000000002';
const VALORANT_PLAYER = '500000000000000003';
const NOBODY = '500000000000000004';

function required<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`${what} не создан`);
  return row;
}

beforeAll(async () => {
  await pg.db.insert(users).values([{ id: RANKED }, { id: UNRANKED }, { id: VALORANT_PLAYER }, { id: NOBODY }]);

  const lolAccount = required(
    (
      await pg.db
        .insert(gameAccounts)
        .values({
          userId: RANKED,
          provider: 'riot-lol',
          externalId: 'PUUID-RANKED',
          displayName: 'Сильный#EUW',
          region: 'euw1',
          verifiedAt: new Date('2026-07-01T00:00:00Z'),
          verificationMethod: 'riot-third-party-code',
        })
        .returning()
    )[0],
    'аккаунт LoL',
  );

  // Два снимка соло-очереди: свежий обязан победить. Плюс снимок чужого режима.
  await pg.db.insert(rankSnapshots).values([
    {
      accountId: lolAccount.id,
      mode: 'solo-duo',
      scale: 'riot-tier',
      tier: 'SILVER',
      division: 'I',
      points: 0,
      source: 'api',
      raw: {},
      capturedAt: new Date('2026-07-01T00:00:00Z'),
    },
    {
      accountId: lolAccount.id,
      mode: 'solo-duo',
      scale: 'riot-tier',
      tier: 'GOLD',
      division: 'II',
      points: 47,
      source: 'api',
      raw: {},
      capturedAt: new Date('2026-07-20T00:00:00Z'),
    },
    {
      accountId: lolAccount.id,
      mode: 'flex',
      scale: 'riot-tier',
      tier: 'CHALLENGER',
      division: null,
      points: 900,
      source: 'api',
      raw: {},
      capturedAt: new Date('2026-07-25T00:00:00Z'),
    },
  ]);

  await pg.db.insert(gameAccounts).values({
    userId: UNRANKED,
    provider: 'riot-lol',
    externalId: 'PUUID-UNRANKED',
    displayName: 'Новичок#EUW',
    region: 'euw1',
    verifiedAt: null,
    verificationMethod: 'riot-third-party-code',
  });

  const valorantAccount = required(
    (
      await pg.db
        .insert(gameAccounts)
        .values({
          userId: VALORANT_PLAYER,
          provider: 'riot-valorant',
          externalId: 'Стрелок#EUW',
          displayName: 'Стрелок#EUW',
          verifiedAt: null,
          verificationMethod: 'manual',
        })
        .returning()
    )[0],
    'аккаунт Valorant',
  );

  await pg.db.insert(rankSnapshots).values({
    accountId: valorantAccount.id,
    mode: 'val-competitive',
    scale: 'valorant-tier',
    tier: 'IMMORTAL',
    division: '2',
    points: null,
    source: 'manual',
    raw: {},
  });
});

describe('IdentityLookup.link', () => {
  it('отдаёт подтверждённую привязку по игре турнира', async () => {
    const lookup = createIdentityLookup({ db: pg.db });
    const link = await lookup.link(RANKED, 'lol');

    expect(link?.displayName).toBe('Сильный#EUW');
    expect(link?.verifiedAt).toBeInstanceOf(Date);
  });

  it('отдаёт неподтверждённую привязку с verified_at = null, а не скрывает её', async () => {
    const lookup = createIdentityLookup({ db: pg.db });
    const link = await lookup.link(UNRANKED, 'lol');

    expect(link?.displayName).toBe('Новичок#EUW');
    expect(link?.verifiedAt).toBeNull();
  });

  it('возвращает null, когда привязки по этой игре нет', async () => {
    const lookup = createIdentityLookup({ db: pg.db });

    expect(await lookup.link(NOBODY, 'lol')).toBeNull();
    expect(await lookup.link(RANKED, 'dota2')).toBeNull();
  });

  it('возвращает null для игры без интеграции', async () => {
    const lookup = createIdentityLookup({ db: pg.db });

    expect(await lookup.link(RANKED, 'other')).toBeNull();
  });
});

describe('IdentityLookup.playerStrength', () => {
  it('считает силу по свежему снимку нужного режима: GOLD II 47 LP = 3247', async () => {
    const lookup = createIdentityLookup({ db: pg.db });

    expect(await lookup.playerStrength(RANKED, 'lol')).toBe(3247);
  });

  it('не берёт снимок чужого режима: гибкая очередь на силу в LoL не влияет', async () => {
    const lookup = createIdentityLookup({ db: pg.db });
    // CHALLENGER во flex дал бы 9000+; ожидаем именно соло-очередь.
    expect(await lookup.playerStrength(RANKED, 'lol')).toBeLessThan(9_000);
  });

  it('учитывает ручной ранг по неподтверждённой привязке: IMMORTAL 2 = 7100', async () => {
    const lookup = createIdentityLookup({ db: pg.db });

    expect(await lookup.playerStrength(VALORANT_PLAYER, 'valorant')).toBe(7100);
  });

  it('отдаёт ноль, когда снимков ранга нет', async () => {
    const lookup = createIdentityLookup({ db: pg.db });

    expect(await lookup.playerStrength(UNRANKED, 'lol')).toBe(0);
  });

  it('отдаёт ноль, когда привязки нет вовсе', async () => {
    const lookup = createIdentityLookup({ db: pg.db });

    expect(await lookup.playerStrength(NOBODY, 'lol')).toBe(0);
  });

  it('отдаёт ноль для игры без интеграции', async () => {
    const lookup = createIdentityLookup({ db: pg.db });

    expect(await lookup.playerStrength(RANKED, 'other')).toBe(0);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm run test:int -- tests/integration/tournaments/identity-port.test.ts`
Expected: FAIL — модуль `identity-port.js` не найден.

- [ ] **Step 3: Реализовать `src/modules/tournaments/identity-port.ts`**

```ts
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../../core/db/client.js';
import { rankScore } from '../identity/ranks/compare.js';
import { gameAccounts, rankSnapshots } from '../identity/schema.js';
import { requirementsFor } from './games.js';
import type { TournamentGame } from './schema.js';

export interface GameLink {
  accountId: number;
  displayName: string;
  /** NULL — владение аккаунтом не подтверждено. Решает вызывающий, а не порт. */
  verifiedAt: Date | null;
}

/**
 * Единственная точка модуля турниров, знающая о таблицах этапа 1. Всё остальное
 * зависит от этого интерфейса, поэтому связь двух модулей видна в одном файле и
 * подменяется в тестах одной заглушкой.
 *
 * Провайдеров игр здесь нет и не будет: и привязка, и ранг читаются из наших же
 * таблиц. Модуль турниров не делает ни одного внешнего запроса, поэтому в нём не
 * бывает ProviderError и нечего оборачивать кэшем.
 */
export interface IdentityLookup {
  link(userId: string, game: TournamentGame): Promise<GameLink | null>;
  /** rankScore последнего снимка основного режима игры. 0 — ранга нет или игра без интеграции. */
  playerStrength(userId: string, game: TournamentGame): Promise<number>;
}

export function createIdentityLookup(deps: { db: Database }): IdentityLookup {
  const { db } = deps;

  return {
    async link(userId, game): Promise<GameLink | null> {
      const { provider } = requirementsFor(game);
      // Игра без интеграции: привязки для неё не существует в принципе.
      if (!provider) return null;

      const [row] = await db
        .select({
          accountId: gameAccounts.id,
          displayName: gameAccounts.displayName,
          verifiedAt: gameAccounts.verifiedAt,
        })
        .from(gameAccounts)
        .where(and(eq(gameAccounts.userId, userId), eq(gameAccounts.provider, provider)));

      return row ?? null;
    },

    async playerStrength(userId, game): Promise<number> {
      const { provider, rankMode } = requirementsFor(game);
      if (!provider || !rankMode) return 0;

      const [row] = await db
        .select({
          mode: rankSnapshots.mode,
          scale: rankSnapshots.scale,
          tier: rankSnapshots.tier,
          division: rankSnapshots.division,
          points: rankSnapshots.points,
          source: rankSnapshots.source,
        })
        .from(rankSnapshots)
        .innerJoin(gameAccounts, eq(rankSnapshots.accountId, gameAccounts.id))
        .where(
          and(
            eq(gameAccounts.userId, userId),
            eq(gameAccounts.provider, provider),
            eq(rankSnapshots.mode, rankMode),
          ),
        )
        .orderBy(desc(rankSnapshots.capturedAt))
        .limit(1);

      if (!row) return 0;
      // rankScore сам отдаёт 0 для снимка без тира — отдельной ветки не нужно.
      return rankScore({ ...row, raw: {} });
    },
  };
}
```

- [ ] **Step 4: Прогнать тест**

Run: `npm run test:int -- tests/integration/tournaments/identity-port.test.ts && npm run typecheck`
Expected: 10 тестов PASS, тайпчек чистый.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/tournaments/identity-port.ts tests/integration/tournaments/identity-port.test.ts
git commit -m "feat(tournaments): мост к привязкам и рангам этапа 1 одним портом"
```

---

### Task 6: События турниров и жизненный цикл

**Files:**
- Create: `src/modules/tournaments/services/db-errors.ts`, `src/modules/tournaments/services/tournaments.ts`
- Modify: `src/core/events/events.ts` — добавить пять событий турниров
- Test: `tests/integration/tournaments/db-errors.test.ts`, `tests/integration/tournaments/tournaments-service.test.ts`

**Interfaces:**
- Consumes: `Database`, `EventBus`, `UserError`, `guilds`, `users`; `tournaments` и типы из `src/modules/tournaments/schema.ts` (Task 1); `requirementsFor` из `src/modules/tournaments/games.ts` (Task 2).
- Produces:
  - `function isUniqueViolation(error: unknown, constraint: string): boolean`
  - `type TournamentRow = typeof tournaments.$inferSelect`
  - константы `MIN_ENTRANTS_LIMIT = 2`, `MAX_ENTRANTS_LIMIT = 64`, `MIN_TEAM_SIZE = 2`, `MAX_TEAM_SIZE = 10`, `NAME_MAX_LENGTH = 80`, `ALLOWED_BEST_OF = [1, 3, 5]`
  - `interface CreateTournamentInput { guildId: string; name: string; game: TournamentGame; entryMode: EntryMode; teamSize: number; maxEntrants: number; seeding: SeedingMode; bestOf: number; requireVerified: boolean; createdBy: string; announceChannelId: string | null; matchParentId: string | null }`
  - `interface CreateTournamentResult { tournament: TournamentRow; notes: string[] }`
  - `interface TournamentsService { ensureGuild(guildId: string): Promise<void>; ensureUser(userId: string): Promise<void>; create(input: CreateTournamentInput): Promise<CreateTournamentResult>; require(tournamentId: number, guildId: string): Promise<TournamentRow>; open(tournamentId: number, guildId: string): Promise<TournamentRow>; close(tournamentId: number, guildId: string): Promise<TournamentRow>; cancel(tournamentId: number, guildId: string): Promise<TournamentRow>; listActive(guildId: string): Promise<TournamentRow[]> }`
  - `function createTournamentsService(deps: { db: Database; bus: EventBus }): TournamentsService`
  - события шины: `'tournament.created'`, `'tournament.started'`, `'tournament.finished'`, `'match.ready'`, `'match.confirmed'`.

- [ ] **Step 1: Добавить события в `src/core/events/events.ts`**

Дописать в `interface BotEvents` (игра и провайдер передаются строками: ядро не может импортировать типы модулей, иначе зависимость перевернётся):

```ts
  'tournament.created': { tournamentId: number; guildId: string; game: string };
  'tournament.started': { tournamentId: number; guildId: string; entrants: number };
  /** winnerUserIds — чтобы прогрессия, когда появится, выдала награды без чтения таблиц турниров. */
  'tournament.finished': {
    tournamentId: number;
    guildId: string;
    winnerEntrantId: number;
    winnerUserIds: string[];
  };
  'match.ready': { tournamentId: number; matchId: number; round: number };
  'match.confirmed': { tournamentId: number; matchId: number; winnerEntrantId: number };
```

- [ ] **Step 2: Написать падающий тест распознавания нарушений уникальности**

Файл `tests/integration/tournaments/db-errors.test.ts`. Проверяется на настоящей ошибке Postgres, а не на выдуманном объекте: смысл хелпера ровно в том, чтобы разобрать то, что реально приходит от drizzle 0.45.

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { guilds, users } from '../../../src/core/db/schema/core.js';
import { isUniqueViolation } from '../../../src/modules/tournaments/services/db-errors.js';
import { tournamentEntrants, tournaments } from '../../../src/modules/tournaments/schema.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();

const GUILD = '610000000000000001';
const PLAYER = '620000000000000001';

function required<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`${what} не создан`);
  return row;
}

let tournamentId = 0;

beforeAll(async () => {
  await pg.db.insert(guilds).values({ id: GUILD });
  await pg.db.insert(users).values({ id: PLAYER });

  tournamentId = required(
    (
      await pg.db
        .insert(tournaments)
        .values({
          guildId: GUILD,
          name: 'Тест ограничений',
          game: 'other',
          entryMode: 'solo',
          teamSize: 1,
          maxEntrants: 4,
          seeding: 'random',
          createdBy: PLAYER,
        })
        .returning()
    )[0],
    'турнир',
  ).id;

  await pg.db.insert(tournamentEntrants).values({ tournamentId, displayName: 'занято', captainUserId: PLAYER });
});

async function capture(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('ожидалась ошибка, но её не было');
}

describe('isUniqueViolation', () => {
  it('распознаёт нарушение по имени ограничения', async () => {
    const error = await capture(() =>
      pg.db.insert(tournamentEntrants).values({ tournamentId, displayName: 'занято', captainUserId: PLAYER }),
    );

    expect(isUniqueViolation(error, 'tournament_entrants_name_uq')).toBe(true);
  });

  it('не путает одно ограничение с другим', async () => {
    const error = await capture(() =>
      pg.db.insert(tournamentEntrants).values({ tournamentId, displayName: 'занято', captainUserId: PLAYER }),
    );

    expect(isUniqueViolation(error, 'tournament_matches_round_slot_uq')).toBe(false);
  });

  it('не принимает нарушение внешнего ключа за нарушение уникальности', async () => {
    const error = await capture(() =>
      pg.db.insert(tournamentEntrants).values({ tournamentId: 987_654, displayName: 'сирота', captainUserId: PLAYER }),
    );

    expect(isUniqueViolation(error, 'tournament_entrants_name_uq')).toBe(false);
  });

  it('не падает на том, что ошибкой не является', () => {
    expect(isUniqueViolation(null, 'x')).toBe(false);
    expect(isUniqueViolation(new Error('обычная'), 'x')).toBe(false);
    expect(isUniqueViolation('строка', 'x')).toBe(false);
  });
});
```

- [ ] **Step 3: Написать падающий тест жизненного цикла**

Файл `tests/integration/tournaments/tournaments-service.test.ts`:

```ts
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { UserError } from '../../../src/core/errors.js';
import { EventBus } from '../../../src/core/events/bus.js';
import { createLogger } from '../../../src/core/logger.js';
import {
  createTournamentsService,
  type CreateTournamentInput,
} from '../../../src/modules/tournaments/services/tournaments.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

const GUILD = '710000000000000001';
const OTHER_GUILD = '710000000000000002';
const ORGANIZER = '720000000000000001';

function serviceWith() {
  const bus = new EventBus(logger);
  return { bus, service: createTournamentsService({ db: pg.db, bus }) };
}

function input(overrides: Partial<CreateTournamentInput> = {}): CreateTournamentInput {
  return {
    guildId: GUILD,
    name: 'Кубок сервера',
    game: 'lol',
    entryMode: 'team',
    teamSize: 5,
    maxEntrants: 8,
    seeding: 'rank',
    bestOf: 1,
    requireVerified: true,
    createdBy: ORGANIZER,
    announceChannelId: null,
    matchParentId: null,
    ...overrides,
  };
}

let counter = 0;
/** Уникальное имя на каждый вызов: имя турнира в пределах сервера не ограничено, но так читаемее. */
function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix} ${counter}`;
}

beforeAll(async () => {
  const { service } = serviceWith();
  await service.ensureGuild(OTHER_GUILD);
});

describe('создание турнира', () => {
  it('создаёт черновик и публикует tournament.created', async () => {
    const { service, bus } = serviceWith();
    const seen: Array<{ tournamentId: number; game: string }> = [];
    bus.on('tournament.created', (payload) => {
      seen.push({ tournamentId: payload.tournamentId, game: payload.game });
    });

    const { tournament } = await service.create(input({ name: uniqueName('Кубок') }));

    expect(tournament.state).toBe('draft');
    expect(tournament.format).toBe('single-elim');
    expect(seen).toEqual([{ tournamentId: tournament.id, game: 'lol' }]);
  });

  it('приводит размер состава к единице в соло-режиме и говорит об этом', async () => {
    const { service } = serviceWith();
    const result = await service.create(
      input({ name: uniqueName('Соло'), entryMode: 'solo', teamSize: 5, game: 'dota2' }),
    );

    expect(result.tournament.teamSize).toBe(1);
    expect(result.notes.join(' ')).toContain('размер состава');
  });

  it('снимает требование подтверждения для Valorant и объясняет причину', async () => {
    const { service } = serviceWith();
    const result = await service.create(
      input({ name: uniqueName('Валорант'), game: 'valorant', seeding: 'random', requireVerified: true }),
    );

    expect(result.tournament.requireVerified).toBe(false);
    // Подстрока сверена с текстом, который кладёт в notes createTournamentsService:
    // «Владение аккаунтом Valorant подтвердить нечем, поэтому требование …».
    expect(result.notes.join(' ')).toContain('Valorant подтвердить нечем');
  });

  it('отвергает состав меньше двух в командном режиме', async () => {
    const { service } = serviceWith();

    await expect(service.create(input({ name: uniqueName('Плохой'), teamSize: 1 }))).rejects.toThrow(UserError);
  });

  it('отвергает больше 64 участников и меньше двух', async () => {
    const { service } = serviceWith();

    await expect(service.create(input({ name: uniqueName('Большой'), maxEntrants: 65 }))).rejects.toThrow(/от 2 до 64/);
    await expect(service.create(input({ name: uniqueName('Мелкий'), maxEntrants: 1 }))).rejects.toThrow(/от 2 до 64/);
  });

  it('отвергает число карт, которого не бывает', async () => {
    const { service } = serviceWith();

    await expect(service.create(input({ name: uniqueName('BO2'), bestOf: 2 }))).rejects.toThrow(/1, 3 или 5/);
  });

  it('отвергает пустое и слишком длинное название', async () => {
    const { service } = serviceWith();

    await expect(service.create(input({ name: '   ' }))).rejects.toThrow(/название/i);
    await expect(service.create(input({ name: 'я'.repeat(81) }))).rejects.toThrow(/название/i);
  });

  it('отвергает жеребьёвку по рангу для игры без рангов', async () => {
    const { service } = serviceWith();

    await expect(
      service.create(input({ name: uniqueName('Другая'), game: 'other', seeding: 'rank' })),
    ).rejects.toThrow(/жеребьёвк/i);
  });
});

describe('переходы состояний', () => {
  it('открывает запись только из черновика', async () => {
    const { service } = serviceWith();
    const { tournament } = await service.create(input({ name: uniqueName('Открытие') }));

    const opened = await service.open(tournament.id, GUILD);

    expect(opened.state).toBe('registration');
  });

  it('отказывает во втором открытии понятной ошибкой', async () => {
    const { service } = serviceWith();
    const { tournament } = await service.create(input({ name: uniqueName('Двойное открытие') }));
    await service.open(tournament.id, GUILD);

    await expect(service.open(tournament.id, GUILD)).rejects.toThrow(/только у турнира в состоянии «черновик»/);
  });

  it('закрывает запись обратно в черновик', async () => {
    const { service } = serviceWith();
    const { tournament } = await service.create(input({ name: uniqueName('Закрытие') }));
    await service.open(tournament.id, GUILD);

    const closed = await service.close(tournament.id, GUILD);

    expect(closed.state).toBe('draft');
    await expect(service.close(tournament.id, GUILD)).rejects.toThrow(/открытой записью/);
  });

  it('отменяет и черновик, и турнир с открытой записью', async () => {
    const { service } = serviceWith();
    const draft = await service.create(input({ name: uniqueName('Отмена черновика') }));
    const opened = await service.create(input({ name: uniqueName('Отмена записи') }));
    await service.open(opened.tournament.id, GUILD);

    expect((await service.cancel(draft.tournament.id, GUILD)).state).toBe('cancelled');
    expect((await service.cancel(opened.tournament.id, GUILD)).state).toBe('cancelled');
  });

  it('не отменяет уже отменённый турнир', async () => {
    const { service } = serviceWith();
    const { tournament } = await service.create(input({ name: uniqueName('Дважды отменённый') }));
    await service.cancel(tournament.id, GUILD);

    await expect(service.cancel(tournament.id, GUILD)).rejects.toThrow(/незавершённый турнир/);
  });

  it('не отдаёт и не двигает турнир чужого сервера', async () => {
    const { service } = serviceWith();
    const { tournament } = await service.create(input({ name: uniqueName('Чужой') }));

    await expect(service.require(tournament.id, OTHER_GUILD)).rejects.toThrow(/не найден на этом сервере/);
    await expect(service.open(tournament.id, OTHER_GUILD)).rejects.toThrow(UserError);
  });

  it('перечисляет только незавершённые турниры своего сервера', async () => {
    const { service } = serviceWith();
    const alive = await service.create(input({ name: uniqueName('Живой') }));
    const dead = await service.create(input({ name: uniqueName('Мёртвый') }));
    await service.cancel(dead.tournament.id, GUILD);

    const active = await service.listActive(GUILD);

    expect(active.map((row) => row.id)).toContain(alive.tournament.id);
    expect(active.map((row) => row.id)).not.toContain(dead.tournament.id);
    expect(active.every((row) => row.guildId === GUILD)).toBe(true);
  });
});
```

- [ ] **Step 4: Запустить тесты — убедиться, что падают**

Run: `npm run test:int -- tests/integration/tournaments/db-errors.test.ts tests/integration/tournaments/tournaments-service.test.ts`
Expected: FAIL — модули `db-errors.js` и `tournaments.js` не найдены.

- [ ] **Step 5: Реализовать `src/modules/tournaments/services/db-errors.ts`**

```ts
/**
 * Нарушение уникальности Postgres (SQLSTATE 23505) по конкретному ограничению.
 *
 * Drizzle 0.45 оборачивает ошибку pg в DrizzleQueryError, у которой .message — это
 * «Failed query: …», а код и текст Postgres лежат в .cause. Имя ограничения
 * node-postgres кладёт в поле constraint; текст сообщения Postgres содержит его
 * всегда, поэтому проверяются оба места — иначе распознавание ломается от сборки
 * драйвера, а не от логики.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return false;
  if ((cause as { code?: unknown }).code !== '23505') return false;

  const named = (cause as { constraint?: unknown }).constraint;
  if (typeof named === 'string' && named.length > 0) return named === constraint;

  const message = (cause as { message?: unknown }).message;
  return typeof message === 'string' && message.includes(constraint);
}
```

- [ ] **Step 6: Реализовать `src/modules/tournaments/services/tournaments.ts`**

```ts
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import { guilds, users } from '../../../core/db/schema/core.js';
import { UserError } from '../../../core/errors.js';
import type { EventBus } from '../../../core/events/bus.js';
import { requirementsFor } from '../games.js';
import { tournaments, type EntryMode, type SeedingMode, type TournamentGame } from '../schema.js';

export type TournamentRow = typeof tournaments.$inferSelect;

/** Значения из спеки. */
export const MIN_ENTRANTS_LIMIT = 2;
export const MAX_ENTRANTS_LIMIT = 64;
export const MIN_TEAM_SIZE = 2;
export const MAX_TEAM_SIZE = 10;
export const NAME_MAX_LENGTH = 80;
export const ALLOWED_BEST_OF = [1, 3, 5];
/** Состояния, из которых турнир ещё можно отменить. */
const CANCELLABLE = ['draft', 'registration', 'running'] as const;
const ACTIVE = ['draft', 'registration', 'running'] as const;

export interface CreateTournamentInput {
  guildId: string;
  name: string;
  game: TournamentGame;
  entryMode: EntryMode;
  teamSize: number;
  maxEntrants: number;
  seeding: SeedingMode;
  bestOf: number;
  requireVerified: boolean;
  createdBy: string;
  announceChannelId: string | null;
  matchParentId: string | null;
}

export interface CreateTournamentResult {
  tournament: TournamentRow;
  /** Что бот поправил в параметрах и почему. Показывается организатору. */
  notes: string[];
}

export interface TournamentsService {
  ensureGuild(guildId: string): Promise<void>;
  ensureUser(userId: string): Promise<void>;
  create(input: CreateTournamentInput): Promise<CreateTournamentResult>;
  /** Турнир этого сервера или UserError. */
  require(tournamentId: number, guildId: string): Promise<TournamentRow>;
  open(tournamentId: number, guildId: string): Promise<TournamentRow>;
  close(tournamentId: number, guildId: string): Promise<TournamentRow>;
  cancel(tournamentId: number, guildId: string): Promise<TournamentRow>;
  listActive(guildId: string): Promise<TournamentRow[]>;
}

export function createTournamentsService(deps: { db: Database; bus: EventBus }): TournamentsService {
  const { db, bus } = deps;

  async function ensureGuild(guildId: string): Promise<void> {
    await db.insert(guilds).values({ id: guildId }).onConflictDoNothing();
  }

  async function ensureUser(userId: string): Promise<void> {
    await db.insert(users).values({ id: userId }).onConflictDoNothing();
  }

  return {
    ensureGuild,
    ensureUser,

    async create(input): Promise<CreateTournamentResult> {
      const notes: string[] = [];
      const name = input.name.trim();

      if (name.length === 0 || name.length > NAME_MAX_LENGTH) {
        throw new UserError(`Название турнира должно быть от 1 до ${NAME_MAX_LENGTH} символов.`);
      }
      if (
        !Number.isInteger(input.maxEntrants) ||
        input.maxEntrants < MIN_ENTRANTS_LIMIT ||
        input.maxEntrants > MAX_ENTRANTS_LIMIT
      ) {
        throw new UserError(`Участников должно быть от ${MIN_ENTRANTS_LIMIT} до ${MAX_ENTRANTS_LIMIT}.`);
      }
      if (!ALLOWED_BEST_OF.includes(input.bestOf)) {
        throw new UserError('Карт в матче может быть 1, 3 или 5.');
      }

      let teamSize = input.teamSize;
      if (input.entryMode === 'solo') {
        if (teamSize !== 1) {
          notes.push('Турнир одиночный, поэтому размер состава выставлен в 1.');
        }
        teamSize = 1;
      } else if (!Number.isInteger(teamSize) || teamSize < MIN_TEAM_SIZE || teamSize > MAX_TEAM_SIZE) {
        throw new UserError(`В командном турнире размер состава — от ${MIN_TEAM_SIZE} до ${MAX_TEAM_SIZE} игроков.`);
      }

      const requirements = requirementsFor(input.game);

      if (input.seeding === 'rank' && requirements.rankMode === null) {
        throw new UserError(
          `Жеребьёвка по рангу для «${requirements.label}» невозможна: бот не знает рангов в этой игре. Выбери случайную жеребьёвку.`,
        );
      }

      let requireVerified = input.requireVerified;
      if (requireVerified && !requirements.verifiable) {
        // Иначе турнир не пустил бы вообще никого: подтверждать владение нечем,
        // verified_at у таких привязок всегда NULL.
        requireVerified = false;
        notes.push(
          `Владение аккаунтом ${requirements.label} подтвердить нечем, поэтому требование подтверждённой привязки снято.`,
        );
      }

      await ensureGuild(input.guildId);
      await ensureUser(input.createdBy);

      const [row] = await db
        .insert(tournaments)
        .values({
          guildId: input.guildId,
          name,
          game: input.game,
          entryMode: input.entryMode,
          teamSize,
          maxEntrants: input.maxEntrants,
          seeding: input.seeding,
          bestOf: input.bestOf,
          requireVerified,
          announceChannelId: input.announceChannelId,
          matchParentId: input.matchParentId,
          createdBy: input.createdBy,
        })
        .returning();

      if (!row) throw new UserError('Не удалось создать турнир. Попробуй ещё раз.');

      await bus.emit('tournament.created', {
        tournamentId: row.id,
        guildId: row.guildId,
        game: row.game,
      });

      return { tournament: row, notes };
    },

    async require(tournamentId, guildId): Promise<TournamentRow> {
      const [row] = await db
        .select()
        .from(tournaments)
        .where(and(eq(tournaments.id, tournamentId), eq(tournaments.guildId, guildId)));

      if (!row) throw new UserError('Турнир не найден на этом сервере. Проверь номер в `/bracket`.');
      return row;
    },

    async open(tournamentId, guildId): Promise<TournamentRow> {
      // Условие по состоянию — в WHERE того же UPDATE. Прочитать, проверить в JS и
      // потом записать нельзя: между чтением и записью встаёт вторая такая же команда.
      const [row] = await db
        .update(tournaments)
        .set({ state: 'registration' })
        .where(
          and(
            eq(tournaments.id, tournamentId),
            eq(tournaments.guildId, guildId),
            eq(tournaments.state, 'draft'),
          ),
        )
        .returning();

      if (!row) {
        throw new UserError(
          'Открыть запись можно только у турнира в состоянии «черновик». Проверь `/bracket`: возможно, запись уже открыта, турнир уже идёт или отменён.',
        );
      }
      return row;
    },

    async close(tournamentId, guildId): Promise<TournamentRow> {
      // Отдельного состояния «запись закрыта» спека не вводит, а 'draft' и означает
      // «участники записаться не могут»: закрытие возвращает турнир в черновик,
      // откуда его можно открыть заново или стартовать.
      const [row] = await db
        .update(tournaments)
        .set({ state: 'draft' })
        .where(
          and(
            eq(tournaments.id, tournamentId),
            eq(tournaments.guildId, guildId),
            eq(tournaments.state, 'registration'),
          ),
        )
        .returning();

      if (!row) {
        throw new UserError('Закрыть запись можно только у турнира с открытой записью.');
      }
      return row;
    },

    async cancel(tournamentId, guildId): Promise<TournamentRow> {
      const [row] = await db
        .update(tournaments)
        .set({ state: 'cancelled', finishedAt: new Date() })
        .where(
          and(
            eq(tournaments.id, tournamentId),
            eq(tournaments.guildId, guildId),
            inArray(tournaments.state, [...CANCELLABLE]),
          ),
        )
        .returning();

      if (!row) {
        throw new UserError('Отменить можно только незавершённый турнир.');
      }
      return row;
    },

    async listActive(guildId): Promise<TournamentRow[]> {
      return db
        .select()
        .from(tournaments)
        .where(and(eq(tournaments.guildId, guildId), inArray(tournaments.state, [...ACTIVE])))
        .orderBy(desc(tournaments.id));
    },
  };
}
```

- [ ] **Step 7: Прогнать тесты**

Run: `npm run test:int -- tests/integration/tournaments/db-errors.test.ts tests/integration/tournaments/tournaments-service.test.ts && npm run typecheck`
Expected: 4 теста в `db-errors.test.ts` и 15 в `tournaments-service.test.ts` — 19 PASS, тайпчек чистый.

- [ ] **Step 8: Коммит**

```bash
git add src/core/events/events.ts src/modules/tournaments/services/db-errors.ts src/modules/tournaments/services/tournaments.ts tests/integration/tournaments/db-errors.test.ts tests/integration/tournaments/tournaments-service.test.ts
git commit -m "feat(tournaments): события турниров и жизненный цикл с переходами через условный UPDATE"
```

---

### Task 7: Регистрация одиночек, снятие и чек-ин

**Files:**
- Create: `src/modules/tournaments/services/registration.ts`
- Test: `tests/integration/tournaments/registration.test.ts`

**Interfaces:**
- Consumes: `Database`, `UserError`, `users`; `tournaments`, `tournamentEntrants`, `tournamentEntrantMembers` из схемы (Task 1); `requirementsFor` (Task 2); `IdentityLookup`, `GameLink` (Task 5); `TournamentRow`, `TournamentsService` (Task 6).
- Produces:
  - `type EntrantRow = typeof tournamentEntrants.$inferSelect`
  - `function eligibleLink(deps: { identity: IdentityLookup }, tournament: TournamentRow, userId: string): Promise<GameLink | null>` — бросает `UserError`, если турнир требует подтверждённую привязку, а её нет; иначе отдаёт привязку или `null`.
  - `function freeDisplayName(desired: string, taken: readonly string[]): string` — чистая функция подбора свободного имени.
  - `interface RegistrationService { joinSolo(input: { tournamentId: number; guildId: string; userId: string; fallbackName: string }): Promise<EntrantRow>; leave(input: { tournamentId: number; guildId: string; userId: string }): Promise<{ withdrawn: boolean }>; checkIn(input: { tournamentId: number; guildId: string; userId: string }): Promise<EntrantRow>; entrantOf(tournamentId: number, userId: string): Promise<EntrantRow | null>; countEntrants(tournamentId: number): Promise<number> }`
  - `function createRegistrationService(deps: { db: Database; identity: IdentityLookup; tournaments: TournamentsService }): RegistrationService`

**Две вещи, которые здесь решаются, а не откладываются.**

*Гонка за последним местом.* `select count(*)` → проверка в JS → `insert` пропустит двоих сверх `max_entrants`: оба увидят «место есть». Поэтому каждое вступление начинается с `select ... for('update')` на строке турнира. Эта блокировка сериализует все одновременные вступления в **один** турнир (вступления в разные турниры друг друга не задерживают), и внутри неё честны и подсчёт мест, и подбор свободного имени.

*«Пусто» против «не смогли узнать».* Проверка подтверждённой привязки читает нашу же таблицу `game_accounts` — провайдер игры не опрашивается ни разу. Поэтому пустой результат означает однозначно «привязки нет», а не «сервис Riot не ответил», и отказ в регистрации не может быть следствием чужого сбоя. Если когда-нибудь здесь появится сетевой вызов, различать эти два случая придётся явно.

*Снятие после старта не удаляет строку.* Сетка уже ссылается на участника, и её нельзя пересобирать. Поэтому `leave` до старта удаляет запись, а после старта только ставит `withdrawn_at`; сопернику снятого организатор даёт `/match walkover`.

- [ ] **Step 1: Написать падающий тест**

Файл `tests/integration/tournaments/registration.test.ts`. `IdentityLookup` подменяется заглушкой сознательно: в проде он ничем не оборачивается (кэша у модуля турниров нет вообще), поэтому заглушка ведёт себя так же, как настоящий порт, — а сам порт проверен на настоящем Postgres в Task 5.

```ts
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { UserError } from '../../../src/core/errors.js';
import { EventBus } from '../../../src/core/events/bus.js';
import { createLogger } from '../../../src/core/logger.js';
import type { IdentityLookup } from '../../../src/modules/tournaments/identity-port.js';
import { tournamentEntrants, tournaments } from '../../../src/modules/tournaments/schema.js';
import { createRegistrationService } from '../../../src/modules/tournaments/services/registration.js';
import { createTournamentsService } from '../../../src/modules/tournaments/services/tournaments.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

const GUILD = '810000000000000001';
const ALICE = '820000000000000001';
const BOB = '820000000000000002';
const CAROL = '820000000000000003';

const VERIFIED_LINK = { accountId: 1, displayName: 'Игрок#EUW', verifiedAt: new Date('2026-07-01T00:00:00Z') };

function identityStub(overrides: Partial<IdentityLookup> = {}): IdentityLookup {
  return {
    link: vi.fn<IdentityLookup['link']>(async () => null),
    playerStrength: vi.fn<IdentityLookup['playerStrength']>(async () => 0),
    ...overrides,
  };
}

function servicesWith(identity: IdentityLookup) {
  const bus = new EventBus(logger);
  const tournamentsService = createTournamentsService({ db: pg.db, bus });
  const registration = createRegistrationService({ db: pg.db, identity, tournaments: tournamentsService });
  return { tournamentsService, registration };
}

let counter = 0;

/** Создаёт турнир нужного вида с открытой записью и уникальным именем. */
async function openTournament(
  identity: IdentityLookup,
  overrides: { entryMode?: 'solo' | 'team'; maxEntrants?: number; requireVerified?: boolean } = {},
): Promise<number> {
  counter += 1;
  const { tournamentsService } = servicesWith(identity);
  const { tournament } = await tournamentsService.create({
    guildId: GUILD,
    name: `Турнир регистрации ${counter}`,
    game: 'lol',
    entryMode: overrides.entryMode ?? 'solo',
    teamSize: overrides.entryMode === 'team' ? 5 : 1,
    maxEntrants: overrides.maxEntrants ?? 8,
    seeding: 'random',
    bestOf: 1,
    requireVerified: overrides.requireVerified ?? false,
    createdBy: ALICE,
    announceChannelId: null,
    matchParentId: null,
  });
  await tournamentsService.open(tournament.id, GUILD);
  return tournament.id;
}

beforeEach(async () => {
  const identity = identityStub();
  const { tournamentsService } = servicesWith(identity);
  for (const userId of [ALICE, BOB, CAROL]) await tournamentsService.ensureUser(userId);
});

describe('joinSolo', () => {
  it('записывает игрока и берёт имя участника из привязки', async () => {
    const identity = identityStub({ link: vi.fn<IdentityLookup['link']>(async () => VERIFIED_LINK) });
    const { registration } = servicesWith(identity);
    const tournamentId = await openTournament(identity, { requireVerified: true });

    const entrant = await registration.joinSolo({ tournamentId, guildId: GUILD, userId: BOB, fallbackName: 'bob' });

    expect(entrant.displayName).toBe('Игрок#EUW');
    expect(entrant.captainUserId).toBe(BOB);
    expect(entrant.withdrawnAt).toBeNull();
  });

  it('не пускает без подтверждённой привязки, когда турнир её требует', async () => {
    const unverified = { accountId: 2, displayName: 'Незаверенный#EUW', verifiedAt: null };
    const identity = identityStub({ link: vi.fn<IdentityLookup['link']>(async () => unverified) });
    const { registration } = servicesWith(identity);
    const tournamentId = await openTournament(identity, { requireVerified: true });

    await expect(
      registration.joinSolo({ tournamentId, guildId: GUILD, userId: BOB, fallbackName: 'bob' }),
    ).rejects.toThrow(/подтверждённый аккаунт League of Legends/);
  });

  it('пускает без привязки, когда турнир подтверждения не требует', async () => {
    const identity = identityStub();
    const { registration } = servicesWith(identity);
    const tournamentId = await openTournament(identity, { requireVerified: false });

    const entrant = await registration.joinSolo({ tournamentId, guildId: GUILD, userId: BOB, fallbackName: 'bob' });

    expect(entrant.displayName).toBe('bob');
  });

  it('отправляет в командном турнире к /team create', async () => {
    const identity = identityStub();
    const { registration } = servicesWith(identity);
    const tournamentId = await openTournament(identity, { entryMode: 'team' });

    await expect(
      registration.joinSolo({ tournamentId, guildId: GUILD, userId: BOB, fallbackName: 'bob' }),
    ).rejects.toThrow(/\/team create/);
  });

  it('не пускает, когда запись закрыта', async () => {
    const identity = identityStub();
    const { registration, tournamentsService } = servicesWith(identity);
    const tournamentId = await openTournament(identity);
    await tournamentsService.close(tournamentId, GUILD);

    await expect(
      registration.joinSolo({ tournamentId, guildId: GUILD, userId: BOB, fallbackName: 'bob' }),
    ).rejects.toThrow(/запись на этот турнир сейчас закрыта/i);
  });

  it('не пускает сверх максимума участников', async () => {
    const identity = identityStub();
    const { registration } = servicesWith(identity);
    const tournamentId = await openTournament(identity, { maxEntrants: 2 });

    await registration.joinSolo({ tournamentId, guildId: GUILD, userId: ALICE, fallbackName: 'alice' });
    await registration.joinSolo({ tournamentId, guildId: GUILD, userId: BOB, fallbackName: 'bob' });

    await expect(
      registration.joinSolo({ tournamentId, guildId: GUILD, userId: CAROL, fallbackName: 'carol' }),
    ).rejects.toThrow(/Все места заняты: 2 из 2/);
  });

  it('не даёт записаться дважды', async () => {
    const identity = identityStub();
    const { registration } = servicesWith(identity);
    const tournamentId = await openTournament(identity);
    await registration.joinSolo({ tournamentId, guildId: GUILD, userId: BOB, fallbackName: 'bob' });

    await expect(
      registration.joinSolo({ tournamentId, guildId: GUILD, userId: BOB, fallbackName: 'bob' }),
    ).rejects.toThrow(/уже записан/);
  });

  it('подбирает свободное имя, когда имя из привязки занято', async () => {
    const identity = identityStub({ link: vi.fn<IdentityLookup['link']>(async () => VERIFIED_LINK) });
    const { registration } = servicesWith(identity);
    const tournamentId = await openTournament(identity);

    const first = await registration.joinSolo({ tournamentId, guildId: GUILD, userId: ALICE, fallbackName: 'alice' });
    const second = await registration.joinSolo({ tournamentId, guildId: GUILD, userId: BOB, fallbackName: 'bob' });

    expect(first.displayName).toBe('Игрок#EUW');
    expect(second.displayName).toBe('Игрок#EUW (2)');
  });
});

describe('leave', () => {
  it('до старта удаляет запись целиком', async () => {
    const identity = identityStub();
    const { registration } = servicesWith(identity);
    const tournamentId = await openTournament(identity);
    await registration.joinSolo({ tournamentId, guildId: GUILD, userId: BOB, fallbackName: 'bob' });

    const result = await registration.leave({ tournamentId, guildId: GUILD, userId: BOB });

    expect(result.withdrawn).toBe(false);
    expect(await pg.db.select().from(tournamentEntrants).where(eq(tournamentEntrants.tournamentId, tournamentId))).toHaveLength(0);
  });

  it('после старта снимает участника, не удаляя строку: сетка уже на неё ссылается', async () => {
    const identity = identityStub();
    const { registration } = servicesWith(identity);
    const tournamentId = await openTournament(identity);
    await registration.joinSolo({ tournamentId, guildId: GUILD, userId: BOB, fallbackName: 'bob' });
    await pg.db.update(tournaments).set({ state: 'running' }).where(eq(tournaments.id, tournamentId));

    const result = await registration.leave({ tournamentId, guildId: GUILD, userId: BOB });

    expect(result.withdrawn).toBe(true);
    const [row] = await pg.db.select().from(tournamentEntrants).where(eq(tournamentEntrants.tournamentId, tournamentId));
    expect(row?.withdrawnAt).toBeInstanceOf(Date);
  });

  it('сообщает незаписанному, что выходить не из чего', async () => {
    const identity = identityStub();
    const { registration } = servicesWith(identity);
    const tournamentId = await openTournament(identity);

    await expect(registration.leave({ tournamentId, guildId: GUILD, userId: CAROL })).rejects.toThrow(UserError);
  });
});

describe('checkIn и countEntrants', () => {
  it('отмечает участника и не считает повторный чек-ин ошибкой', async () => {
    const identity = identityStub();
    const { registration } = servicesWith(identity);
    const tournamentId = await openTournament(identity);
    await registration.joinSolo({ tournamentId, guildId: GUILD, userId: BOB, fallbackName: 'bob' });

    const first = await registration.checkIn({ tournamentId, guildId: GUILD, userId: BOB });
    const second = await registration.checkIn({ tournamentId, guildId: GUILD, userId: BOB });

    expect(first.checkedInAt).toBeInstanceOf(Date);
    expect(second.checkedInAt?.getTime()).toBe(first.checkedInAt?.getTime());
  });

  it('отвергает чек-ин от того, кто не участвует', async () => {
    const identity = identityStub();
    const { registration } = servicesWith(identity);
    const tournamentId = await openTournament(identity);

    await expect(registration.checkIn({ tournamentId, guildId: GUILD, userId: CAROL })).rejects.toThrow(
      /не участвуешь/,
    );
  });

  it('не считает снятых участников', async () => {
    const identity = identityStub();
    const { registration } = servicesWith(identity);
    const tournamentId = await openTournament(identity);
    await registration.joinSolo({ tournamentId, guildId: GUILD, userId: ALICE, fallbackName: 'alice' });
    await registration.joinSolo({ tournamentId, guildId: GUILD, userId: BOB, fallbackName: 'bob' });
    await pg.db.update(tournaments).set({ state: 'running' }).where(eq(tournaments.id, tournamentId));
    await registration.leave({ tournamentId, guildId: GUILD, userId: BOB });

    expect(await registration.countEntrants(tournamentId)).toBe(1);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm run test:int -- tests/integration/tournaments/registration.test.ts`
Expected: FAIL — модуль `registration.js` не найден.

- [ ] **Step 3: Реализовать `src/modules/tournaments/services/registration.ts`**

```ts
import { and, count, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import { UserError } from '../../../core/errors.js';
import { requirementsFor } from '../games.js';
import type { GameLink, IdentityLookup } from '../identity-port.js';
import { tournamentEntrantMembers, tournamentEntrants, tournaments } from '../schema.js';
import type { TournamentRow, TournamentsService } from './tournaments.js';

export type EntrantRow = typeof tournamentEntrants.$inferSelect;

const NAME_LIMIT = 40;
const MAX_NAME_SUFFIX = 9;

/**
 * Привязка по игре турнира, если турнир требует подтверждённую — иначе UserError.
 *
 * Читается наша же таблица game_accounts, провайдер игры не опрашивается ни разу.
 * Поэтому «привязки нет» здесь однозначно означает «её нет», а не «сервис игры не
 * ответил», и отказ в регистрации не может быть следствием чужого сбоя.
 */
export async function eligibleLink(
  deps: { identity: IdentityLookup },
  tournament: TournamentRow,
  userId: string,
): Promise<GameLink | null> {
  const requirements = requirementsFor(tournament.game);
  const link = requirements.provider === null ? null : await deps.identity.link(userId, tournament.game);

  if (!tournament.requireVerified) return link;

  if (link === null || link.verifiedAt === null) {
    throw new UserError(
      `Для участия нужен подтверждённый аккаунт ${requirements.label}: привяжи его командой \`/link\` и вернись.`,
    );
  }
  return link;
}

/** Свободное имя участника: занятое дополняется номером. Чистая функция. */
export function freeDisplayName(desired: string, taken: readonly string[]): string {
  const base = desired.trim().slice(0, NAME_LIMIT) || 'Участник';
  const busy = new Set(taken);
  if (!busy.has(base)) return base;

  for (let suffix = 2; suffix <= MAX_NAME_SUFFIX; suffix += 1) {
    const candidate = `${base} (${suffix})`;
    if (!busy.has(candidate)) return candidate;
  }
  throw new UserError(`Не удалось подобрать свободное имя участника от «${base}» — обратись к организатору.`);
}

export interface RegistrationService {
  joinSolo(input: {
    tournamentId: number;
    guildId: string;
    userId: string;
    /** Имя, если привязки нет: обычно имя пользователя Discord. */
    fallbackName: string;
  }): Promise<EntrantRow>;
  /** withdrawn = true — участник снят с уже построенной сетки, а не удалён. */
  leave(input: { tournamentId: number; guildId: string; userId: string }): Promise<{ withdrawn: boolean }>;
  checkIn(input: { tournamentId: number; guildId: string; userId: string }): Promise<EntrantRow>;
  /** Участник, за которого играет этот человек: по составу, а не по капитанству. */
  entrantOf(tournamentId: number, userId: string): Promise<EntrantRow | null>;
  countEntrants(tournamentId: number): Promise<number>;
}

export function createRegistrationService(deps: {
  db: Database;
  identity: IdentityLookup;
  tournaments: TournamentsService;
}): RegistrationService {
  const { db, identity } = deps;

  async function entrantOf(tournamentId: number, userId: string): Promise<EntrantRow | null> {
    const [row] = await db
      .select({ entrant: tournamentEntrants })
      .from(tournamentEntrantMembers)
      .innerJoin(tournamentEntrants, eq(tournamentEntrantMembers.entrantId, tournamentEntrants.id))
      .where(
        and(
          eq(tournamentEntrantMembers.tournamentId, tournamentId),
          eq(tournamentEntrantMembers.userId, userId),
        ),
      );
    return row?.entrant ?? null;
  }

  return {
    entrantOf,

    async countEntrants(tournamentId): Promise<number> {
      const [row] = await db
        .select({ value: count() })
        .from(tournamentEntrants)
        .where(and(eq(tournamentEntrants.tournamentId, tournamentId), isNull(tournamentEntrants.withdrawnAt)));
      return row?.value ?? 0;
    },

    async joinSolo(input): Promise<EntrantRow> {
      await deps.tournaments.ensureUser(input.userId);

      return db.transaction(async (tx) => {
        // Блокировка строки турнира сериализует все одновременные вступления именно в
        // этот турнир. Без неё двое, читающие «мест хватает» одновременно, просочатся
        // сверх max_entrants, и подбор свободного имени тоже станет гонкой.
        const [tournament] = await tx
          .select()
          .from(tournaments)
          .where(and(eq(tournaments.id, input.tournamentId), eq(tournaments.guildId, input.guildId)))
          .for('update');

        if (!tournament) throw new UserError('Турнир не найден на этом сервере. Проверь номер в `/bracket`.');
        if (tournament.state !== 'registration') throw new UserError('Запись на этот турнир сейчас закрыта.');
        if (tournament.entryMode !== 'solo') {
          throw new UserError(
            'Это командный турнир: капитан создаёт состав через `/team create`, остальных он добавляет через `/team invite`.',
          );
        }

        const link = await eligibleLink({ identity }, tournament, input.userId);

        const existing = await tx
          .select()
          .from(tournamentEntrants)
          .where(eq(tournamentEntrants.tournamentId, tournament.id));

        if (existing.some((row) => row.captainUserId === input.userId)) {
          throw new UserError('Ты уже записан на этот турнир. Уйти можно через `/tournament leave`.');
        }

        const active = existing.filter((row) => row.withdrawnAt === null);
        if (active.length >= tournament.maxEntrants) {
          throw new UserError(`Все места заняты: ${active.length} из ${tournament.maxEntrants}.`);
        }

        const displayName = freeDisplayName(
          link?.displayName ?? input.fallbackName,
          existing.map((row) => row.displayName),
        );

        const [entrant] = await tx
          .insert(tournamentEntrants)
          .values({ tournamentId: tournament.id, displayName, captainUserId: input.userId })
          .returning();
        if (!entrant) throw new UserError('Не удалось записать тебя на турнир. Попробуй ещё раз.');

        await tx.insert(tournamentEntrantMembers).values({
          entrantId: entrant.id,
          tournamentId: tournament.id,
          userId: input.userId,
          role: 'captain',
        });

        return entrant;
      });
    },

    async leave(input): Promise<{ withdrawn: boolean }> {
      const tournament = await deps.tournaments.require(input.tournamentId, input.guildId);
      if (tournament.entryMode !== 'solo') {
        throw new UserError(
          'Это командный турнир: выйти из состава — `/team leave`, снять команду целиком — `/team disband`.',
        );
      }

      const [entrant] = await db
        .select()
        .from(tournamentEntrants)
        .where(
          and(
            eq(tournamentEntrants.tournamentId, tournament.id),
            eq(tournamentEntrants.captainUserId, input.userId),
          ),
        );
      if (!entrant) throw new UserError('Ты не записан на этот турнир.');

      if (tournament.state === 'running') {
        if (entrant.withdrawnAt !== null) throw new UserError('Ты уже снят с этого турнира.');
        // Строка остаётся: сетка на неё ссылается, а сетка не пересобирается.
        // Сопернику снятого организатор даёт `/match walkover`.
        await db
          .update(tournamentEntrants)
          .set({ withdrawnAt: new Date() })
          .where(eq(tournamentEntrants.id, entrant.id));
        return { withdrawn: true };
      }

      if (tournament.state !== 'registration' && tournament.state !== 'draft') {
        throw new UserError('Турнир уже завершён или отменён — выходить не из чего.');
      }

      // До старта сетки нет, состав участников не зафиксирован: строку можно удалить,
      // состав участника уйдёт каскадом.
      await db.delete(tournamentEntrants).where(eq(tournamentEntrants.id, entrant.id));
      return { withdrawn: false };
    },

    async checkIn(input): Promise<EntrantRow> {
      const tournament = await deps.tournaments.require(input.tournamentId, input.guildId);
      if (tournament.state !== 'registration' && tournament.state !== 'draft') {
        throw new UserError('Чек-ин доступен до старта турнира.');
      }

      // Для команды отметиться может любой игрок состава: отмечается участник, а не человек.
      const entrant = await entrantOf(tournament.id, input.userId);
      if (!entrant) throw new UserError('Ты не участвуешь в этом турнире.');
      if (entrant.withdrawnAt !== null) throw new UserError('Этот участник снят с турнира.');

      const [row] = await db
        .update(tournamentEntrants)
        .set({ checkedInAt: new Date() })
        .where(and(eq(tournamentEntrants.id, entrant.id), isNull(tournamentEntrants.checkedInAt)))
        .returning();

      // Повторный чек-ин не ошибка и не двигает время: условие isNull его не пропустило.
      return row ?? entrant;
    },
  };
}
```

- [ ] **Step 4: Прогнать тест**

Run: `npm run test:int -- tests/integration/tournaments/registration.test.ts && npm run typecheck`
Expected: 14 тестов PASS, тайпчек чистый.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/tournaments/services/registration.ts tests/integration/tournaments/registration.test.ts
git commit -m "feat(tournaments): регистрация одиночек с блокировкой турнира, снятие и чек-ин"
```

---

### Task 8: Составы команд

**Files:**
- Create: `src/modules/tournaments/services/teams.ts`
- Test: `tests/integration/tournaments/teams.test.ts`

**Interfaces:**
- Consumes: `Database`, `UserError`; схема (Task 1); `isUniqueViolation` (Task 6); `TournamentsService` (Task 6); `IdentityLookup` (Task 5); `eligibleLink`, `EntrantRow` (Task 7).
- Produces:
  - константы `TEAM_SUBS_LIMIT = 2`, `TEAM_NAME_MAX_LENGTH = 40`
  - `interface RosterEntry { userId: string; role: EntrantRole }`
  - `interface IncompleteTeam { entrantId: number; displayName: string; players: number }`
  - `interface TeamsService { create(input: { tournamentId: number; guildId: string; captainUserId: string; name: string }): Promise<EntrantRow>; invite(input: { tournamentId: number; guildId: string; captainUserId: string; userId: string }): Promise<{ entrant: EntrantRow; role: EntrantRole }>; kick(input: { tournamentId: number; guildId: string; captainUserId: string; userId: string }): Promise<void>; leave(input: { tournamentId: number; guildId: string; userId: string }): Promise<void>; disband(input: { tournamentId: number; guildId: string; captainUserId: string }): Promise<{ withdrawn: boolean }>; roster(entrantId: number): Promise<RosterEntry[]>; incompleteTeams(tournamentId: number): Promise<IncompleteTeam[]> }`
  - `function createTeamsService(deps: { db: Database; identity: IdentityLookup; tournaments: TournamentsService }): TeamsService`

**Решения, зафиксированные здесь.**

*`/team invite` добавляет игрока сразу, без принятия приглашения.* Таблицы приглашений в модели спеки нет, а вводить шестую таблицу ради согласия — это отдельная сущность с собственным жизненным циклом. Ошибочно добавленный выходит сам через `/team leave`, капитан убирает лишнего через `/team kick`. Ограничение `tournament_members_tournament_user_uq` при этом не даёт записать в состав человека, уже занятого в другой команде **этого** турнира, — и не запросом, а базой: два одновременных приглашения одного игрока двумя капитанами иначе оба прошли бы проверку.

*Роль назначается автоматически.* Пока игроков (`captain` + `player`) меньше `team_size`, приглашённый становится `player`; дальше — `sub`. Всего в составе не больше `team_size + 2`. При `team_size = 2`: капитан, один `player`, два `sub` — четвёртое приглашение отвергается.

*Роспуск после старта не удаляет команду*, а ставит `withdrawn_at`: на неё уже ссылается сетка.

- [ ] **Step 1: Написать падающий тест**

Файл `tests/integration/tournaments/teams.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { UserError } from '../../../src/core/errors.js';
import { EventBus } from '../../../src/core/events/bus.js';
import { createLogger } from '../../../src/core/logger.js';
import type { IdentityLookup } from '../../../src/modules/tournaments/identity-port.js';
import { tournamentEntrants, tournaments } from '../../../src/modules/tournaments/schema.js';
import { createTeamsService } from '../../../src/modules/tournaments/services/teams.js';
import { createTournamentsService } from '../../../src/modules/tournaments/services/tournaments.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

const GUILD = '910000000000000001';
const CAPTAIN = '920000000000000001';
const SECOND_CAPTAIN = '920000000000000002';
const P1 = '920000000000000003';
const P2 = '920000000000000004';
const P3 = '920000000000000005';
const P4 = '920000000000000006';
const ALL_USERS = [CAPTAIN, SECOND_CAPTAIN, P1, P2, P3, P4];

function identityStub(overrides: Partial<IdentityLookup> = {}): IdentityLookup {
  return {
    link: vi.fn<IdentityLookup['link']>(async () => null),
    playerStrength: vi.fn<IdentityLookup['playerStrength']>(async () => 0),
    ...overrides,
  };
}

function servicesWith(identity: IdentityLookup) {
  const bus = new EventBus(logger);
  const tournamentsService = createTournamentsService({ db: pg.db, bus });
  const teams = createTeamsService({ db: pg.db, identity, tournaments: tournamentsService });
  return { tournamentsService, teams };
}

let counter = 0;

async function openTeamTournament(
  identity: IdentityLookup,
  overrides: { teamSize?: number; requireVerified?: boolean; maxEntrants?: number } = {},
): Promise<number> {
  counter += 1;
  const { tournamentsService } = servicesWith(identity);
  const { tournament } = await tournamentsService.create({
    guildId: GUILD,
    name: `Командный турнир ${counter}`,
    game: 'lol',
    entryMode: 'team',
    teamSize: overrides.teamSize ?? 2,
    maxEntrants: overrides.maxEntrants ?? 8,
    seeding: 'random',
    bestOf: 1,
    requireVerified: overrides.requireVerified ?? false,
    createdBy: CAPTAIN,
    announceChannelId: null,
    matchParentId: null,
  });
  await tournamentsService.open(tournament.id, GUILD);
  return tournament.id;
}

beforeEach(async () => {
  const { tournamentsService } = servicesWith(identityStub());
  for (const userId of ALL_USERS) await tournamentsService.ensureUser(userId);
});

describe('создание команды', () => {
  it('создаёт команду и делает автора капитаном', async () => {
    const identity = identityStub();
    const { teams } = servicesWith(identity);
    const tournamentId = await openTeamTournament(identity);

    const entrant = await teams.create({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, name: 'Красные' });
    const roster = await teams.roster(entrant.id);

    expect(entrant.displayName).toBe('Красные');
    expect(roster).toEqual([{ userId: CAPTAIN, role: 'captain' }]);
  });

  it('отвергает занятое название', async () => {
    const identity = identityStub();
    const { teams } = servicesWith(identity);
    const tournamentId = await openTeamTournament(identity);
    await teams.create({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, name: 'Красные' });

    await expect(
      teams.create({ tournamentId, guildId: GUILD, captainUserId: SECOND_CAPTAIN, name: 'Красные' }),
    ).rejects.toThrow(/уже есть/);
  });

  it('не даёт одному человеку создать две команды в одном турнире', async () => {
    const identity = identityStub();
    const { teams } = servicesWith(identity);
    const tournamentId = await openTeamTournament(identity);
    await teams.create({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, name: 'Красные' });

    await expect(
      teams.create({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, name: 'Синие' }),
    ).rejects.toThrow(/уже участвуешь/);
  });

  it('требует подтверждённую привязку от капитана, когда турнир этого требует', async () => {
    const identity = identityStub({
      link: vi.fn<IdentityLookup['link']>(async () => ({ accountId: 1, displayName: 'x#EUW', verifiedAt: null })),
    });
    const { teams } = servicesWith(identity);
    const tournamentId = await openTeamTournament(identity, { requireVerified: true });

    await expect(
      teams.create({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, name: 'Красные' }),
    ).rejects.toThrow(/подтверждённый аккаунт/);
  });
});

describe('приглашения', () => {
  it('добавляет игроком, пока состав не заполнен, и запасным дальше', async () => {
    const identity = identityStub();
    const { teams } = servicesWith(identity);
    const tournamentId = await openTeamTournament(identity, { teamSize: 2 });
    const entrant = await teams.create({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, name: 'Красные' });

    const first = await teams.invite({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, userId: P1 });
    const second = await teams.invite({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, userId: P2 });
    const third = await teams.invite({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, userId: P3 });

    expect(first.role).toBe('player');
    expect(second.role).toBe('sub');
    expect(third.role).toBe('sub');
    expect(await teams.roster(entrant.id)).toHaveLength(4);
  });

  it('не пускает в состав больше team_size + 2 человек', async () => {
    const identity = identityStub();
    const { teams } = servicesWith(identity);
    const tournamentId = await openTeamTournament(identity, { teamSize: 2 });
    await teams.create({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, name: 'Красные' });
    for (const userId of [P1, P2, P3]) {
      await teams.invite({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, userId });
    }

    await expect(
      teams.invite({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, userId: P4 }),
    ).rejects.toThrow(/больше 4 человек/);
  });

  it('не даёт добавить того, кто уже играет за другую команду этого турнира', async () => {
    const identity = identityStub();
    const { teams } = servicesWith(identity);
    const tournamentId = await openTeamTournament(identity);
    await teams.create({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, name: 'Красные' });
    await teams.invite({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, userId: P1 });
    await teams.create({ tournamentId, guildId: GUILD, captainUserId: SECOND_CAPTAIN, name: 'Синие' });

    await expect(
      teams.invite({ tournamentId, guildId: GUILD, captainUserId: SECOND_CAPTAIN, userId: P1 }),
    ).rejects.toThrow(/уже занят в другом составе/);
  });

  it('не даёт добавить того, кто уже в этом же составе', async () => {
    const identity = identityStub();
    const { teams } = servicesWith(identity);
    const tournamentId = await openTeamTournament(identity);
    await teams.create({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, name: 'Красные' });
    await teams.invite({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, userId: P1 });

    await expect(
      teams.invite({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, userId: P1 }),
    ).rejects.toThrow(/уже в твоём составе/);
  });

  it('не даёт приглашать тому, кто не капитан', async () => {
    const identity = identityStub();
    const { teams } = servicesWith(identity);
    const tournamentId = await openTeamTournament(identity);
    await teams.create({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, name: 'Красные' });

    await expect(
      teams.invite({ tournamentId, guildId: GUILD, captainUserId: P4, userId: P1 }),
    ).rejects.toThrow(/не капитан/);
  });
});

describe('исключение, выход и роспуск', () => {
  it('исключает игрока, но не капитана', async () => {
    const identity = identityStub();
    const { teams } = servicesWith(identity);
    const tournamentId = await openTeamTournament(identity);
    const entrant = await teams.create({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, name: 'Красные' });
    await teams.invite({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, userId: P1 });

    await teams.kick({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, userId: P1 });

    expect(await teams.roster(entrant.id)).toEqual([{ userId: CAPTAIN, role: 'captain' }]);
    // Подстрока сверена с текстом kick: «Себя исключить нельзя: сними команду целиком …».
    await expect(
      teams.kick({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, userId: CAPTAIN }),
    ).rejects.toThrow(/Себя исключить нельзя/);
  });

  it('выпускает игрока из состава, а капитану выход запрещает', async () => {
    const identity = identityStub();
    const { teams } = servicesWith(identity);
    const tournamentId = await openTeamTournament(identity);
    const entrant = await teams.create({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, name: 'Красные' });
    await teams.invite({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, userId: P1 });

    await teams.leave({ tournamentId, guildId: GUILD, userId: P1 });

    expect(await teams.roster(entrant.id)).toHaveLength(1);
    await expect(teams.leave({ tournamentId, guildId: GUILD, userId: CAPTAIN })).rejects.toThrow(/\/team disband/);
  });

  it('до старта роспуск удаляет команду целиком', async () => {
    const identity = identityStub();
    const { teams } = servicesWith(identity);
    const tournamentId = await openTeamTournament(identity);
    await teams.create({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, name: 'Красные' });

    const result = await teams.disband({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN });

    expect(result.withdrawn).toBe(false);
    expect(await pg.db.select().from(tournamentEntrants).where(eq(tournamentEntrants.tournamentId, tournamentId))).toHaveLength(0);
  });

  it('после старта роспуск снимает команду, не удаляя строку', async () => {
    const identity = identityStub();
    const { teams } = servicesWith(identity);
    const tournamentId = await openTeamTournament(identity);
    await teams.create({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, name: 'Красные' });
    await pg.db.update(tournaments).set({ state: 'running' }).where(eq(tournaments.id, tournamentId));

    const result = await teams.disband({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN });

    expect(result.withdrawn).toBe(true);
    const [row] = await pg.db.select().from(tournamentEntrants).where(eq(tournamentEntrants.tournamentId, tournamentId));
    expect(row?.withdrawnAt).toBeInstanceOf(Date);
  });

  it('после старта не даёт менять состав', async () => {
    const identity = identityStub();
    const { teams } = servicesWith(identity);
    const tournamentId = await openTeamTournament(identity);
    await teams.create({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, name: 'Красные' });
    await pg.db.update(tournaments).set({ state: 'running' }).where(eq(tournaments.id, tournamentId));

    await expect(
      teams.invite({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, userId: P1 }),
    ).rejects.toThrow(UserError);
  });
});

describe('incompleteTeams', () => {
  it('показывает недобранные составы и молчит про полные', async () => {
    const identity = identityStub();
    const { teams } = servicesWith(identity);
    const tournamentId = await openTeamTournament(identity, { teamSize: 2 });
    const full = await teams.create({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, name: 'Полные' });
    await teams.invite({ tournamentId, guildId: GUILD, captainUserId: CAPTAIN, userId: P1 });
    const short = await teams.create({ tournamentId, guildId: GUILD, captainUserId: SECOND_CAPTAIN, name: 'Неполные' });

    const incomplete = await teams.incompleteTeams(tournamentId);

    expect(incomplete.map((team) => team.entrantId)).toEqual([short.id]);
    expect(incomplete[0]?.players).toBe(1);
    expect(incomplete.map((team) => team.entrantId)).not.toContain(full.id);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm run test:int -- tests/integration/tournaments/teams.test.ts`
Expected: FAIL — модуль `teams.js` не найден.

- [ ] **Step 3: Реализовать `src/modules/tournaments/services/teams.ts`**

```ts
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import { UserError } from '../../../core/errors.js';
import type { IdentityLookup } from '../identity-port.js';
import { tournamentEntrantMembers, tournamentEntrants, tournaments, type EntrantRole } from '../schema.js';
import { isUniqueViolation } from './db-errors.js';
import { eligibleLink, type EntrantRow } from './registration.js';
import type { TournamentRow, TournamentsService } from './tournaments.js';

/** Запасных сверх team_size. Значение из ограничений плана. */
export const TEAM_SUBS_LIMIT = 2;
export const TEAM_NAME_MAX_LENGTH = 40;

export interface RosterEntry {
  userId: string;
  role: EntrantRole;
}

export interface IncompleteTeam {
  entrantId: number;
  displayName: string;
  /** Игроки (capitan + player), запасные не считаются. */
  players: number;
}

export interface TeamsService {
  create(input: { tournamentId: number; guildId: string; captainUserId: string; name: string }): Promise<EntrantRow>;
  invite(input: {
    tournamentId: number;
    guildId: string;
    captainUserId: string;
    userId: string;
  }): Promise<{ entrant: EntrantRow; role: EntrantRole }>;
  kick(input: { tournamentId: number; guildId: string; captainUserId: string; userId: string }): Promise<void>;
  leave(input: { tournamentId: number; guildId: string; userId: string }): Promise<void>;
  disband(input: { tournamentId: number; guildId: string; captainUserId: string }): Promise<{ withdrawn: boolean }>;
  roster(entrantId: number): Promise<RosterEntry[]>;
  incompleteTeams(tournamentId: number): Promise<IncompleteTeam[]>;
}

const ROSTER_ROLE_ORDER: Record<EntrantRole, number> = { captain: 0, player: 1, sub: 2 };

export function createTeamsService(deps: {
  db: Database;
  identity: IdentityLookup;
  tournaments: TournamentsService;
}): TeamsService {
  const { db, identity } = deps;

  function assertTeamMode(tournament: TournamentRow): void {
    if (tournament.entryMode !== 'team') {
      throw new UserError('Этот турнир одиночный: записывайся через `/tournament join`.');
    }
  }

  function assertRegistrationOpen(tournament: TournamentRow): void {
    if (tournament.state !== 'registration') {
      throw new UserError('Составы можно менять только при открытой записи: после старта сетка уже построена.');
    }
  }

  async function captainEntrant(tournamentId: number, captainUserId: string): Promise<EntrantRow> {
    const [entrant] = await db
      .select()
      .from(tournamentEntrants)
      .where(
        and(
          eq(tournamentEntrants.tournamentId, tournamentId),
          eq(tournamentEntrants.captainUserId, captainUserId),
        ),
      );
    if (!entrant) {
      throw new UserError('Ты не капитан ни одной команды в этом турнире. Создай её через `/team create`.');
    }
    return entrant;
  }

  async function roster(entrantId: number): Promise<RosterEntry[]> {
    const rows = await db
      .select({ userId: tournamentEntrantMembers.userId, role: tournamentEntrantMembers.role })
      .from(tournamentEntrantMembers)
      .where(eq(tournamentEntrantMembers.entrantId, entrantId))
      .orderBy(asc(tournamentEntrantMembers.id));

    return [...rows].sort((left, right) => ROSTER_ROLE_ORDER[left.role] - ROSTER_ROLE_ORDER[right.role]);
  }

  return {
    roster,

    async create(input): Promise<EntrantRow> {
      await deps.tournaments.ensureUser(input.captainUserId);
      const name = input.name.trim();
      if (name.length === 0 || name.length > TEAM_NAME_MAX_LENGTH) {
        throw new UserError(`Название команды должно быть от 1 до ${TEAM_NAME_MAX_LENGTH} символов.`);
      }

      return db.transaction(async (tx) => {
        // Та же блокировка, что в joinSolo: она сериализует одновременные создания
        // команд в этом турнире, поэтому проверка мест и занятости названия честны.
        const [tournament] = await tx
          .select()
          .from(tournaments)
          .where(and(eq(tournaments.id, input.tournamentId), eq(tournaments.guildId, input.guildId)))
          .for('update');
        if (!tournament) throw new UserError('Турнир не найден на этом сервере. Проверь номер в `/bracket`.');
        assertTeamMode(tournament);
        assertRegistrationOpen(tournament);

        await eligibleLink({ identity }, tournament, input.captainUserId);

        const existing = await tx
          .select()
          .from(tournamentEntrants)
          .where(eq(tournamentEntrants.tournamentId, tournament.id));

        if (existing.some((row) => row.captainUserId === input.captainUserId)) {
          throw new UserError('Ты уже участвуешь в этом турнире.');
        }
        if (existing.some((row) => row.displayName === name)) {
          throw new UserError(`Команда с названием «${name}» в этом турнире уже есть — выбери другое.`);
        }

        const active = existing.filter((row) => row.withdrawnAt === null);
        if (active.length >= tournament.maxEntrants) {
          throw new UserError(`Все места заняты: ${active.length} из ${tournament.maxEntrants}.`);
        }

        const [entrant] = await tx
          .insert(tournamentEntrants)
          .values({ tournamentId: tournament.id, displayName: name, captainUserId: input.captainUserId })
          .returning();
        if (!entrant) throw new UserError('Не удалось создать команду. Попробуй ещё раз.');

        await tx.insert(tournamentEntrantMembers).values({
          entrantId: entrant.id,
          tournamentId: tournament.id,
          userId: input.captainUserId,
          role: 'captain',
        });

        return entrant;
      });
    },

    async invite(input): Promise<{ entrant: EntrantRow; role: EntrantRole }> {
      await deps.tournaments.ensureUser(input.userId);
      const tournament = await deps.tournaments.require(input.tournamentId, input.guildId);
      assertTeamMode(tournament);
      assertRegistrationOpen(tournament);

      const entrant = await captainEntrant(tournament.id, input.captainUserId);
      await eligibleLink({ identity }, tournament, input.userId);

      const members = await roster(entrant.id);
      if (members.some((member) => member.userId === input.userId)) {
        throw new UserError('Он уже в твоём составе.');
      }

      const limit = tournament.teamSize + TEAM_SUBS_LIMIT;
      if (members.length >= limit) {
        throw new UserError(`В составе не может быть больше ${limit} человек: ${tournament.teamSize} игроков и ${TEAM_SUBS_LIMIT} запасных.`);
      }

      const players = members.filter((member) => member.role !== 'sub').length;
      const role: EntrantRole = players < tournament.teamSize ? 'player' : 'sub';

      try {
        await db.insert(tournamentEntrantMembers).values({
          entrantId: entrant.id,
          tournamentId: tournament.id,
          userId: input.userId,
          role,
        });
      } catch (error) {
        // Ограничение базы, а не проверка запросом: два капитана, приглашающие одного
        // игрока одновременно, оба прошли бы проверку выше — второй падает здесь.
        if (isUniqueViolation(error, 'tournament_members_tournament_user_uq')) {
          throw new UserError('Этот игрок уже занят в другом составе этого турнира.');
        }
        if (isUniqueViolation(error, 'tournament_members_entrant_user_uq')) {
          throw new UserError('Он уже в твоём составе.');
        }
        throw error;
      }

      return { entrant, role };
    },

    async kick(input): Promise<void> {
      const tournament = await deps.tournaments.require(input.tournamentId, input.guildId);
      assertTeamMode(tournament);
      assertRegistrationOpen(tournament);

      const entrant = await captainEntrant(tournament.id, input.captainUserId);
      if (input.userId === input.captainUserId) {
        throw new UserError('Себя исключить нельзя: сними команду целиком через `/team disband`.');
      }

      const removed = await db
        .delete(tournamentEntrantMembers)
        .where(
          and(
            eq(tournamentEntrantMembers.entrantId, entrant.id),
            eq(tournamentEntrantMembers.userId, input.userId),
          ),
        )
        .returning({ id: tournamentEntrantMembers.id });

      if (removed.length === 0) throw new UserError('Этого игрока в твоём составе нет.');
    },

    async leave(input): Promise<void> {
      const tournament = await deps.tournaments.require(input.tournamentId, input.guildId);
      assertTeamMode(tournament);
      assertRegistrationOpen(tournament);

      const [membership] = await db
        .select({ entrantId: tournamentEntrantMembers.entrantId, role: tournamentEntrantMembers.role })
        .from(tournamentEntrantMembers)
        .where(
          and(
            eq(tournamentEntrantMembers.tournamentId, tournament.id),
            eq(tournamentEntrantMembers.userId, input.userId),
          ),
        );
      if (!membership) throw new UserError('Ты не участвуешь в этом турнире.');
      if (membership.role === 'captain') {
        throw new UserError('Капитан не может выйти из своего состава: сними команду через `/team disband`.');
      }

      await db
        .delete(tournamentEntrantMembers)
        .where(
          and(
            eq(tournamentEntrantMembers.entrantId, membership.entrantId),
            eq(tournamentEntrantMembers.userId, input.userId),
          ),
        );
    },

    async disband(input): Promise<{ withdrawn: boolean }> {
      const tournament = await deps.tournaments.require(input.tournamentId, input.guildId);
      assertTeamMode(tournament);

      const entrant = await captainEntrant(tournament.id, input.captainUserId);

      if (tournament.state === 'running') {
        if (entrant.withdrawnAt !== null) throw new UserError('Эта команда уже снята с турнира.');
        // Строка остаётся: сетка на неё ссылается. Сопернику — `/match walkover`.
        await db
          .update(tournamentEntrants)
          .set({ withdrawnAt: new Date() })
          .where(eq(tournamentEntrants.id, entrant.id));
        return { withdrawn: true };
      }

      if (tournament.state !== 'registration' && tournament.state !== 'draft') {
        throw new UserError('Турнир уже завершён или отменён — снимать нечего.');
      }

      await db.delete(tournamentEntrants).where(eq(tournamentEntrants.id, entrant.id));
      return { withdrawn: false };
    },

    async incompleteTeams(tournamentId): Promise<IncompleteTeam[]> {
      const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, tournamentId));
      if (!tournament) return [];

      const rows = await db
        .select({
          entrantId: tournamentEntrants.id,
          displayName: tournamentEntrants.displayName,
          // count по join даёт bigint строкой — mapWith(Number) приводит к числу.
          players: sql<number>`count(${tournamentEntrantMembers.id})`.mapWith(Number),
        })
        .from(tournamentEntrants)
        .leftJoin(
          tournamentEntrantMembers,
          and(
            eq(tournamentEntrantMembers.entrantId, tournamentEntrants.id),
            inArray(tournamentEntrantMembers.role, ['captain', 'player']),
          ),
        )
        .where(and(eq(tournamentEntrants.tournamentId, tournamentId), isNull(tournamentEntrants.withdrawnAt)))
        .groupBy(tournamentEntrants.id, tournamentEntrants.displayName)
        .orderBy(asc(tournamentEntrants.id));

      return rows.filter((row) => row.players < tournament.teamSize);
    },
  };
}
```

- [ ] **Step 4: Прогнать тест**

Run: `npm run test:int -- tests/integration/tournaments/teams.test.ts && npm run typecheck`
Expected: 15 тестов PASS (4 + 5 + 5 + 1 по describe-блокам), тайпчек чистый.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/tournaments/services/teams.ts tests/integration/tournaments/teams.test.ts
git commit -m "feat(tournaments): составы команд с ограничением «один человек — один состав» на уровне базы"
```

---

### Task 9: Старт турнира — жеребьёвка и сетка

**Files:**
- Create: `src/modules/tournaments/services/start.ts`
- Test: `tests/integration/tournaments/start.test.ts`

**Interfaces:**
- Consumes: `Database`, `EventBus`, `Logger`, `UserError`; схема (Task 1); `buildBracket`, `PlannedMatch` (Task 4); `orderEntrants`, `EntrantStrength` (Task 3); `IdentityLookup` (Task 5); `TournamentRow`, `TournamentsService` (Task 6); `TeamsService.incompleteTeams` (Task 8).
- Produces:
  - `type MatchRow = typeof tournamentMatches.$inferSelect`
  - `interface StartResult { tournament: TournamentRow; size: number; rounds: number; entrants: number; matches: MatchRow[]; readyMatches: MatchRow[]; byeMatches: MatchRow[] }`
  - `interface StartService { start(input: { tournamentId: number; guildId: string }): Promise<StartResult> }`
  - `function createStartService(deps: { db: Database; identity: IdentityLookup; teams: TeamsService; tournaments: TournamentsService; bus: EventBus; logger: Logger; random?: () => number }): StartService`

**Как устроен старт и почему в два прохода.**

Фаза 1 (без транзакции): читаем турнир, проверяем состояние, участников, полноту составов и считаем силу каждого участника. Считать силу внутри транзакции нельзя: это `N` запросов к таблицам этапа 1, и держать всё это время блокировку турнира незачем.

Фаза 2 (одна транзакция):
1. **условный UPDATE** `state = 'running' WHERE state = 'registration'` — он же и есть защита от двойного старта: второй одновременный `/tournament start` получит ноль строк и откатится, ничего не построив;
2. заново читаем идентификаторы участников **внутри** транзакции и сверяем со списком из фазы 1. Разошлись — значит кто-то записался или снялся, пока считалась сила: бросаем `UserError` с просьбой повторить, транзакция откатывается вместе с переводом в `running`. Строить сетку по устаревшему составу нельзя, а «досчитать на ходу» — значит вернуть в транзакцию те самые `N` запросов;
3. записываем сиды, вставляем матчи (`best_of` турнира копируется в каждый), пишем строки `bye` в журнал.

События `tournament.started` и `match.ready` публикуются **после** коммита. Ветки под матчи создаёт подписчик `match.ready` (Task 18) — ни одного вызова Discord внутри транзакции.

**Арифметика силы состава, просчитанная руками.** Сила участника — среднее `rankScore` играющего состава (`captain` и `player`; запасные не учитываются — играют не они), округлённое к ближайшему целому:

| Состав | Скоры игроков | Сумма | Среднее | Сила |
|---|---|---|---|---|
| пятёрка смешанного уровня | 3247, 4000, 0, 6388, 7999 | 21634 | 21634 / 5 = 4326.8 | **4327** |
| двойка | 3247, 4000 | 7247 | 7247 / 2 = 3623.5 | **3624** |
| двойка без рангов | 0, 0 | 0 | 0 | **0** |
| одиночка (соло-турнир) | 3247 | 3247 | 3247 / 1 | **3247** |

Дальше `orderEntrants` расставляет по силе вниз, равенство разрешает по `entrant.id`, и сиды 1..N попадают в слоты по `seedSlotOrder`.

**Чек-ин на старт не влияет.** `/checkin` — информация для организатора, а не фильтр: молча выкинуть из сетки того, кто забыл отметиться, значит превратить забывчивость в дисквалификацию без предупреждения.

- [ ] **Step 1: Написать падающий тест**

Файл `tests/integration/tournaments/start.test.ts`:

```ts
import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { UserError } from '../../../src/core/errors.js';
import { EventBus } from '../../../src/core/events/bus.js';
import { createLogger } from '../../../src/core/logger.js';
import type { BotEvents } from '../../../src/core/events/events.js';
import type { IdentityLookup } from '../../../src/modules/tournaments/identity-port.js';
import { tournamentMatchReports, tournamentMatches, tournamentEntrants, tournaments } from '../../../src/modules/tournaments/schema.js';
import { createRegistrationService } from '../../../src/modules/tournaments/services/registration.js';
import { createStartService } from '../../../src/modules/tournaments/services/start.js';
import { createTeamsService } from '../../../src/modules/tournaments/services/teams.js';
import { createTournamentsService } from '../../../src/modules/tournaments/services/tournaments.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

const GUILD = '100000000000000001';
const PLAYERS = Array.from({ length: 12 }, (_unused, index) => `1010000000000000${String(index + 10)}`);

function identityStub(strengths: Map<string, number> = new Map()): IdentityLookup {
  return {
    link: vi.fn<IdentityLookup['link']>(async () => null),
    playerStrength: vi.fn<IdentityLookup['playerStrength']>(async (userId) => strengths.get(userId) ?? 0),
  };
}

function servicesWith(identity: IdentityLookup) {
  const bus = new EventBus(logger);
  const tournamentsService = createTournamentsService({ db: pg.db, bus });
  const teams = createTeamsService({ db: pg.db, identity, tournaments: tournamentsService });
  const registration = createRegistrationService({ db: pg.db, identity, tournaments: tournamentsService });
  const start = createStartService({
    db: pg.db,
    identity,
    teams,
    tournaments: tournamentsService,
    bus,
    logger,
    random: () => 0.5,
  });
  return { bus, tournamentsService, teams, registration, start };
}

let counter = 0;

/** Соло-турнир с открытой записью и count записанными игроками. */
async function soloTournamentWith(
  identity: IdentityLookup,
  count: number,
  seeding: 'random' | 'rank' = 'rank',
): Promise<number> {
  counter += 1;
  const { tournamentsService, registration } = servicesWith(identity);
  const { tournament } = await tournamentsService.create({
    guildId: GUILD,
    name: `Старт ${counter}`,
    game: 'lol',
    entryMode: 'solo',
    teamSize: 1,
    maxEntrants: 64,
    seeding,
    bestOf: 3,
    requireVerified: false,
    createdBy: PLAYERS[0] ?? 'x',
    announceChannelId: null,
    matchParentId: null,
  });
  await tournamentsService.open(tournament.id, GUILD);

  for (const userId of PLAYERS.slice(0, count)) {
    await registration.joinSolo({ tournamentId: tournament.id, guildId: GUILD, userId, fallbackName: userId.slice(-2) });
  }
  return tournament.id;
}

beforeEach(async () => {
  const { tournamentsService } = servicesWith(identityStub());
  await tournamentsService.ensureGuild(GUILD);
  for (const userId of PLAYERS) await tournamentsService.ensureUser(userId);
});

describe('старт соло-турнира', () => {
  it('переводит турнир в running, ставит started_at и строит семь матчей на восемь участников', async () => {
    const identity = identityStub();
    const { start } = servicesWith(identity);
    const tournamentId = await soloTournamentWith(identity, 8);

    const result = await start.start({ tournamentId, guildId: GUILD });

    expect(result.tournament.state).toBe('running');
    expect(result.tournament.startedAt).toBeInstanceOf(Date);
    expect(result.size).toBe(8);
    expect(result.rounds).toBe(3);
    expect(result.matches).toHaveLength(7);
    expect(result.entrants).toBe(8);
  });

  it('копирует best_of турнира в каждый матч', async () => {
    const identity = identityStub();
    const { start } = servicesWith(identity);
    const tournamentId = await soloTournamentWith(identity, 4);

    const result = await start.start({ tournamentId, guildId: GUILD });

    expect(result.matches.every((match) => match.bestOf === 3)).toBe(true);
  });

  it('присваивает сиды 1..N и отдаёт первый сид сильнейшему', async () => {
    const strengths = new Map<string, number>();
    // Четвёрка: сила падает от первого к четвёртому.
    strengths.set(PLAYERS[0] ?? '', 7999);
    strengths.set(PLAYERS[1] ?? '', 6388);
    strengths.set(PLAYERS[2] ?? '', 3247);
    strengths.set(PLAYERS[3] ?? '', 0);
    const identity = identityStub(strengths);
    const { start } = servicesWith(identity);
    const tournamentId = await soloTournamentWith(identity, 4);

    await start.start({ tournamentId, guildId: GUILD });

    const entrants = await pg.db
      .select()
      .from(tournamentEntrants)
      .where(eq(tournamentEntrants.tournamentId, tournamentId))
      .orderBy(asc(tournamentEntrants.seed));

    expect(entrants.map((entrant) => entrant.seed)).toEqual([1, 2, 3, 4]);
    expect(entrants[0]?.captainUserId).toBe(PLAYERS[0]);
    expect(entrants[3]?.captainUserId).toBe(PLAYERS[3]);
  });

  it('на пяти участниках даёт три пропуска старшим сеяным и проводит их в круг 2', async () => {
    const strengths = new Map<string, number>();
    PLAYERS.slice(0, 5).forEach((userId, index) => strengths.set(userId, 9000 - index * 1000));
    const identity = identityStub(strengths);
    const { start } = servicesWith(identity);
    const tournamentId = await soloTournamentWith(identity, 5);

    const result = await start.start({ tournamentId, guildId: GUILD });

    expect(result.byeMatches.map((match) => match.slot)).toEqual([0, 2, 3]);
    // Победители пропусков уже стоят во втором круге, и матч 2/1 готов сразу.
    const secondRound = result.matches.filter((match) => match.round === 2);
    expect(secondRound.find((match) => match.slot === 1)?.state).toBe('ready');
    expect(secondRound.find((match) => match.slot === 0)?.state).toBe('pending');
  });

  it('пишет каждый пропуск в журнал репортов как решение бота', async () => {
    const identity = identityStub();
    const { start } = servicesWith(identity);
    const tournamentId = await soloTournamentWith(identity, 5);

    await start.start({ tournamentId, guildId: GUILD });

    const reports = await pg.db
      .select()
      .from(tournamentMatchReports)
      .where(eq(tournamentMatchReports.tournamentId, tournamentId));

    expect(reports).toHaveLength(3);
    expect(reports.every((report) => report.kind === 'bye')).toBe(true);
    expect(reports.every((report) => report.actorUserId === null)).toBe(true);
  });

  it('публикует tournament.started и match.ready на каждый готовый матч', async () => {
    const identity = identityStub();
    const { start, bus } = servicesWith(identity);
    const tournamentId = await soloTournamentWith(identity, 8);
    const started: Array<BotEvents['tournament.started']> = [];
    const ready: Array<BotEvents['match.ready']> = [];
    bus.on('tournament.started', (payload) => {
      started.push(payload);
    });
    bus.on('match.ready', (payload) => {
      ready.push(payload);
    });

    const result = await start.start({ tournamentId, guildId: GUILD });

    expect(started).toEqual([{ tournamentId, guildId: GUILD, entrants: 8 }]);
    expect(ready).toHaveLength(4);
    expect(ready.map((event) => event.matchId).sort()).toEqual(
      result.readyMatches.map((match) => match.id).sort(),
    );
  });

  it('не пересобирает сетку на повторный старт', async () => {
    const identity = identityStub();
    const { start } = servicesWith(identity);
    const tournamentId = await soloTournamentWith(identity, 8);
    await start.start({ tournamentId, guildId: GUILD });

    await expect(start.start({ tournamentId, guildId: GUILD })).rejects.toThrow(/только турнир с открытой записью/);

    const matches = await pg.db.select().from(tournamentMatches).where(eq(tournamentMatches.tournamentId, tournamentId));
    expect(matches).toHaveLength(7);
  });

  it('отказывается стартовать с одним участником и оставляет запись открытой', async () => {
    const identity = identityStub();
    const { start } = servicesWith(identity);
    const tournamentId = await soloTournamentWith(identity, 1);

    await expect(start.start({ tournamentId, guildId: GUILD })).rejects.toThrow(UserError);

    const [tournament] = await pg.db.select().from(tournaments).where(eq(tournaments.id, tournamentId));
    expect(tournament?.state).toBe('registration');
    expect(await pg.db.select().from(tournamentMatches).where(eq(tournamentMatches.tournamentId, tournamentId))).toHaveLength(0);
  });

  it('не берёт в сетку снятых участников', async () => {
    const identity = identityStub();
    const { start, registration } = servicesWith(identity);
    const tournamentId = await soloTournamentWith(identity, 5);
    // Снятие до старта удаляет запись, поэтому снимаем «по-настоящему»: ставим withdrawn_at.
    const [victim] = await pg.db
      .select()
      .from(tournamentEntrants)
      .where(eq(tournamentEntrants.tournamentId, tournamentId))
      .orderBy(asc(tournamentEntrants.id));
    await pg.db
      .update(tournamentEntrants)
      .set({ withdrawnAt: new Date() })
      .where(eq(tournamentEntrants.id, victim?.id ?? 0));

    const result = await start.start({ tournamentId, guildId: GUILD });

    expect(result.entrants).toBe(4);
    expect(result.size).toBe(4);
    expect(await registration.countEntrants(tournamentId)).toBe(4);
  });

  it('жеребьёвка по рангу воспроизводима: два турнира с тем же составом дают тот же порядок сидов', async () => {
    const strengths = new Map<string, number>();
    PLAYERS.slice(0, 4).forEach((userId, index) => strengths.set(userId, 1000 * (4 - index)));
    const identity = identityStub(strengths);
    const { start } = servicesWith(identity);

    const firstId = await soloTournamentWith(identity, 4);
    await start.start({ tournamentId: firstId, guildId: GUILD });
    const secondId = await soloTournamentWith(identity, 4);
    await start.start({ tournamentId: secondId, guildId: GUILD });

    const seedsOf = async (tournamentId: number): Promise<string[]> => {
      const rows = await pg.db
        .select()
        .from(tournamentEntrants)
        .where(eq(tournamentEntrants.tournamentId, tournamentId))
        .orderBy(asc(tournamentEntrants.seed));
      return rows.map((row) => row.captainUserId);
    };

    expect(await seedsOf(firstId)).toEqual(await seedsOf(secondId));
  });
});

describe('старт командного турнира', () => {
  async function teamTournament(identity: IdentityLookup, teamsCount: number, fillAll: boolean): Promise<number> {
    counter += 1;
    const { tournamentsService, teams } = servicesWith(identity);
    const { tournament } = await tournamentsService.create({
      guildId: GUILD,
      name: `Командный старт ${counter}`,
      game: 'lol',
      entryMode: 'team',
      teamSize: 2,
      maxEntrants: 8,
      seeding: 'rank',
      bestOf: 1,
      requireVerified: false,
      createdBy: PLAYERS[0] ?? 'x',
      announceChannelId: null,
      matchParentId: null,
    });
    await tournamentsService.open(tournament.id, GUILD);

    for (let index = 0; index < teamsCount; index += 1) {
      const captain = PLAYERS[index * 2] ?? 'x';
      const mate = PLAYERS[index * 2 + 1] ?? 'y';
      await teams.create({
        tournamentId: tournament.id,
        guildId: GUILD,
        captainUserId: captain,
        name: `Команда ${index + 1}`,
      });
      if (fillAll || index > 0) {
        await teams.invite({ tournamentId: tournament.id, guildId: GUILD, captainUserId: captain, userId: mate });
      }
    }
    return tournament.id;
  }

  it('сеет команды по среднему скору состава: 3624 выше 0', async () => {
    const strengths = new Map<string, number>();
    // Вторая команда сильнее: (3247 + 4000) / 2 = 3623.5 → 3624 против нулей у первой.
    strengths.set(PLAYERS[2] ?? '', 3247);
    strengths.set(PLAYERS[3] ?? '', 4000);
    const identity = identityStub(strengths);
    const { start } = servicesWith(identity);
    const tournamentId = await teamTournament(identity, 2, true);

    await start.start({ tournamentId, guildId: GUILD });

    const entrants = await pg.db
      .select()
      .from(tournamentEntrants)
      .where(eq(tournamentEntrants.tournamentId, tournamentId))
      .orderBy(asc(tournamentEntrants.seed));

    expect(entrants[0]?.displayName).toBe('Команда 2');
    expect(entrants[1]?.displayName).toBe('Команда 1');
  });

  it('отказывается стартовать при недобранных составах и называет их', async () => {
    const identity = identityStub();
    const { start } = servicesWith(identity);
    const tournamentId = await teamTournament(identity, 2, false);

    await expect(start.start({ tournamentId, guildId: GUILD })).rejects.toThrow(/Не готовы составы: Команда 1 \(1 из 2\)/);

    const [tournament] = await pg.db.select().from(tournaments).where(eq(tournaments.id, tournamentId));
    expect(tournament?.state).toBe('registration');
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm run test:int -- tests/integration/tournaments/start.test.ts`
Expected: FAIL — модуль `start.js` не найден.

- [ ] **Step 3: Реализовать `src/modules/tournaments/services/start.ts`**

```ts
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import { UserError } from '../../../core/errors.js';
import type { EventBus } from '../../../core/events/bus.js';
import type { Logger } from '../../../core/logger.js';
import { buildBracket } from '../bracket/build.js';
import { orderEntrants, type EntrantStrength } from '../bracket/seeding.js';
import type { IdentityLookup } from '../identity-port.js';
import {
  tournamentEntrantMembers,
  tournamentEntrants,
  tournamentMatchReports,
  tournamentMatches,
  tournaments,
} from '../schema.js';
import type { TeamsService } from './teams.js';
import type { TournamentRow, TournamentsService } from './tournaments.js';

export type MatchRow = typeof tournamentMatches.$inferSelect;

export interface StartResult {
  tournament: TournamentRow;
  size: number;
  rounds: number;
  entrants: number;
  matches: MatchRow[];
  /** Оба участника известны — можно играть. */
  readyMatches: MatchRow[];
  /** Закрыты пропуском: победитель уже проведён в следующий круг. */
  byeMatches: MatchRow[];
}

export interface StartService {
  start(input: { tournamentId: number; guildId: string }): Promise<StartResult>;
}

export function createStartService(deps: {
  db: Database;
  identity: IdentityLookup;
  teams: TeamsService;
  tournaments: TournamentsService;
  bus: EventBus;
  logger: Logger;
  /** Источник случайности для жеребьёвки 'random'. */
  random?: () => number;
}): StartService {
  const { db, identity, bus, logger } = deps;
  const random = deps.random ?? Math.random;

  return {
    async start(input): Promise<StartResult> {
      // ФАЗА 1. Всё чтение и вся арифметика — вне транзакции: считать силу внутри
      // значит держать блокировку турнира на N запросов к таблицам этапа 1.
      const tournament = await deps.tournaments.require(input.tournamentId, input.guildId);
      if (tournament.state !== 'registration') {
        throw new UserError(
          'Стартовать можно только турнир с открытой записью. Возможно, он уже идёт, ещё в черновике или отменён.',
        );
      }

      const entrants = await db
        .select()
        .from(tournamentEntrants)
        .where(and(eq(tournamentEntrants.tournamentId, tournament.id), isNull(tournamentEntrants.withdrawnAt)))
        .orderBy(asc(tournamentEntrants.id));

      if (entrants.length < 2) {
        throw new UserError('Для старта нужно хотя бы два участника.');
      }

      if (tournament.entryMode === 'team') {
        const incomplete = await deps.teams.incompleteTeams(tournament.id);
        if (incomplete.length > 0) {
          const list = incomplete
            .map((team) => `${team.displayName} (${team.players} из ${tournament.teamSize})`)
            .join(', ');
          throw new UserError(
            `Не готовы составы: ${list}. Пусть капитаны доберут игроков через \`/team invite\` или снимут команду через \`/team disband\`.`,
          );
        }
      }

      // Играющий состав: запасные в силе не участвуют — играют не они.
      const members = await db
        .select({ entrantId: tournamentEntrantMembers.entrantId, userId: tournamentEntrantMembers.userId })
        .from(tournamentEntrantMembers)
        .where(
          and(
            eq(tournamentEntrantMembers.tournamentId, tournament.id),
            inArray(tournamentEntrantMembers.role, ['captain', 'player']),
          ),
        );

      const rosters = new Map<number, string[]>();
      for (const member of members) {
        const roster = rosters.get(member.entrantId) ?? [];
        roster.push(member.userId);
        rosters.set(member.entrantId, roster);
      }

      const strengths: EntrantStrength[] = [];
      for (const entrant of entrants) {
        const roster = rosters.get(entrant.id) ?? [];
        if (tournament.seeding !== 'rank' || roster.length === 0) {
          strengths.push({ entrantId: entrant.id, strength: 0 });
          continue;
        }
        let sum = 0;
        for (const userId of roster) {
          sum += await identity.playerStrength(userId, tournament.game);
        }
        strengths.push({ entrantId: entrant.id, strength: Math.round(sum / roster.length) });
      }

      const seeded = orderEntrants(strengths, tournament.seeding, random);
      const plan = buildBracket(seeded);
      const plannedIds = seeded.map((entrant) => entrant.entrantId).sort((left, right) => left - right);

      // ФАЗА 2. Одна транзакция: состояние, сиды, матчи, журнал.
      const written = await db.transaction(async (tx) => {
        // Этот UPDATE и есть защита от двойного старта: второй одновременный вызов
        // получит ноль строк и откатится, ничего не построив.
        const [running] = await tx
          .update(tournaments)
          .set({ state: 'running', startedAt: new Date() })
          .where(
            and(
              eq(tournaments.id, tournament.id),
              eq(tournaments.guildId, input.guildId),
              eq(tournaments.state, 'registration'),
            ),
          )
          .returning();

        if (!running) {
          throw new UserError(
            'Стартовать можно только турнир с открытой записью. Возможно, он уже идёт, ещё в черновике или отменён.',
          );
        }

        const insideRows = await tx
          .select({ id: tournamentEntrants.id })
          .from(tournamentEntrants)
          .where(and(eq(tournamentEntrants.tournamentId, running.id), isNull(tournamentEntrants.withdrawnAt)))
          .orderBy(asc(tournamentEntrants.id));
        const insideIds = insideRows.map((row) => row.id);

        if (
          insideIds.length !== plannedIds.length ||
          insideIds.some((id, index) => id !== plannedIds[index])
        ) {
          // Состав изменился, пока считалась сила. Сетку по устаревшему составу
          // строить нельзя; откат вернёт и состояние турнира.
          throw new UserError('Состав участников изменился, пока шла жеребьёвка. Повтори `/tournament start`.');
        }

        for (const entrant of seeded) {
          await tx
            .update(tournamentEntrants)
            .set({ seed: entrant.seed })
            .where(eq(tournamentEntrants.id, entrant.entrantId));
        }

        const now = new Date();
        const inserted = await tx
          .insert(tournamentMatches)
          .values(
            plan.matches.map((match) => ({
              tournamentId: running.id,
              round: match.round,
              slot: match.slot,
              entrantAId: match.entrantAId,
              entrantBId: match.entrantBId,
              winnerEntrantId: match.winnerEntrantId,
              state: match.state,
              bestOf: running.bestOf,
              ...(match.state === 'walkover' ? { confirmedAt: now } : {}),
            })),
          )
          .returning();

        const byeReports = inserted
          .filter((match) => match.state === 'walkover' && match.winnerEntrantId !== null)
          .map((match) => ({
            matchId: match.id,
            tournamentId: running.id,
            kind: 'bye' as const,
            actorUserId: null,
            claimedWinnerId: match.winnerEntrantId,
          }));
        if (byeReports.length > 0) {
          await tx.insert(tournamentMatchReports).values(byeReports);
        }

        return { tournament: running, matches: inserted };
      });

      const readyMatches = written.matches.filter((match) => match.state === 'ready');
      const byeMatches = written.matches
        .filter((match) => match.state === 'walkover')
        .sort((left, right) => left.slot - right.slot);

      logger.info(
        { tournamentId: written.tournament.id, entrants: entrants.length, size: plan.size, byes: byeMatches.length },
        'сетка турнира построена',
      );

      // События — только после коммита. Ветки под матчи создаст подписчик match.ready:
      // вызовов Discord внутри транзакции быть не должно.
      await bus.emit('tournament.started', {
        tournamentId: written.tournament.id,
        guildId: written.tournament.guildId,
        entrants: entrants.length,
      });
      for (const match of readyMatches) {
        await bus.emit('match.ready', {
          tournamentId: written.tournament.id,
          matchId: match.id,
          round: match.round,
        });
      }

      return {
        tournament: written.tournament,
        size: plan.size,
        rounds: plan.rounds,
        entrants: entrants.length,
        matches: written.matches,
        readyMatches,
        byeMatches,
      };
    },
  };
}
```

- [ ] **Step 4: Прогнать тест**

Run: `npm run test:int -- tests/integration/tournaments/start.test.ts && npm run typecheck`
Expected: 12 тестов PASS (10 в блоке «старт соло-турнира», 2 в блоке «старт командного турнира»), тайпчек чистый.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/tournaments/services/start.ts tests/integration/tournaments/start.test.ts
git commit -m "feat(tournaments): старт турнира с жеребьёвкой и построением сетки в одной транзакции"
```

---

### Task 10: Репорт, подтверждение и идемпотентное продвижение

**Files:**
- Create: `src/modules/tournaments/services/matches.ts`
- Test: `tests/integration/tournaments/matches-report.test.ts`

**Interfaces:**
- Consumes: `Database`, `EventBus`, `Logger`, `UserError`, `BugError`; схема (Task 1); `nextSlot` (Task 4).
- Produces:
  - `type MatchRow = typeof tournamentMatches.$inferSelect`
  - `interface MatchSides { match: MatchRow; aUserIds: string[]; bUserIds: string[] }`
  - `function sideOf(sides: MatchSides, userId: string): 'a' | 'b' | null`
  - `interface SettleOutcome { changed: boolean; match: MatchRow; nextReady: MatchRow | null; championEntrantId: number | null }`
  - `interface MatchesService { byIdInGuild(matchId: number, guildId: string): Promise<MatchRow>; matchesFor(tournamentId: number, userId: string, states: readonly MatchState[]): Promise<MatchRow[]>; sidesOf(matchId: number): Promise<MatchSides>; membersOf(entrantId: number): Promise<string[]>; report(input: { matchId: number; userId: string; winnerEntrantId: number }): Promise<MatchRow>; confirm(input: { matchId: number; userId: string }): Promise<SettleOutcome> }` — Task 11 дополняет этот же интерфейс методами `dispute`, `resolve`, `walkover`, `autoConfirmDue`.
  - `function createMatchesService(deps: { db: Database; bus: EventBus; logger: Logger }): MatchesService`

**Почему продвижение идемпотентно и почему этого достаточно.**

Закрытие матча — один `UPDATE ... WHERE id = ? AND state IN (…) RETURNING *`. Два одновременных подтверждения (двойное нажатие кнопки, повторная доставка интеракции, гонка джобы автоподтверждения с ручным подтверждением) ведут себя так: второй `UPDATE` блокируется на строке, а после коммита первого Postgres на уровне изоляции READ COMMITTED **перечитывает условие `WHERE` на новой версии строки**. Состояние уже `confirmed`, условие не выполняется, обновлено ноль строк — `changed: false`, и продвижение не выполняется второй раз. Прочитать состояние, проверить его в JS и потом записать было бы ровно тем, чего делать нельзя.

Продвижение победителя в следующий круг тоже условное: `SET entrant_a_id = ? WHERE id = ? AND entrant_a_id IS NULL`. Даже если продвижение когда-нибудь выполнится дважды, второй раз оно ничего не перезапишет. Сторона (`a`/`b`) вычисляется по чётности слота, и у слотов `2k` и `2k+1` она разная — один и тот же слот не могут занять два победителя.

Завершение турнира — тот же приём: `SET state = 'finished' WHERE state = 'running'`. `championEntrantId` заполняется только если эта строка реально обновилась, поэтому `tournament.finished` не публикуется дважды.

Все события публикуются **после** коммита транзакции, а не внутри неё.

- [ ] **Step 1: Написать падающий тест**

Файл `tests/integration/tournaments/matches-report.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { EventBus } from '../../../src/core/events/bus.js';
import type { BotEvents } from '../../../src/core/events/events.js';
import { createLogger } from '../../../src/core/logger.js';
import { tournamentMatchReports, tournamentMatches, tournaments } from '../../../src/modules/tournaments/schema.js';
import { createMatchesService } from '../../../src/modules/tournaments/services/matches.js';
import { createTeamsService } from '../../../src/modules/tournaments/services/teams.js';
import { createTournamentsService } from '../../../src/modules/tournaments/services/tournaments.js';
import type { IdentityLookup } from '../../../src/modules/tournaments/identity-port.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

const GUILD = '110000000000000001';
/** По двое на команду: подтверждение проверяется по составу, а не по человеку. */
const USERS = Array.from({ length: 8 }, (_unused, index) => `1110000000000000${String(index + 10)}`);

const identity: IdentityLookup = {
  link: async () => null,
  playerStrength: async () => 0,
};

interface Fixture {
  tournamentId: number;
  teamA: number;
  teamB: number;
  teamC: number;
  teamD: number;
  firstMatchId: number;
  secondMatchId: number;
  finalMatchId: number;
}

let counter = 0;

function services() {
  const bus = new EventBus(logger);
  const tournamentsService = createTournamentsService({ db: pg.db, bus });
  const teams = createTeamsService({ db: pg.db, identity, tournaments: tournamentsService });
  const matches = createMatchesService({ db: pg.db, bus, logger });
  return { bus, tournamentsService, teams, matches };
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} отсутствует`);
  return value;
}

/**
 * Турнир на четыре команды по два человека, уже в состоянии running, с сеткой из
 * трёх матчей: два в первом круге и финал. Матчи вставляются напрямую — эта задача
 * проверяет репорт и подтверждение, а не построение сетки (оно проверено в Task 9).
 */
async function runningTournament(): Promise<Fixture> {
  counter += 1;
  const { tournamentsService, teams } = services();
  const { tournament } = await tournamentsService.create({
    guildId: GUILD,
    name: `Матчи ${counter}`,
    game: 'lol',
    entryMode: 'team',
    teamSize: 2,
    maxEntrants: 4,
    seeding: 'random',
    bestOf: 1,
    requireVerified: false,
    createdBy: required(USERS[0], 'первый игрок'),
    announceChannelId: null,
    matchParentId: null,
  });
  await tournamentsService.open(tournament.id, GUILD);

  const entrantIds: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const captain = required(USERS[index * 2], 'капитан');
    const mate = required(USERS[index * 2 + 1], 'напарник');
    const entrant = await teams.create({
      tournamentId: tournament.id,
      guildId: GUILD,
      captainUserId: captain,
      name: `Команда ${index + 1}`,
    });
    await teams.invite({ tournamentId: tournament.id, guildId: GUILD, captainUserId: captain, userId: mate });
    entrantIds.push(entrant.id);
  }

  await pg.db
    .update(tournaments)
    .set({ state: 'running', startedAt: new Date() })
    .where(eq(tournaments.id, tournament.id));

  const teamA = required(entrantIds[0], 'команда A');
  const teamB = required(entrantIds[1], 'команда B');
  const teamC = required(entrantIds[2], 'команда C');
  const teamD = required(entrantIds[3], 'команда D');

  const inserted = await pg.db
    .insert(tournamentMatches)
    .values([
      { tournamentId: tournament.id, round: 1, slot: 0, entrantAId: teamA, entrantBId: teamB, state: 'ready' },
      { tournamentId: tournament.id, round: 1, slot: 1, entrantAId: teamC, entrantBId: teamD, state: 'ready' },
      { tournamentId: tournament.id, round: 2, slot: 0, state: 'pending' },
    ])
    .returning();

  const bySlot = (round: number, slot: number): number =>
    required(
      inserted.find((match) => match.round === round && match.slot === slot),
      `матч ${round}/${slot}`,
    ).id;

  return {
    tournamentId: tournament.id,
    teamA,
    teamB,
    teamC,
    teamD,
    firstMatchId: bySlot(1, 0),
    secondMatchId: bySlot(1, 1),
    finalMatchId: bySlot(2, 0),
  };
}

/** Капитан команды с индексом index (0..3). */
const captainOf = (index: number): string => required(USERS[index * 2], 'капитан');
/** Напарник капитана: тот же состав, другой человек. */
const mateOf = (index: number): string => required(USERS[index * 2 + 1], 'напарник');

beforeEach(async () => {
  const { tournamentsService } = services();
  await tournamentsService.ensureGuild(GUILD);
  for (const userId of USERS) await tournamentsService.ensureUser(userId);
});

describe('report', () => {
  it('записывает заявленного победителя и автора заявки', async () => {
    const fixture = await runningTournament();
    const { matches } = services();

    const match = await matches.report({
      matchId: fixture.firstMatchId,
      userId: captainOf(0),
      winnerEntrantId: fixture.teamA,
    });

    expect(match.state).toBe('reported');
    expect(match.reportedBy).toBe(captainOf(0));
    expect(match.winnerEntrantId).toBe(fixture.teamA);
    expect(match.reportedAt).toBeInstanceOf(Date);
  });

  it('пишет заявку в журнал репортов', async () => {
    const fixture = await runningTournament();
    const { matches } = services();

    await matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });

    const reports = await pg.db
      .select()
      .from(tournamentMatchReports)
      .where(eq(tournamentMatchReports.matchId, fixture.firstMatchId));

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ kind: 'report', actorUserId: captainOf(0), isAdmin: false });
  });

  it('не даёт заявить результат тому, кто в матче не играет', async () => {
    const fixture = await runningTournament();
    const { matches } = services();

    await expect(
      matches.report({ matchId: fixture.firstMatchId, userId: captainOf(2), winnerEntrantId: fixture.teamA }),
    ).rejects.toThrow(/не играешь в этом матче/);
  });

  it('не даёт назвать победителем участника из другого матча', async () => {
    const fixture = await runningTournament();
    const { matches } = services();

    await expect(
      matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamC }),
    ).rejects.toThrow(/одного из двух участников этого матча/);
  });

  it('не даёт заявить результат матча, соперник в котором ещё не известен', async () => {
    const fixture = await runningTournament();
    const { matches } = services();

    await expect(
      matches.report({ matchId: fixture.finalMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA }),
    ).rejects.toThrow(/Соперник ещё не известен/);
  });

  it('не принимает вторую заявку по тому же матчу', async () => {
    const fixture = await runningTournament();
    const { matches } = services();
    await matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });

    await expect(
      matches.report({ matchId: fixture.firstMatchId, userId: captainOf(1), winnerEntrantId: fixture.teamB }),
    ).rejects.toThrow(/уже заявлен/);
  });
});

describe('confirm', () => {
  it('продвигает победителя чётного слота в сторону a следующего круга', async () => {
    const fixture = await runningTournament();
    const { matches } = services();
    await matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });

    const outcome = await matches.confirm({ matchId: fixture.firstMatchId, userId: captainOf(1) });

    expect(outcome.changed).toBe(true);
    expect(outcome.match.state).toBe('confirmed');
    const [final] = await pg.db.select().from(tournamentMatches).where(eq(tournamentMatches.id, fixture.finalMatchId));
    expect(final?.entrantAId).toBe(fixture.teamA);
    expect(final?.entrantBId).toBeNull();
    expect(final?.state).toBe('pending');
  });

  it('продвигает победителя нечётного слота в сторону b следующего круга', async () => {
    const fixture = await runningTournament();
    const { matches } = services();
    await matches.report({ matchId: fixture.secondMatchId, userId: captainOf(2), winnerEntrantId: fixture.teamC });

    await matches.confirm({ matchId: fixture.secondMatchId, userId: captainOf(3) });

    const [final] = await pg.db.select().from(tournamentMatches).where(eq(tournamentMatches.id, fixture.finalMatchId));
    expect(final?.entrantBId).toBe(fixture.teamC);
    expect(final?.entrantAId).toBeNull();
  });

  it('делает следующий матч готовым, когда пришли оба победителя, и публикует match.ready', async () => {
    const fixture = await runningTournament();
    const { matches, bus } = services();
    const ready: Array<BotEvents['match.ready']> = [];
    bus.on('match.ready', (payload) => {
      ready.push(payload);
    });

    await matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });
    await matches.confirm({ matchId: fixture.firstMatchId, userId: captainOf(1) });
    await matches.report({ matchId: fixture.secondMatchId, userId: captainOf(2), winnerEntrantId: fixture.teamC });
    const outcome = await matches.confirm({ matchId: fixture.secondMatchId, userId: captainOf(3) });

    expect(outcome.nextReady?.id).toBe(fixture.finalMatchId);
    expect(ready).toEqual([{ tournamentId: fixture.tournamentId, matchId: fixture.finalMatchId, round: 2 }]);
  });

  it('двойное подтверждение не продвигает дважды и оставляет одну запись в журнале', async () => {
    const fixture = await runningTournament();
    const { matches, bus } = services();
    const confirmed: Array<BotEvents['match.confirmed']> = [];
    bus.on('match.confirmed', (payload) => {
      confirmed.push(payload);
    });
    await matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });

    const first = await matches.confirm({ matchId: fixture.firstMatchId, userId: captainOf(1) });
    const second = await matches.confirm({ matchId: fixture.firstMatchId, userId: captainOf(1) });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(confirmed).toHaveLength(1);

    const confirmReports = (
      await pg.db
        .select()
        .from(tournamentMatchReports)
        .where(eq(tournamentMatchReports.matchId, fixture.firstMatchId))
    ).filter((report) => report.kind === 'confirm');
    expect(confirmReports).toHaveLength(1);

    // Финал не должен получить победителя дважды: сторона b всё ещё пуста.
    const [final] = await pg.db.select().from(tournamentMatches).where(eq(tournamentMatches.id, fixture.finalMatchId));
    expect(final?.entrantAId).toBe(fixture.teamA);
    expect(final?.entrantBId).toBeNull();
  });

  it('два одновременных подтверждения дают ровно одно продвижение', async () => {
    const fixture = await runningTournament();
    const { matches } = services();
    await matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });

    // Настоящая гонка, а не два последовательных вызова: ранний выход по state в
    // confirm здесь не сработает — оба вызова прочитают матч как 'reported' и оба
    // войдут в settle. Разрешить её обязан условный UPDATE, а не порядок вызовов.
    const outcomes = await Promise.all([
      matches.confirm({ matchId: fixture.firstMatchId, userId: captainOf(1) }),
      matches.confirm({ matchId: fixture.firstMatchId, userId: mateOf(1) }),
    ]);

    expect(outcomes.filter((outcome) => outcome.changed)).toHaveLength(1);
    const confirmReports = (
      await pg.db
        .select()
        .from(tournamentMatchReports)
        .where(eq(tournamentMatchReports.matchId, fixture.firstMatchId))
    ).filter((report) => report.kind === 'confirm');
    expect(confirmReports).toHaveLength(1);
  });

  it('не даёт подтвердить результат своему же составу — ни автору заявки, ни его напарнику', async () => {
    const fixture = await runningTournament();
    const { matches } = services();
    await matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });

    await expect(matches.confirm({ matchId: fixture.firstMatchId, userId: captainOf(0) })).rejects.toThrow(
      /из состава соперника/,
    );
    await expect(matches.confirm({ matchId: fixture.firstMatchId, userId: mateOf(0) })).rejects.toThrow(
      /из состава соперника/,
    );
  });

  it('позволяет подтвердить любому игроку состава соперника, а не только капитану', async () => {
    const fixture = await runningTournament();
    const { matches } = services();
    await matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });

    const outcome = await matches.confirm({ matchId: fixture.firstMatchId, userId: mateOf(1) });

    expect(outcome.changed).toBe(true);
  });

  it('не даёт подтвердить тому, кто в матче не играет', async () => {
    const fixture = await runningTournament();
    const { matches } = services();
    await matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });

    await expect(matches.confirm({ matchId: fixture.firstMatchId, userId: captainOf(3) })).rejects.toThrow(
      /не играешь в этом матче/,
    );
  });

  it('отказывается подтверждать матч, по которому заявки не было', async () => {
    const fixture = await runningTournament();
    const { matches } = services();

    await expect(matches.confirm({ matchId: fixture.firstMatchId, userId: captainOf(1) })).rejects.toThrow(
      /результат ещё не заявлен/i,
    );
  });

  it('завершает турнир на подтверждении финала и публикует tournament.finished с игроками победителя', async () => {
    const fixture = await runningTournament();
    const { matches, bus } = services();
    const finished: Array<BotEvents['tournament.finished']> = [];
    bus.on('tournament.finished', (payload) => {
      finished.push(payload);
    });

    await matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });
    await matches.confirm({ matchId: fixture.firstMatchId, userId: captainOf(1) });
    await matches.report({ matchId: fixture.secondMatchId, userId: captainOf(2), winnerEntrantId: fixture.teamC });
    await matches.confirm({ matchId: fixture.secondMatchId, userId: captainOf(3) });

    await matches.report({ matchId: fixture.finalMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });
    const outcome = await matches.confirm({ matchId: fixture.finalMatchId, userId: captainOf(2) });

    expect(outcome.championEntrantId).toBe(fixture.teamA);
    expect(outcome.nextReady).toBeNull();
    const [tournament] = await pg.db.select().from(tournaments).where(eq(tournaments.id, fixture.tournamentId));
    expect(tournament?.state).toBe('finished');
    expect(tournament?.finishedAt).toBeInstanceOf(Date);
    expect(finished).toHaveLength(1);
    expect(finished[0]?.winnerEntrantId).toBe(fixture.teamA);
    expect(finished[0]?.winnerUserIds.sort()).toEqual([captainOf(0), mateOf(0)].sort());
  });

  it('повторное подтверждение финала не публикует завершение второй раз', async () => {
    const fixture = await runningTournament();
    const { matches, bus } = services();
    const finished: Array<BotEvents['tournament.finished']> = [];
    bus.on('tournament.finished', (payload) => {
      finished.push(payload);
    });

    await matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });
    await matches.confirm({ matchId: fixture.firstMatchId, userId: captainOf(1) });
    await matches.report({ matchId: fixture.secondMatchId, userId: captainOf(2), winnerEntrantId: fixture.teamC });
    await matches.confirm({ matchId: fixture.secondMatchId, userId: captainOf(3) });
    await matches.report({ matchId: fixture.finalMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });
    await matches.confirm({ matchId: fixture.finalMatchId, userId: captainOf(2) });

    const again = await matches.confirm({ matchId: fixture.finalMatchId, userId: captainOf(2) });

    expect(again.changed).toBe(false);
    expect(again.championEntrantId).toBeNull();
    expect(finished).toHaveLength(1);
  });
});

describe('matchesFor и sidesOf', () => {
  it('находит готовые матчи участника по составу', async () => {
    const fixture = await runningTournament();
    const { matches } = services();

    const mine = await matches.matchesFor(fixture.tournamentId, mateOf(0), ['ready']);
    const foreign = await matches.matchesFor(fixture.tournamentId, mateOf(2), ['ready']);

    expect(mine.map((match) => match.id)).toEqual([fixture.firstMatchId]);
    expect(foreign.map((match) => match.id)).toEqual([fixture.secondMatchId]);
  });

  it('отдаёт составы обеих сторон и пустой список для неизвестного участника', async () => {
    const fixture = await runningTournament();
    const { matches } = services();

    const sides = await matches.sidesOf(fixture.firstMatchId);
    const emptyFinal = await matches.sidesOf(fixture.finalMatchId);

    expect(sides.aUserIds.sort()).toEqual([captainOf(0), mateOf(0)].sort());
    expect(sides.bUserIds.sort()).toEqual([captainOf(1), mateOf(1)].sort());
    expect(emptyFinal.aUserIds).toEqual([]);
    expect(emptyFinal.bUserIds).toEqual([]);
  });

  it('не отдаёт матч чужого сервера', async () => {
    const fixture = await runningTournament();
    const { matches } = services();

    await expect(matches.byIdInGuild(fixture.firstMatchId, '119999999999999999')).rejects.toThrow(
      /не найден на этом сервере/,
    );
    expect((await matches.byIdInGuild(fixture.firstMatchId, GUILD)).id).toBe(fixture.firstMatchId);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm run test:int -- tests/integration/tournaments/matches-report.test.ts`
Expected: FAIL — модуль `matches.js` не найден.

- [ ] **Step 3: Реализовать `src/modules/tournaments/services/matches.ts`**

```ts
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import { BugError, UserError } from '../../../core/errors.js';
import type { EventBus } from '../../../core/events/bus.js';
import type { Logger } from '../../../core/logger.js';
import { nextSlot } from '../bracket/advance.js';
import {
  tournamentEntrantMembers,
  tournamentMatchReports,
  tournamentMatches,
  tournaments,
  type MatchState,
} from '../schema.js';

export type MatchRow = typeof tournamentMatches.$inferSelect;

/**
 * Тип аргумента коллбэка db.transaction, выведенный из самого Database, чтобы не
 * импортировать внутренние типы drizzle. Если это выражение когда-нибудь перестанет
 * выводиться, замена — прямой импорт PgTransaction из 'drizzle-orm/pg-core'.
 */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface MatchSides {
  match: MatchRow;
  aUserIds: string[];
  bUserIds: string[];
}

/**
 * Сторона матча, за которую играет человек. Проверка идёт по составу, а не по тому,
 * кто нажал кнопку: иначе напарник заявившего мог бы подтвердить результат сам.
 */
export function sideOf(sides: MatchSides, userId: string): 'a' | 'b' | null {
  if (sides.aUserIds.includes(userId)) return 'a';
  if (sides.bUserIds.includes(userId)) return 'b';
  return null;
}

export interface SettleOutcome {
  /** false — матч уже был закрыт раньше: продвижение НЕ выполнялось повторно. */
  changed: boolean;
  match: MatchRow;
  /** Матч следующего круга, ставший готовым прямо сейчас. */
  nextReady: MatchRow | null;
  /** Заполнено только если этим вызовом турнир стал finished. */
  championEntrantId: number | null;
}

export interface MatchesService {
  byIdInGuild(matchId: number, guildId: string): Promise<MatchRow>;
  matchesFor(tournamentId: number, userId: string, states: readonly MatchState[]): Promise<MatchRow[]>;
  sidesOf(matchId: number): Promise<MatchSides>;
  membersOf(entrantId: number): Promise<string[]>;
  report(input: { matchId: number; userId: string; winnerEntrantId: number }): Promise<MatchRow>;
  confirm(input: { matchId: number; userId: string }): Promise<SettleOutcome>;
}

function explainNotReportable(match: MatchRow): string {
  switch (match.state) {
    case 'pending':
      return 'Соперник ещё не известен: дождись, пока определится победитель предыдущего круга.';
    case 'reported':
      return 'Результат этого матча уже заявлен — соперник должен подтвердить его или оспорить.';
    case 'disputed':
      return 'Матч спорный: результат назначит организатор через `/match resolve`.';
    case 'confirmed':
    case 'walkover':
      return 'Результат этого матча уже окончательный.';
    default:
      return 'Этот матч сейчас нельзя заявить.';
  }
}

function explainNotConfirmable(match: MatchRow): string {
  switch (match.state) {
    case 'pending':
      return 'Соперник ещё не известен — подтверждать нечего.';
    case 'ready':
      return 'Результат ещё не заявлен: сперва кто-то из участников вызывает `/match report`.';
    case 'disputed':
      return 'Матч спорный: результат назначит организатор через `/match resolve`.';
    default:
      return 'Этот матч сейчас нельзя подтвердить.';
  }
}

export function createMatchesService(deps: { db: Database; bus: EventBus; logger: Logger }): MatchesService {
  const { db, bus, logger } = deps;

  async function byId(matchId: number): Promise<MatchRow> {
    const [row] = await db.select().from(tournamentMatches).where(eq(tournamentMatches.id, matchId));
    if (!row) throw new UserError('Матч не найден.');
    return row;
  }

  async function membersOf(entrantId: number): Promise<string[]> {
    const rows = await db
      .select({ userId: tournamentEntrantMembers.userId })
      .from(tournamentEntrantMembers)
      .where(eq(tournamentEntrantMembers.entrantId, entrantId));
    return rows.map((row) => row.userId);
  }

  async function sidesOf(matchId: number): Promise<MatchSides> {
    const match = await byId(matchId);
    const aUserIds = match.entrantAId === null ? [] : await membersOf(match.entrantAId);
    const bUserIds = match.entrantBId === null ? [] : await membersOf(match.entrantBId);
    return { match, aUserIds, bUserIds };
  }

  /**
   * Закрывает матч и продвигает победителя. Единственная точка продвижения:
   * подтверждение, автоподтверждение, решение администратора и walkover ходят сюда.
   */
  async function settle(
    tx: Tx,
    params: {
      matchId: number;
      fromStates: readonly MatchState[];
      toState: 'confirmed' | 'walkover';
      at: Date;
      /** Задаётся решением администратора и walkover; иначе берётся заявленный победитель. */
      winnerEntrantId?: number;
    },
  ): Promise<SettleOutcome> {
    const [updated] = await tx
      .update(tournamentMatches)
      .set({
        state: params.toState,
        confirmedAt: params.at,
        ...(params.winnerEntrantId === undefined ? {} : { winnerEntrantId: params.winnerEntrantId }),
      })
      .where(
        and(eq(tournamentMatches.id, params.matchId), inArray(tournamentMatches.state, [...params.fromStates])),
      )
      .returning();

    if (!updated) {
      // Кто-то успел раньше: второе нажатие кнопки, повторная доставка интеракции или
      // джоба автоподтверждения. READ COMMITTED перечитывает условие WHERE на новой
      // версии строки после снятия блокировки, поэтому «оба увидели reported»
      // невозможно, и продвижение здесь не повторяется.
      const [current] = await tx.select().from(tournamentMatches).where(eq(tournamentMatches.id, params.matchId));
      if (!current) throw new UserError('Матч не найден.');
      return { changed: false, match: current, nextReady: null, championEntrantId: null };
    }

    const winnerEntrantId = updated.winnerEntrantId;
    if (winnerEntrantId === null) {
      throw new BugError(`матч ${updated.id} закрыт без победителя`);
    }

    const target = nextSlot(updated.round, updated.slot);
    const [nextMatch] = await tx
      .select()
      .from(tournamentMatches)
      .where(
        and(
          eq(tournamentMatches.tournamentId, updated.tournamentId),
          eq(tournamentMatches.round, target.round),
          eq(tournamentMatches.slot, target.slot),
        ),
      );

    if (!nextMatch) {
      // Следующего круга нет — закрыт финал. Условие по 'running' делает завершение
      // однократным: повторный вызов не обновит ничего и не даст championEntrantId.
      const [finished] = await tx
        .update(tournaments)
        .set({ state: 'finished', finishedAt: params.at })
        .where(and(eq(tournaments.id, updated.tournamentId), eq(tournaments.state, 'running')))
        .returning();

      return {
        changed: true,
        match: updated,
        nextReady: null,
        championEntrantId: finished ? winnerEntrantId : null,
      };
    }

    const [advanced] = await tx
      .update(tournamentMatches)
      .set(target.side === 'a' ? { entrantAId: winnerEntrantId } : { entrantBId: winnerEntrantId })
      .where(
        and(
          eq(tournamentMatches.id, nextMatch.id),
          // Идемпотентность продвижения: занятую сторону второй раз не перезаписываем.
          target.side === 'a' ? isNull(tournamentMatches.entrantAId) : isNull(tournamentMatches.entrantBId),
        ),
      )
      .returning();

    const filled = advanced ?? nextMatch;
    let nextReady: MatchRow | null = null;
    if (filled.entrantAId !== null && filled.entrantBId !== null) {
      const [ready] = await tx
        .update(tournamentMatches)
        .set({ state: 'ready' })
        .where(and(eq(tournamentMatches.id, filled.id), eq(tournamentMatches.state, 'pending')))
        .returning();
      nextReady = ready ?? null;
    }

    return { changed: true, match: updated, nextReady, championEntrantId: null };
  }

  /** Публикация событий — только после коммита. */
  async function publish(outcome: SettleOutcome): Promise<void> {
    if (!outcome.changed) return;

    const winnerEntrantId = outcome.match.winnerEntrantId;
    if (winnerEntrantId !== null) {
      await bus.emit('match.confirmed', {
        tournamentId: outcome.match.tournamentId,
        matchId: outcome.match.id,
        winnerEntrantId,
      });
    }

    if (outcome.nextReady) {
      await bus.emit('match.ready', {
        tournamentId: outcome.nextReady.tournamentId,
        matchId: outcome.nextReady.id,
        round: outcome.nextReady.round,
      });
    }

    if (outcome.championEntrantId !== null) {
      const [tournament] = await db
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, outcome.match.tournamentId));
      if (!tournament) {
        logger.error({ matchId: outcome.match.id }, 'турнир победившего матча не найден');
        return;
      }
      await bus.emit('tournament.finished', {
        tournamentId: tournament.id,
        guildId: tournament.guildId,
        winnerEntrantId: outcome.championEntrantId,
        winnerUserIds: await membersOf(outcome.championEntrantId),
      });
    }
  }

  return {
    membersOf,
    sidesOf,

    async byIdInGuild(matchId, guildId): Promise<MatchRow> {
      const [row] = await db
        .select({ match: tournamentMatches })
        .from(tournamentMatches)
        .innerJoin(tournaments, eq(tournamentMatches.tournamentId, tournaments.id))
        .where(and(eq(tournamentMatches.id, matchId), eq(tournaments.guildId, guildId)));

      if (!row) throw new UserError('Матч не найден на этом сервере.');
      return row.match;
    },

    async matchesFor(tournamentId, userId, states): Promise<MatchRow[]> {
      const [membership] = await db
        .select({ entrantId: tournamentEntrantMembers.entrantId })
        .from(tournamentEntrantMembers)
        .where(
          and(
            eq(tournamentEntrantMembers.tournamentId, tournamentId),
            eq(tournamentEntrantMembers.userId, userId),
          ),
        );
      if (!membership) return [];

      return db
        .select()
        .from(tournamentMatches)
        .where(
          and(
            eq(tournamentMatches.tournamentId, tournamentId),
            inArray(tournamentMatches.state, [...states]),
            or(
              eq(tournamentMatches.entrantAId, membership.entrantId),
              eq(tournamentMatches.entrantBId, membership.entrantId),
            ),
          ),
        )
        .orderBy(asc(tournamentMatches.round), asc(tournamentMatches.slot));
    },

    async report(input): Promise<MatchRow> {
      const sides = await sidesOf(input.matchId);
      const match = sides.match;

      if (match.state !== 'ready') throw new UserError(explainNotReportable(match));
      if (input.winnerEntrantId !== match.entrantAId && input.winnerEntrantId !== match.entrantBId) {
        throw new UserError('Победителем можно назвать только одного из двух участников этого матча.');
      }
      if (sideOf(sides, input.userId) === null) {
        throw new UserError('Ты не играешь в этом матче.');
      }

      const [updated] = await db
        .update(tournamentMatches)
        .set({
          state: 'reported',
          reportedBy: input.userId,
          reportedAt: new Date(),
          // До подтверждения это заявленный победитель; окончательным его делает
          // смена состояния, поэтому подтверждающему не нужно называть его заново.
          winnerEntrantId: input.winnerEntrantId,
        })
        .where(and(eq(tournamentMatches.id, match.id), eq(tournamentMatches.state, 'ready')))
        .returning();

      if (!updated) throw new UserError(explainNotReportable(await byId(match.id)));

      await db.insert(tournamentMatchReports).values({
        matchId: updated.id,
        tournamentId: updated.tournamentId,
        kind: 'report',
        actorUserId: input.userId,
        claimedWinnerId: input.winnerEntrantId,
      });

      return updated;
    },

    async confirm(input): Promise<SettleOutcome> {
      const sides = await sidesOf(input.matchId);
      const match = sides.match;

      if (match.state === 'confirmed' || match.state === 'walkover') {
        // Второе нажатие кнопки — не ошибка, а «уже сделано».
        return { changed: false, match, nextReady: null, championEntrantId: null };
      }
      if (match.state !== 'reported') throw new UserError(explainNotConfirmable(match));

      const reportedBy = match.reportedBy;
      if (reportedBy === null) throw new BugError(`матч ${match.id} заявлен без reported_by`);

      const confirmerSide = sideOf(sides, input.userId);
      if (confirmerSide === null) throw new UserError('Ты не играешь в этом матче.');

      const reporterSide = sideOf(sides, reportedBy);
      if (reporterSide === null) {
        throw new UserError(
          'Не удалось определить, кто заявил результат: этого игрока больше нет в составе. Попроси организатора решить матч через `/match resolve`.',
        );
      }
      if (reporterSide === confirmerSide) {
        throw new UserError(
          'Подтвердить результат должен кто-то из состава соперника: один и тот же состав не может и заявить, и подтвердить.',
        );
      }

      const at = new Date();
      const outcome = await db.transaction(async (tx) => {
        const settled = await settle(tx, {
          matchId: match.id,
          fromStates: ['reported'],
          toState: 'confirmed',
          at,
        });
        if (settled.changed) {
          await tx.insert(tournamentMatchReports).values({
            matchId: match.id,
            tournamentId: match.tournamentId,
            kind: 'confirm',
            actorUserId: input.userId,
            claimedWinnerId: settled.match.winnerEntrantId,
          });
        }
        return settled;
      });

      await publish(outcome);
      return outcome;
    },
  };
}
```

Внутренняя функция `settle` объявлена как `async function settle(tx, params)` внутри `createMatchesService`, поэтому Task 11 добавляет к ней вызовы, ничего не переписывая.

- [ ] **Step 4: Прогнать тест**

Run: `npm run test:int -- tests/integration/tournaments/matches-report.test.ts && npm run typecheck`
Expected: 20 тестов PASS (6 в блоке «report», 11 в блоке «confirm», 3 в блоке «matchesFor и sidesOf»), тайпчек чистый.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/tournaments/services/matches.ts tests/integration/tournaments/matches-report.test.ts
git commit -m "feat(tournaments): репорт результата и идемпотентное подтверждение с продвижением по сетке"
```

---

### Task 11: Спор, решение администратора, неявка и автоподтверждение

**Files:**
- Modify: `src/modules/tournaments/services/matches.ts` — добавить `dispute`, `resolve`, `walkover`, `autoConfirmDue` и константу окна
- Test: `tests/integration/tournaments/matches-resolve.test.ts`

**Interfaces:**
- Consumes: всё из Task 10, включая внутренние `settle`, `publish`, `sidesOf`, `sideOf`, `byId`, `explainNotReportable`.
- Produces (дополнение к `MatchesService`):
  - `const AUTO_CONFIRM_AFTER_MS = 60 * 60 * 1_000`
  - `dispute(input: { matchId: number; userId: string; reason: string | null }): Promise<MatchRow>`
  - `resolve(input: { matchId: number; guildId: string; adminUserId: string; side: 'a' | 'b' }): Promise<SettleOutcome>`
  - `walkover(input: { matchId: number; guildId: string; adminUserId: string; side: 'a' | 'b' }): Promise<SettleOutcome>`
  - `autoConfirmDue(now: Date, limit: number): Promise<SettleOutcome[]>`

**Почему автоподтверждение — выборка по времени, а не таймер.** `setTimeout` на 60 минут не переживает перезапуск процесса, а перезапуск бывает при каждом деплое. Поэтому окно проверяется джобой: `state = 'reported' AND reported_at <= now - 60 минут`. Спорный матч в эту выборку не попадает по определению (у него состояние `disputed`), поэтому бот не может разрешить спор сам ни при каких условиях — и это проверяется тестом, а не читается из комментария.

Победитель у `resolve` и `walkover` задаётся **стороной** (`a`/`b`), а не номером участника: организатор видит матч в `/bracket` как «слева — справа», и заставлять его переписывать внутренний номер участника значит гарантированно получить опечатку.

- [ ] **Step 1: Написать падающий тест**

Файл `tests/integration/tournaments/matches-resolve.test.ts`. Фикстура повторена целиком — исполнитель этой задачи не видит текста Task 10.

```ts
import { asc, eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { EventBus } from '../../../src/core/events/bus.js';
import type { BotEvents } from '../../../src/core/events/events.js';
import { createLogger } from '../../../src/core/logger.js';
import type { IdentityLookup } from '../../../src/modules/tournaments/identity-port.js';
import { tournamentMatchReports, tournamentMatches, tournaments } from '../../../src/modules/tournaments/schema.js';
import { createMatchesService } from '../../../src/modules/tournaments/services/matches.js';
import { createTeamsService } from '../../../src/modules/tournaments/services/teams.js';
import { createTournamentsService } from '../../../src/modules/tournaments/services/tournaments.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

const GUILD = '120000000000000001';
const ADMIN = '129999999999999999';
const USERS = Array.from({ length: 8 }, (_unused, index) => `1210000000000000${String(index + 10)}`);

const identity: IdentityLookup = {
  link: async () => null,
  playerStrength: async () => 0,
};

function services() {
  const bus = new EventBus(logger);
  const tournamentsService = createTournamentsService({ db: pg.db, bus });
  const teams = createTeamsService({ db: pg.db, identity, tournaments: tournamentsService });
  const matches = createMatchesService({ db: pg.db, bus, logger });
  return { bus, tournamentsService, teams, matches };
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} отсутствует`);
  return value;
}

interface Fixture {
  tournamentId: number;
  teamA: number;
  teamB: number;
  teamC: number;
  teamD: number;
  firstMatchId: number;
  secondMatchId: number;
  finalMatchId: number;
}

let counter = 0;

/** Турнир на четыре команды по два человека в состоянии running с сеткой из трёх матчей. */
async function runningTournament(): Promise<Fixture> {
  counter += 1;
  const { tournamentsService, teams } = services();
  const { tournament } = await tournamentsService.create({
    guildId: GUILD,
    name: `Разбор ${counter}`,
    game: 'lol',
    entryMode: 'team',
    teamSize: 2,
    maxEntrants: 4,
    seeding: 'random',
    bestOf: 1,
    requireVerified: false,
    createdBy: ADMIN,
    announceChannelId: null,
    matchParentId: null,
  });
  await tournamentsService.open(tournament.id, GUILD);

  const entrantIds: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const captain = required(USERS[index * 2], 'капитан');
    const mate = required(USERS[index * 2 + 1], 'напарник');
    const entrant = await teams.create({
      tournamentId: tournament.id,
      guildId: GUILD,
      captainUserId: captain,
      name: `Команда ${index + 1}`,
    });
    await teams.invite({ tournamentId: tournament.id, guildId: GUILD, captainUserId: captain, userId: mate });
    entrantIds.push(entrant.id);
  }

  await pg.db
    .update(tournaments)
    .set({ state: 'running', startedAt: new Date() })
    .where(eq(tournaments.id, tournament.id));

  const teamA = required(entrantIds[0], 'команда A');
  const teamB = required(entrantIds[1], 'команда B');
  const teamC = required(entrantIds[2], 'команда C');
  const teamD = required(entrantIds[3], 'команда D');

  const inserted = await pg.db
    .insert(tournamentMatches)
    .values([
      { tournamentId: tournament.id, round: 1, slot: 0, entrantAId: teamA, entrantBId: teamB, state: 'ready' },
      { tournamentId: tournament.id, round: 1, slot: 1, entrantAId: teamC, entrantBId: teamD, state: 'ready' },
      { tournamentId: tournament.id, round: 2, slot: 0, state: 'pending' },
    ])
    .returning();

  const idOf = (round: number, slot: number): number =>
    required(
      inserted.find((match) => match.round === round && match.slot === slot),
      `матч ${round}/${slot}`,
    ).id;

  return {
    tournamentId: tournament.id,
    teamA,
    teamB,
    teamC,
    teamD,
    firstMatchId: idOf(1, 0),
    secondMatchId: idOf(1, 1),
    finalMatchId: idOf(2, 0),
  };
}

const captainOf = (index: number): string => required(USERS[index * 2], 'капитан');
const mateOf = (index: number): string => required(USERS[index * 2 + 1], 'напарник');

/** Сдвигает время заявки в прошлое: окно автоподтверждения проверяется по reported_at. */
async function ageReport(matchId: number, minutes: number): Promise<void> {
  await pg.db
    .update(tournamentMatches)
    .set({ reportedAt: new Date(Date.now() - minutes * 60_000) })
    .where(eq(tournamentMatches.id, matchId));
}

beforeEach(async () => {
  const { tournamentsService } = services();
  await tournamentsService.ensureGuild(GUILD);
  for (const userId of [...USERS, ADMIN]) await tournamentsService.ensureUser(userId);
});

describe('dispute', () => {
  it('переводит матч в спорный и сохраняет причину', async () => {
    const fixture = await runningTournament();
    const { matches } = services();
    await matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });

    const match = await matches.dispute({
      matchId: fixture.firstMatchId,
      userId: captainOf(1),
      reason: 'вторая карта не была доиграна',
    });

    expect(match.state).toBe('disputed');
    expect(match.disputedAt).toBeInstanceOf(Date);
    const reports = await pg.db
      .select()
      .from(tournamentMatchReports)
      .where(eq(tournamentMatchReports.matchId, fixture.firstMatchId));
    expect(reports.find((report) => report.kind === 'dispute')?.note).toBe('вторая карта не была доиграна');
  });

  it('не даёт оспорить результат тому же составу, который его заявил', async () => {
    const fixture = await runningTournament();
    const { matches } = services();
    await matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });

    await expect(
      matches.dispute({ matchId: fixture.firstMatchId, userId: mateOf(0), reason: null }),
    ).rejects.toThrow(/только состав соперника/);
  });

  it('не даёт оспорить то, чего не заявляли', async () => {
    const fixture = await runningTournament();
    const { matches } = services();

    await expect(
      matches.dispute({ matchId: fixture.firstMatchId, userId: captainOf(1), reason: null }),
    ).rejects.toThrow(/ещё не заявлен/);
  });

  it('бот не разрешает спор сам: автоподтверждение спорный матч не трогает', async () => {
    const fixture = await runningTournament();
    const { matches } = services();
    await matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });
    await ageReport(fixture.firstMatchId, 120);
    await matches.dispute({ matchId: fixture.firstMatchId, userId: captainOf(1), reason: null });

    const outcomes = await matches.autoConfirmDue(new Date(), 50);

    expect(outcomes).toHaveLength(0);
    const [match] = await pg.db.select().from(tournamentMatches).where(eq(tournamentMatches.id, fixture.firstMatchId));
    expect(match?.state).toBe('disputed');
  });
});

describe('resolve', () => {
  it('назначает победителем указанную сторону и продвигает его', async () => {
    const fixture = await runningTournament();
    const { matches } = services();
    await matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });
    await matches.dispute({ matchId: fixture.firstMatchId, userId: captainOf(1), reason: 'не согласны' });

    const outcome = await matches.resolve({
      matchId: fixture.firstMatchId,
      guildId: GUILD,
      adminUserId: ADMIN,
      side: 'b',
    });

    expect(outcome.changed).toBe(true);
    expect(outcome.match.state).toBe('confirmed');
    expect(outcome.match.winnerEntrantId).toBe(fixture.teamB);
    const [final] = await pg.db.select().from(tournamentMatches).where(eq(tournamentMatches.id, fixture.finalMatchId));
    expect(final?.entrantAId).toBe(fixture.teamB);
    const reports = await pg.db
      .select()
      .from(tournamentMatchReports)
      .where(eq(tournamentMatchReports.matchId, fixture.firstMatchId));
    expect(reports.find((report) => report.kind === 'admin-resolve')).toMatchObject({ isAdmin: true, actorUserId: ADMIN });
  });

  it('второе решение по тому же матчу ничего не меняет', async () => {
    const fixture = await runningTournament();
    const { matches } = services();
    await matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });
    await matches.resolve({ matchId: fixture.firstMatchId, guildId: GUILD, adminUserId: ADMIN, side: 'b' });

    const second = await matches.resolve({
      matchId: fixture.firstMatchId,
      guildId: GUILD,
      adminUserId: ADMIN,
      side: 'a',
    });

    expect(second.changed).toBe(false);
    const [match] = await pg.db.select().from(tournamentMatches).where(eq(tournamentMatches.id, fixture.firstMatchId));
    expect(match?.winnerEntrantId).toBe(fixture.teamB);
  });

  it('отправляет к walkover, когда соперник ещё не определён', async () => {
    const fixture = await runningTournament();
    const { matches } = services();

    await expect(
      matches.resolve({ matchId: fixture.finalMatchId, guildId: GUILD, adminUserId: ADMIN, side: 'a' }),
    ).rejects.toThrow(/\/match walkover/);
  });

  it('не решает матч чужого сервера', async () => {
    const fixture = await runningTournament();
    const { matches } = services();

    await expect(
      matches.resolve({ matchId: fixture.firstMatchId, guildId: '129000000000000001', adminUserId: ADMIN, side: 'a' }),
    ).rejects.toThrow(/не найден на этом сервере/);
  });
});

describe('walkover', () => {
  it('назначает победителя матчу, соперник в котором ещё не известен', async () => {
    const fixture = await runningTournament();
    const { matches } = services();
    await matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });
    await matches.confirm({ matchId: fixture.firstMatchId, userId: captainOf(1) });

    const outcome = await matches.walkover({
      matchId: fixture.finalMatchId,
      guildId: GUILD,
      adminUserId: ADMIN,
      side: 'a',
    });

    expect(outcome.changed).toBe(true);
    expect(outcome.match.state).toBe('walkover');
    expect(outcome.match.winnerEntrantId).toBe(fixture.teamA);
    expect(outcome.championEntrantId).toBe(fixture.teamA);
  });

  it('отказывается назначать победителем пустую сторону', async () => {
    const fixture = await runningTournament();
    const { matches } = services();

    await expect(
      matches.walkover({ matchId: fixture.finalMatchId, guildId: GUILD, adminUserId: ADMIN, side: 'b' }),
    ).rejects.toThrow(/нет участника/);
  });

  it('пишет неявку в журнал как решение администратора', async () => {
    const fixture = await runningTournament();
    const { matches } = services();

    await matches.walkover({ matchId: fixture.firstMatchId, guildId: GUILD, adminUserId: ADMIN, side: 'a' });

    const reports = await pg.db
      .select()
      .from(tournamentMatchReports)
      .where(eq(tournamentMatchReports.matchId, fixture.firstMatchId));
    expect(reports.find((report) => report.kind === 'walkover')).toMatchObject({ isAdmin: true, actorUserId: ADMIN });
  });
});

describe('autoConfirmDue', () => {
  it('подтверждает заявку старше шестидесяти минут и продвигает победителя', async () => {
    const fixture = await runningTournament();
    const { matches, bus } = services();
    const confirmed: Array<BotEvents['match.confirmed']> = [];
    bus.on('match.confirmed', (payload) => {
      confirmed.push(payload);
    });
    await matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });
    await ageReport(fixture.firstMatchId, 61);

    const outcomes = await matches.autoConfirmDue(new Date(), 50);

    expect(outcomes.filter((outcome) => outcome.changed)).toHaveLength(1);
    const [match] = await pg.db.select().from(tournamentMatches).where(eq(tournamentMatches.id, fixture.firstMatchId));
    expect(match?.state).toBe('confirmed');
    const [final] = await pg.db.select().from(tournamentMatches).where(eq(tournamentMatches.id, fixture.finalMatchId));
    expect(final?.entrantAId).toBe(fixture.teamA);
    expect(confirmed).toHaveLength(1);
  });

  it('не трогает заявку, которой ещё нет часа', async () => {
    const fixture = await runningTournament();
    const { matches } = services();
    await matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });
    await ageReport(fixture.firstMatchId, 59);

    const outcomes = await matches.autoConfirmDue(new Date(), 50);

    expect(outcomes).toHaveLength(0);
    const [match] = await pg.db.select().from(tournamentMatches).where(eq(tournamentMatches.id, fixture.firstMatchId));
    expect(match?.state).toBe('reported');
  });

  it('пишет автоподтверждение в журнал без автора', async () => {
    const fixture = await runningTournament();
    const { matches } = services();
    await matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });
    await ageReport(fixture.firstMatchId, 61);

    await matches.autoConfirmDue(new Date(), 50);

    const reports = await pg.db
      .select()
      .from(tournamentMatchReports)
      .where(eq(tournamentMatchReports.matchId, fixture.firstMatchId));
    expect(reports.find((report) => report.kind === 'auto-confirm')).toMatchObject({ actorUserId: null });
  });

  it('не берёт за прогон больше лимита', async () => {
    const fixture = await runningTournament();
    const { matches } = services();
    await matches.report({ matchId: fixture.firstMatchId, userId: captainOf(0), winnerEntrantId: fixture.teamA });
    await matches.report({ matchId: fixture.secondMatchId, userId: captainOf(2), winnerEntrantId: fixture.teamC });
    await ageReport(fixture.firstMatchId, 90);
    await ageReport(fixture.secondMatchId, 80);

    const outcomes = await matches.autoConfirmDue(new Date(), 1);

    expect(outcomes).toHaveLength(1);
    const rows = await pg.db
      .select()
      .from(tournamentMatches)
      .where(inArray(tournamentMatches.id, [fixture.firstMatchId, fixture.secondMatchId]))
      .orderBy(asc(tournamentMatches.slot));
    // Первым берётся тот, чья заявка старше.
    expect(rows[0]?.state).toBe('confirmed');
    expect(rows[1]?.state).toBe('reported');
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npm run test:int -- tests/integration/tournaments/matches-resolve.test.ts`
Expected: FAIL — у сервиса нет методов `dispute`, `resolve`, `walkover`, `autoConfirmDue`.

- [ ] **Step 3: Дополнить `src/modules/tournaments/services/matches.ts`**

Добавить в импорты `lte`:

```ts
import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
```

Добавить константу рядом с типами:

```ts
/** Окно автоподтверждения из спеки: молчание соперника час означает согласие. */
export const AUTO_CONFIRM_AFTER_MS = 60 * 60 * 1_000;
```

Дополнить `interface MatchesService` четырьмя методами:

```ts
  dispute(input: { matchId: number; userId: string; reason: string | null }): Promise<MatchRow>;
  resolve(input: { matchId: number; guildId: string; adminUserId: string; side: 'a' | 'b' }): Promise<SettleOutcome>;
  walkover(input: { matchId: number; guildId: string; adminUserId: string; side: 'a' | 'b' }): Promise<SettleOutcome>;
  /** Подтверждает заявки, которым больше AUTO_CONFIRM_AFTER_MS. Вызывается только джобой. */
  autoConfirmDue(now: Date, limit: number): Promise<SettleOutcome[]>;
```

Добавить объяснение состояний рядом с `explainNotConfirmable`:

```ts
function explainNotDisputable(match: MatchRow): string {
  switch (match.state) {
    case 'pending':
      return 'Соперник ещё не известен — оспаривать нечего.';
    case 'ready':
      return 'Результат ещё не заявлен — оспаривать нечего.';
    case 'disputed':
      return 'Матч уже спорный: ждём решения организатора.';
    default:
      return 'Результат этого матча уже окончательный. Если он неверный, обратись к организатору.';
  }
}
```

Добавить в возвращаемый объект `createMatchesService` четыре метода (после `confirm`):

```ts
    async dispute(input): Promise<MatchRow> {
      const sides = await sidesOf(input.matchId);
      const match = sides.match;

      if (match.state !== 'reported') throw new UserError(explainNotDisputable(match));

      const reportedBy = match.reportedBy;
      if (reportedBy === null) throw new BugError(`матч ${match.id} заявлен без reported_by`);

      const disputerSide = sideOf(sides, input.userId);
      if (disputerSide === null) throw new UserError('Ты не играешь в этом матче.');
      if (sideOf(sides, reportedBy) === disputerSide) {
        throw new UserError(
          'Оспорить результат может только состав соперника. Если ошибся сам — попроси организатора решить матч через `/match resolve`.',
        );
      }

      const [updated] = await db
        .update(tournamentMatches)
        .set({ state: 'disputed', disputedAt: new Date() })
        .where(and(eq(tournamentMatches.id, match.id), eq(tournamentMatches.state, 'reported')))
        .returning();

      if (!updated) throw new UserError(explainNotDisputable(await byId(match.id)));

      await db.insert(tournamentMatchReports).values({
        matchId: updated.id,
        tournamentId: updated.tournamentId,
        kind: 'dispute',
        actorUserId: input.userId,
        claimedWinnerId: null,
        note: input.reason,
      });

      // Спор не разрешается ботом никогда: выход отсюда — только `/match resolve`.
      return updated;
    },

    async resolve(input): Promise<SettleOutcome> {
      const [found] = await db
        .select({ match: tournamentMatches })
        .from(tournamentMatches)
        .innerJoin(tournaments, eq(tournamentMatches.tournamentId, tournaments.id))
        .where(and(eq(tournamentMatches.id, input.matchId), eq(tournaments.guildId, input.guildId)));
      if (!found) throw new UserError('Матч не найден на этом сервере.');
      const match = found.match;

      if (match.state === 'pending') {
        throw new UserError('Соперник в этом матче ещё не определён: неявку оформляй через `/match walkover`.');
      }

      const winnerEntrantId = input.side === 'a' ? match.entrantAId : match.entrantBId;
      if (winnerEntrantId === null) {
        throw new UserError('На выбранной стороне нет участника.');
      }

      const at = new Date();
      const outcome = await db.transaction(async (tx) => {
        const settled = await settle(tx, {
          matchId: match.id,
          fromStates: ['ready', 'reported', 'disputed'],
          toState: 'confirmed',
          at,
          winnerEntrantId,
        });
        if (settled.changed) {
          await tx.insert(tournamentMatchReports).values({
            matchId: match.id,
            tournamentId: match.tournamentId,
            kind: 'admin-resolve',
            actorUserId: input.adminUserId,
            claimedWinnerId: winnerEntrantId,
            isAdmin: true,
          });
        }
        return settled;
      });

      await publish(outcome);
      return outcome;
    },

    async walkover(input): Promise<SettleOutcome> {
      const [found] = await db
        .select({ match: tournamentMatches })
        .from(tournamentMatches)
        .innerJoin(tournaments, eq(tournamentMatches.tournamentId, tournaments.id))
        .where(and(eq(tournamentMatches.id, input.matchId), eq(tournaments.guildId, input.guildId)));
      if (!found) throw new UserError('Матч не найден на этом сервере.');
      const match = found.match;

      const winnerEntrantId = input.side === 'a' ? match.entrantAId : match.entrantBId;
      if (winnerEntrantId === null) {
        throw new UserError('На выбранной стороне нет участника: победителем можно сделать только известного участника матча.');
      }

      const at = new Date();
      const outcome = await db.transaction(async (tx) => {
        const settled = await settle(tx, {
          matchId: match.id,
          // Неявку объявляют и до того, как матч стал готов: соперник мог сняться,
          // пока его половина сетки ещё не доиграна.
          fromStates: ['pending', 'ready', 'reported', 'disputed'],
          toState: 'walkover',
          at,
          winnerEntrantId,
        });
        if (settled.changed) {
          await tx.insert(tournamentMatchReports).values({
            matchId: match.id,
            tournamentId: match.tournamentId,
            kind: 'walkover',
            actorUserId: input.adminUserId,
            claimedWinnerId: winnerEntrantId,
            isAdmin: true,
          });
        }
        return settled;
      });

      await publish(outcome);
      return outcome;
    },

    async autoConfirmDue(now, limit): Promise<SettleOutcome[]> {
      const threshold = new Date(now.getTime() - AUTO_CONFIRM_AFTER_MS);

      // Спорные матчи сюда не попадают по определению: у них состояние 'disputed'.
      // Именно поэтому бот не может разрешить спор сам.
      const due = await db
        .select()
        .from(tournamentMatches)
        .where(and(eq(tournamentMatches.state, 'reported'), lte(tournamentMatches.reportedAt, threshold)))
        .orderBy(asc(tournamentMatches.reportedAt))
        .limit(limit);

      const outcomes: SettleOutcome[] = [];
      for (const match of due) {
        const outcome = await db.transaction(async (tx) => {
          const settled = await settle(tx, {
            matchId: match.id,
            fromStates: ['reported'],
            toState: 'confirmed',
            at: now,
          });
          if (settled.changed) {
            await tx.insert(tournamentMatchReports).values({
              matchId: match.id,
              tournamentId: match.tournamentId,
              kind: 'auto-confirm',
              actorUserId: null,
              claimedWinnerId: settled.match.winnerEntrantId,
            });
          }
          return settled;
        });

        await publish(outcome);
        outcomes.push(outcome);
      }

      if (due.length > 0) {
        logger.info(
          { due: due.length, confirmed: outcomes.filter((outcome) => outcome.changed).length },
          'окно автоподтверждения обработано',
        );
      }
      return outcomes;
    },
```

- [ ] **Step 4: Прогнать тесты**

Run: `npm run test:int -- tests/integration/tournaments/matches-report.test.ts tests/integration/tournaments/matches-resolve.test.ts && npm run typecheck`
Expected: 20 тестов в `matches-report.test.ts` и 15 в `matches-resolve.test.ts` (4 + 4 + 3 + 4 по describe-блокам) — 35 PASS, тайпчек чистый.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/tournaments/services/matches.ts tests/integration/tournaments/matches-resolve.test.ts
git commit -m "feat(tournaments): спор, решение администратора, неявка и автоподтверждение по окну"
```

---

### Task 12: Компактный вид сетки и чтение сетки из БД

**Files:**
- Create: `src/modules/tournaments/bracket/render.ts`, `src/modules/tournaments/services/view.ts`
- Test: `tests/modules/tournaments/bracket/render.test.ts`, `tests/integration/tournaments/view.test.ts`

**Interfaces:**
- Consumes: `Database`, `UserError`; `MatchState` из схемы (Task 1); `TournamentRow`, `TournamentsService` (Task 6).
- Produces:
  - `const BRACKET_TEXT_LIMIT = 1900`
  - `interface RenderEntrant { id: number; displayName: string; seed: number | null }`
  - `interface RenderMatch { id: number; round: number; slot: number; entrantAId: number | null; entrantBId: number | null; winnerEntrantId: number | null; state: MatchState }`
  - `interface RenderBracketInput { name: string; size: number; url: string; entrants: readonly RenderEntrant[]; matches: readonly RenderMatch[] }`
  - `function renderBracket(input: RenderBracketInput): string`
  - `interface BracketView { tournament: TournamentRow; entrants: RenderEntrant[]; matches: RenderMatch[]; size: number }`
  - `interface ViewService { bracketOf(tournamentId: number, guildId: string): Promise<BracketView> }`
  - `function createViewService(deps: { db: Database; tournaments: TournamentsService }): ViewService`

**Почему лимит 1900, а не 2000.** Предел сообщения Discord — 2000 символов, и в него должен уместиться не только текст сетки, но и хвост со ссылкой на витрину. 1900 — весь ответ целиком, включая хвост; на сетке из 64 участников (63 матча) текст обрезается с явной пометкой, а не молча теряет конец.

Номер матча (`#12`) в каждой строке — не украшение: `/match resolve` и `/match walkover` принимают номер, и организатору его надо откуда-то взять.

- [ ] **Step 1: Написать падающий тест рендера**

Файл `tests/modules/tournaments/bracket/render.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  BRACKET_TEXT_LIMIT,
  renderBracket,
  type RenderEntrant,
  type RenderMatch,
} from '../../../../src/modules/tournaments/bracket/render.js';

const URL = 'https://bot.example.com/t/7';

function entrant(id: number, displayName: string, seed: number | null): RenderEntrant {
  return { id, displayName, seed };
}

describe('renderBracket', () => {
  it('показывает круги, номера матчей и сиды участников', () => {
    const text = renderBracket({
      name: 'Кубок сервера',
      size: 4,
      url: URL,
      entrants: [entrant(1, 'Красные', 1), entrant(2, 'Синие', 4), entrant(3, 'Зелёные', 2), entrant(4, 'Белые', 3)],
      matches: [
        { id: 11, round: 1, slot: 0, entrantAId: 1, entrantBId: 2, winnerEntrantId: null, state: 'ready' },
        { id: 12, round: 1, slot: 1, entrantAId: 3, entrantBId: 4, winnerEntrantId: null, state: 'ready' },
        { id: 13, round: 2, slot: 0, entrantAId: null, entrantBId: null, winnerEntrantId: null, state: 'pending' },
      ],
    });

    expect(text).toContain('Кубок сервера');
    expect(text).toContain('Круг 1');
    expect(text).toContain('Круг 2');
    expect(text).toContain('#11');
    expect(text).toContain('Красные (1)');
    expect(text).toContain('Синие (4)');
  });

  it('помечает победителя', () => {
    const text = renderBracket({
      name: 'Кубок',
      size: 2,
      url: URL,
      entrants: [entrant(1, 'Красные', 1), entrant(2, 'Синие', 2)],
      matches: [{ id: 21, round: 1, slot: 0, entrantAId: 1, entrantBId: 2, winnerEntrantId: 2, state: 'confirmed' }],
    });

    expect(text).toContain('**Синие (2)** ✅');
    expect(text).not.toContain('**Красные (1)** ✅');
  });

  it('показывает пропуск словом, а не пустотой', () => {
    const text = renderBracket({
      name: 'Кубок',
      size: 4,
      url: URL,
      entrants: [entrant(1, 'Красные', 1)],
      matches: [{ id: 31, round: 1, slot: 0, entrantAId: 1, entrantBId: null, winnerEntrantId: 1, state: 'walkover' }],
    });

    expect(text).toContain('пропуск');
  });

  it('показывает неизвестного участника вопросительным знаком', () => {
    const text = renderBracket({
      name: 'Кубок',
      size: 4,
      url: URL,
      entrants: [entrant(1, 'Красные', 1)],
      matches: [{ id: 41, round: 2, slot: 0, entrantAId: 1, entrantBId: null, winnerEntrantId: null, state: 'pending' }],
    });

    expect(text).toContain('?');
    expect(text).not.toContain('пропуск');
  });

  it('добавляет ссылку на витрину', () => {
    const text = renderBracket({ name: 'Кубок', size: 2, url: URL, entrants: [], matches: [] });

    expect(text).toContain(URL);
  });

  it('не превышает лимит на сетке из 64 участников и говорит об обрезке', () => {
    const entrants = Array.from({ length: 64 }, (_unused, index) =>
      entrant(index + 1, `Команда с длинным названием ${index + 1}`, index + 1),
    );
    const matches: RenderMatch[] = [];
    let id = 100;
    for (let round = 1; round <= 6; round += 1) {
      for (let slot = 0; slot < 64 / 2 ** round; slot += 1) {
        id += 1;
        matches.push({
          id,
          round,
          slot,
          entrantAId: round === 1 ? slot * 2 + 1 : null,
          entrantBId: round === 1 ? slot * 2 + 2 : null,
          winnerEntrantId: null,
          state: round === 1 ? 'ready' : 'pending',
        });
      }
    }

    const text = renderBracket({ name: 'Большой кубок', size: 64, url: URL, entrants, matches });

    expect(matches).toHaveLength(63);
    expect(text.length).toBeLessThanOrEqual(BRACKET_TEXT_LIMIT);
    expect(text).toContain('список обрезан');
    expect(text).toContain(URL);
  });
});
```

- [ ] **Step 2: Написать падающий тест чтения сетки**

Файл `tests/integration/tournaments/view.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { EventBus } from '../../../src/core/events/bus.js';
import { createLogger } from '../../../src/core/logger.js';
import { tournamentEntrants, tournamentMatches } from '../../../src/modules/tournaments/schema.js';
import { createTournamentsService } from '../../../src/modules/tournaments/services/tournaments.js';
import { createViewService } from '../../../src/modules/tournaments/services/view.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

const GUILD = '130000000000000001';
const OTHER_GUILD = '130000000000000002';
const PLAYER_ONE = '131000000000000001';
const PLAYER_TWO = '131000000000000002';

function services() {
  const bus = new EventBus(logger);
  const tournamentsService = createTournamentsService({ db: pg.db, bus });
  return { tournamentsService, view: createViewService({ db: pg.db, tournaments: tournamentsService }) };
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} отсутствует`);
  return value;
}

let counter = 0;

async function tournamentWithBracket(): Promise<{ tournamentId: number; entrantIds: number[] }> {
  counter += 1;
  const { tournamentsService } = services();
  const { tournament } = await tournamentsService.create({
    guildId: GUILD,
    name: `Витрина ${counter}`,
    game: 'other',
    entryMode: 'solo',
    teamSize: 1,
    maxEntrants: 4,
    seeding: 'random',
    bestOf: 1,
    requireVerified: false,
    createdBy: PLAYER_ONE,
    announceChannelId: null,
    matchParentId: null,
  });

  const first = required(
    (
      await pg.db
        .insert(tournamentEntrants)
        .values({ tournamentId: tournament.id, displayName: 'Первый', captainUserId: PLAYER_ONE, seed: 1 })
        .returning()
    )[0],
    'первый участник',
  );
  const second = required(
    (
      await pg.db
        .insert(tournamentEntrants)
        .values({ tournamentId: tournament.id, displayName: 'Второй', captainUserId: PLAYER_TWO, seed: 2 })
        .returning()
    )[0],
    'второй участник',
  );

  return { tournamentId: tournament.id, entrantIds: [first.id, second.id] };
}

beforeEach(async () => {
  const { tournamentsService } = services();
  await tournamentsService.ensureGuild(GUILD);
  await tournamentsService.ensureGuild(OTHER_GUILD);
  await tournamentsService.ensureUser(PLAYER_ONE);
  await tournamentsService.ensureUser(PLAYER_TWO);
});

describe('ViewService.bracketOf', () => {
  it('отдаёт участников с сидами и матчи по возрастанию круга и слота', async () => {
    const { view } = services();
    const { tournamentId, entrantIds } = await tournamentWithBracket();
    await pg.db.insert(tournamentMatches).values([
      { tournamentId, round: 2, slot: 0, state: 'pending' },
      {
        tournamentId,
        round: 1,
        slot: 1,
        entrantAId: required(entrantIds[1], 'второй участник'),
        state: 'walkover',
        winnerEntrantId: required(entrantIds[1], 'второй участник'),
      },
      {
        tournamentId,
        round: 1,
        slot: 0,
        entrantAId: required(entrantIds[0], 'первый участник'),
        state: 'walkover',
        winnerEntrantId: required(entrantIds[0], 'первый участник'),
      },
    ]);

    const bracket = await view.bracketOf(tournamentId, GUILD);

    expect(bracket.matches.map((match) => [match.round, match.slot])).toEqual([
      [1, 0],
      [1, 1],
      [2, 0],
    ]);
    expect(bracket.entrants.map((entrant) => entrant.seed)).toEqual([1, 2]);
    expect(bracket.size).toBe(4);
  });

  it('отдаёт турнир до старта с пустым списком матчей', async () => {
    const { view } = services();
    const { tournamentId } = await tournamentWithBracket();

    const bracket = await view.bracketOf(tournamentId, GUILD);

    expect(bracket.matches).toEqual([]);
    // Размер сетки до старта считается по числу записавшихся: их двое.
    expect(bracket.size).toBe(2);
  });

  it('не отдаёт сетку турнира с другого сервера', async () => {
    const { view } = services();
    const { tournamentId } = await tournamentWithBracket();

    await expect(view.bracketOf(tournamentId, OTHER_GUILD)).rejects.toThrow(/не найден на этом сервере/);
  });

  it('не считает снятых участников в размере сетки', async () => {
    const { view } = services();
    const { tournamentId, entrantIds } = await tournamentWithBracket();
    await pg.db
      .update(tournamentEntrants)
      .set({ withdrawnAt: new Date() })
      .where(eq(tournamentEntrants.id, required(entrantIds[1], 'второй участник')));

    const bracket = await view.bracketOf(tournamentId, GUILD);

    // Один участник — сетки нет, размер 0: строить её не из чего, и падать тут нельзя.
    expect(bracket.size).toBe(0);
    expect(bracket.entrants).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Запустить тесты — убедиться, что падают**

Run: `npx vitest run tests/modules/tournaments/bracket/render.test.ts`
Expected: FAIL — модуль `render.js` не найден.

Run: `npm run test:int -- tests/integration/tournaments/view.test.ts`
Expected: FAIL — модуль `view.js` не найден.

- [ ] **Step 4: Реализовать `src/modules/tournaments/bracket/render.ts`**

```ts
import type { MatchState } from '../schema.js';

/**
 * Предел сообщения Discord — 2000 символов, и в него входит хвост со ссылкой.
 * 1900 — вся длина ответа целиком: на сетке из 64 участников текст обрезается с
 * явной пометкой, а не теряет конец молча.
 */
export const BRACKET_TEXT_LIMIT = 1900;

export interface RenderEntrant {
  id: number;
  displayName: string;
  seed: number | null;
}

export interface RenderMatch {
  id: number;
  round: number;
  slot: number;
  entrantAId: number | null;
  entrantBId: number | null;
  winnerEntrantId: number | null;
  state: MatchState;
}

export interface RenderBracketInput {
  name: string;
  size: number;
  url: string;
  entrants: readonly RenderEntrant[];
  matches: readonly RenderMatch[];
}

export function renderBracket(input: RenderBracketInput): string {
  const byId = new Map(input.entrants.map((entrant) => [entrant.id, entrant]));

  const nameOf = (entrantId: number | null): string => {
    if (entrantId === null) return '?';
    const entrant = byId.get(entrantId);
    if (!entrant) return '?';
    return entrant.seed === null ? entrant.displayName : `${entrant.displayName} (${entrant.seed})`;
  };

  const lines = [`**${input.name}** — сетка на ${input.size} участников`];
  const rounds = [...new Set(input.matches.map((match) => match.round))].sort((left, right) => left - right);

  for (const round of rounds) {
    lines.push(`__Круг ${round}__`);
    const inRound = input.matches
      .filter((match) => match.round === round)
      .sort((left, right) => left.slot - right.slot);

    for (const match of inRound) {
      // Пропуск отличается от «соперник ещё не известен» состоянием матча: walkover
      // с одной пустой стороной — это пропуск, pending с пустой стороной — ожидание.
      const isBye = match.state === 'walkover' && (match.entrantAId === null || match.entrantBId === null);
      const left = match.entrantAId === null && isBye ? 'пропуск' : nameOf(match.entrantAId);
      const right = match.entrantBId === null && isBye ? 'пропуск' : nameOf(match.entrantBId);

      const mark = (entrantId: number | null, text: string): string =>
        entrantId !== null && entrantId === match.winnerEntrantId ? `**${text}** ✅` : text;

      // Номер матча нужен организатору для `/match resolve` и `/match walkover`.
      lines.push(`\`#${match.id}\` ${mark(match.entrantAId, left)} — ${mark(match.entrantBId, right)}`);
    }
  }

  const tail = `\nПолная сетка: ${input.url}`;
  const body = lines.join('\n');
  if (body.length + tail.length <= BRACKET_TEXT_LIMIT) return body + tail;

  const notice = '\n… список обрезан, полная сетка по ссылке.';
  const room = BRACKET_TEXT_LIMIT - tail.length - notice.length;
  return `${body.slice(0, room)}${notice}${tail}`;
}
```

- [ ] **Step 5: Реализовать `src/modules/tournaments/services/view.ts`**

```ts
import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import type { RenderEntrant, RenderMatch } from '../bracket/render.js';
import { tournamentEntrants, tournamentMatches } from '../schema.js';
import type { TournamentRow, TournamentsService } from './tournaments.js';

export interface BracketView {
  tournament: TournamentRow;
  entrants: RenderEntrant[];
  /** По возрастанию круга и слота. Пусто, если турнир ещё не стартовал. */
  matches: RenderMatch[];
  /**
   * Размер сетки. После старта — число матчей первого круга × 2; до старта — оценка
   * по числу записавшихся. 0 означает «сетку строить не из чего», а не ошибку:
   * `/bracket` до записи второго участника обязана отвечать, а не падать.
   */
  size: number;
}

export interface ViewService {
  bracketOf(tournamentId: number, guildId: string): Promise<BracketView>;
}

export function createViewService(deps: { db: Database; tournaments: TournamentsService }): ViewService {
  const { db } = deps;

  return {
    async bracketOf(tournamentId, guildId): Promise<BracketView> {
      const tournament = await deps.tournaments.require(tournamentId, guildId);

      const entrantRows = await db
        .select({
          id: tournamentEntrants.id,
          displayName: tournamentEntrants.displayName,
          seed: tournamentEntrants.seed,
          withdrawnAt: tournamentEntrants.withdrawnAt,
        })
        .from(tournamentEntrants)
        .where(eq(tournamentEntrants.tournamentId, tournamentId))
        .orderBy(asc(tournamentEntrants.seed), asc(tournamentEntrants.id));

      const matches = await db
        .select({
          id: tournamentMatches.id,
          round: tournamentMatches.round,
          slot: tournamentMatches.slot,
          entrantAId: tournamentMatches.entrantAId,
          entrantBId: tournamentMatches.entrantBId,
          winnerEntrantId: tournamentMatches.winnerEntrantId,
          state: tournamentMatches.state,
        })
        .from(tournamentMatches)
        .where(eq(tournamentMatches.tournamentId, tournamentId))
        .orderBy(asc(tournamentMatches.round), asc(tournamentMatches.slot));

      const firstRound = matches.filter((match) => match.round === 1).length;
      const active = entrantRows.filter((row) => row.withdrawnAt === null).length;
      const size = firstRound > 0 ? firstRound * 2 : active >= 2 ? nextPowerOfTwo(active) : 0;

      const entrants: RenderEntrant[] = entrantRows.map((row) => ({
        id: row.id,
        displayName: row.displayName,
        seed: row.seed,
      }));

      return { tournament, entrants, matches, size };
    },
  };
}

/** Та же арифметика, что в bracketSize, но без отказа на одном участнике. */
function nextPowerOfTwo(value: number): number {
  let size = 2;
  while (size < value) size *= 2;
  return size;
}
```

- [ ] **Step 6: Прогнать тесты**

Run: `npx vitest run tests/modules/tournaments/bracket/render.test.ts && npm run test:int -- tests/integration/tournaments/view.test.ts && npm run typecheck`
Expected: 6 тестов PASS в `render.test.ts`, 4 теста PASS в `view.test.ts`, тайпчек чистый.

- [ ] **Step 7: Коммит**

```bash
git add src/modules/tournaments/bracket/render.ts src/modules/tournaments/services/view.ts tests/modules/tournaments/bracket/render.test.ts tests/integration/tournaments/view.test.ts
git commit -m "feat(tournaments): компактный текст сетки и чтение сетки из БД"
```

---

### Task 13: Инфраструктура команд, `/bracket` и `/checkin`

**Files:**
- Create: `src/modules/tournaments/deps.ts`, `src/modules/tournaments/commands/guards.ts`, `src/modules/tournaments/commands/bracket.ts`, `src/modules/tournaments/commands/checkin.ts`
- Modify: `tests/helpers/interaction.ts` — добавить `fakeCommandInteraction`
- Test: `tests/modules/tournaments/commands/guards.test.ts`, `tests/modules/tournaments/commands/bracket.test.ts`, `tests/modules/tournaments/commands/checkin.test.ts`
- Своего теста нет только у `deps.ts`, и это единственный такой файл в плане: в нём нет ни одной исполняемой строки — только `interface TournamentDeps` из ссылок на уже покрытые сервисы. Проверяет его тайпчек: если поле разойдётся с сервисом, `npm run typecheck` упадёт в каждой команде, которая это поле читает.

**Interfaces:**
- Consumes: `CommandDefinition` из `src/core/module.ts`; `UserError`; `renderBracket` (Task 12); сервисы Tasks 6-12.
- Produces:
  - `interface TournamentDeps { tournaments: TournamentsService; registration: RegistrationService; teams: TeamsService; start: StartService; matches: MatchesService; view: ViewService; publicBaseUrl: string }`
  - `function requireGuild(interaction: ChatInputCommandInteraction): string` — `guildId` или `UserError`
  - `function requireOrganizer(interaction: ChatInputCommandInteraction): void` — `UserError`, если нет права «Управление сервером»
  - `function createBracketCommand(deps: TournamentDeps): CommandDefinition`
  - `function createCheckinCommand(deps: TournamentDeps): CommandDefinition`
  - `function fakeCommandInteraction(commandName: string, options?: FakeCommandOptions): FakeCommand` в `tests/helpers/interaction.ts`, где
    `interface FakeCommandOptions { subcommand?: string; strings?: Record<string, string>; integers?: Record<string, number>; booleans?: Record<string, boolean>; channels?: Record<string, { id: string }>; users?: Record<string, { id: string; username?: string }>; permissions?: bigint[]; userId?: string; username?: string; guildId?: string | null }`
    и `interface FakeCommand { interaction: ChatInputCommandInteraction; replies(): FakeReplyPayload[]; lastText(): string }`,
    `interface FakeReplyPayload { content?: string; components?: unknown[]; flags?: number }`.

**Почему права проверяются в коде, а не через `setDefaultMemberPermissions`.** `/tournament` — одна команда с подкомандами и для организатора (`create`, `open`, `close`, `start`, `cancel`), и для участников (`join`, `leave`). `setDefaultMemberPermissions` действует на команду целиком, поэтому им нельзя закрыть половину подкоманд: закрыв команду правом «Управление сервером», мы отберём у участников возможность записаться. Отсюда `requireOrganizer` внутри обработчика — и тест на то, что без права она бросает `UserError`.

**Почему `defer` у обеих команд.** Каждая читает Postgres до первого ответа. Окно интеракции — три секунды, и медленный запрос его закроет.

- [ ] **Step 1: Дополнить `tests/helpers/interaction.ts`**

Существующий `fakeChatInputInteraction` не трогать — на нём стоят тесты этапов 0 и 1. Дописать в конец файла:

```ts
export interface FakeReplyPayload {
  content?: string;
  components?: unknown[];
  flags?: number;
}

export interface FakeCommandOptions {
  subcommand?: string;
  strings?: Record<string, string>;
  integers?: Record<string, number>;
  booleans?: Record<string, boolean>;
  channels?: Record<string, { id: string }>;
  users?: Record<string, { id: string; username?: string }>;
  /** Права участника, вызвавшего команду: список флагов PermissionFlagsBits. */
  permissions?: bigint[];
  userId?: string;
  username?: string;
  guildId?: string | null;
}

export interface FakeCommand {
  interaction: ChatInputCommandInteraction;
  /** Все ответы в порядке отправки: и reply, и followUp. */
  replies(): FakeReplyPayload[];
  /** Текст последнего ответа или пустая строка. */
  lastText(): string;
}

/**
 * Фейк интеракции с опциями. Ответы собираются в список, а не читаются из
 * mock.calls: индексный доступ к mock.calls при noUncheckedIndexedAccess требует
 * ручной распаковки и на нём уже спотыкались (TS2493 у нульарных vi.fn).
 */
export function fakeCommandInteraction(commandName: string, options: FakeCommandOptions = {}): FakeCommand {
  const state = { deferred: false, replied: false };
  const collected: FakeReplyPayload[] = [];
  const granted = options.permissions ?? [];

  const send = async (payload: FakeReplyPayload): Promise<void> => {
    state.replied = true;
    collected.push(payload);
  };

  const interaction = {
    commandName,
    id: '900000000000000003',
    guildId: options.guildId === undefined ? '111111111111111111' : options.guildId,
    user: { id: options.userId ?? '222222222222222222', username: options.username ?? 'tester' },
    memberPermissions: { has: (flag: bigint) => granted.includes(flag) },
    isChatInputCommand: () => true,
    deferReply: vi.fn<() => Promise<void>>(async () => {
      state.deferred = true;
    }),
    reply: vi.fn<(payload: FakeReplyPayload) => Promise<void>>(send),
    followUp: vi.fn<(payload: FakeReplyPayload) => Promise<void>>(send),
    get deferred() {
      return state.deferred;
    },
    get replied() {
      return state.replied;
    },
    options: {
      getSubcommand: (): string => {
        if (options.subcommand === undefined) throw new Error('подкоманда не задана в фейке');
        return options.subcommand;
      },
      getString: (name: string, required?: boolean): string | null => {
        const value = options.strings?.[name] ?? null;
        if (required === true && value === null) throw new Error(`опция ${name} обязательна`);
        return value;
      },
      getInteger: (name: string, required?: boolean): number | null => {
        const value = options.integers?.[name] ?? null;
        if (required === true && value === null) throw new Error(`опция ${name} обязательна`);
        return value;
      },
      getBoolean: (name: string): boolean | null => options.booleans?.[name] ?? null,
      getChannel: (name: string): { id: string } | null => options.channels?.[name] ?? null,
      getUser: (name: string, required?: boolean): { id: string; username?: string } | null => {
        const value = options.users?.[name] ?? null;
        if (required === true && value === null) throw new Error(`опция ${name} обязательна`);
        return value;
      },
    },
  } as unknown as ChatInputCommandInteraction;

  return {
    interaction,
    replies: () => [...collected],
    lastText: () => collected.at(-1)?.content ?? '',
  };
}
```

- [ ] **Step 2: Написать падающие тесты**

Файл `tests/modules/tournaments/commands/guards.test.ts`:

```ts
import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { UserError } from '../../../../src/core/errors.js';
import { requireGuild, requireOrganizer } from '../../../../src/modules/tournaments/commands/guards.js';
import { fakeCommandInteraction } from '../../../helpers/interaction.js';

describe('requireGuild', () => {
  it('отдаёт идентификатор сервера', () => {
    const { interaction } = fakeCommandInteraction('tournament', { guildId: '111111111111111111' });

    expect(requireGuild(interaction)).toBe('111111111111111111');
  });

  it('отвергает вызов в личных сообщениях', () => {
    const { interaction } = fakeCommandInteraction('tournament', { guildId: null });

    expect(() => requireGuild(interaction)).toThrow(/только на сервере/);
  });
});

describe('requireOrganizer', () => {
  it('пропускает того, у кого есть право «Управление сервером»', () => {
    const { interaction } = fakeCommandInteraction('tournament', {
      permissions: [PermissionFlagsBits.ManageGuild],
    });

    expect(() => requireOrganizer(interaction)).not.toThrow();
  });

  it('отвергает участника без этого права', () => {
    const { interaction } = fakeCommandInteraction('tournament', { permissions: [] });

    expect(() => requireOrganizer(interaction)).toThrow(UserError);
    expect(() => requireOrganizer(interaction)).toThrow(/Управление сервером/);
  });
});
```

Файл `tests/modules/tournaments/commands/bracket.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../../src/core/config.js';
import { createLogger } from '../../../../src/core/logger.js';
import type { ModuleContext } from '../../../../src/core/module.js';
import { createBracketCommand } from '../../../../src/modules/tournaments/commands/bracket.js';
import type { TournamentDeps } from '../../../../src/modules/tournaments/deps.js';
import type { ViewService } from '../../../../src/modules/tournaments/services/view.js';
import { fakeCommandInteraction } from '../../../helpers/interaction.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);
const ctx = { logger } as unknown as ModuleContext;

const BRACKET = {
  tournament: { id: 7, name: 'Кубок сервера' },
  size: 4,
  entrants: [
    { id: 1, displayName: 'Красные', seed: 1 },
    { id: 2, displayName: 'Синие', seed: 2 },
  ],
  matches: [
    {
      id: 11,
      round: 1,
      slot: 0,
      entrantAId: 1,
      entrantBId: 2,
      winnerEntrantId: null,
      state: 'ready' as const,
    },
  ],
};

function depsWith(bracketOf: ViewService['bracketOf']): TournamentDeps {
  return {
    view: { bracketOf },
    publicBaseUrl: 'https://bot.example.com',
  } as unknown as TournamentDeps;
}

describe('/bracket', () => {
  it('объявляет defer: команда читает базу до первого ответа', () => {
    const command = createBracketCommand(depsWith(vi.fn<ViewService['bracketOf']>()));

    expect(command.defer).toEqual({ ephemeral: true });
    expect(command.builder.name).toBe('bracket');
  });

  it('показывает сетку и ссылку на витрину', async () => {
    const bracketOf = vi.fn<ViewService['bracketOf']>(async () => BRACKET as never);
    const command = createBracketCommand(depsWith(bracketOf));
    const fake = fakeCommandInteraction('bracket', { integers: { tournament: 7 } });

    await command.execute(fake.interaction, ctx);

    expect(bracketOf).toHaveBeenCalledWith(7, '111111111111111111');
    expect(fake.lastText()).toContain('Кубок сервера');
    expect(fake.lastText()).toContain('#11');
    expect(fake.lastText()).toContain('https://bot.example.com/t/7');
  });

  it('отвергает вызов в личных сообщениях, не заглядывая в базу', async () => {
    const bracketOf = vi.fn<ViewService['bracketOf']>();
    const command = createBracketCommand(depsWith(bracketOf));
    const fake = fakeCommandInteraction('bracket', { integers: { tournament: 7 }, guildId: null });

    await expect(command.execute(fake.interaction, ctx)).rejects.toThrow(/только на сервере/);
    expect(bracketOf).not.toHaveBeenCalled();
  });
});
```

Файл `tests/modules/tournaments/commands/checkin.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../../src/core/config.js';
import { UserError } from '../../../../src/core/errors.js';
import { createLogger } from '../../../../src/core/logger.js';
import type { ModuleContext } from '../../../../src/core/module.js';
import { createCheckinCommand } from '../../../../src/modules/tournaments/commands/checkin.js';
import type { TournamentDeps } from '../../../../src/modules/tournaments/deps.js';
import type { RegistrationService } from '../../../../src/modules/tournaments/services/registration.js';
import { fakeCommandInteraction } from '../../../helpers/interaction.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);
const ctx = { logger } as unknown as ModuleContext;

function depsWith(checkIn: RegistrationService['checkIn']): TournamentDeps {
  return { registration: { checkIn } } as unknown as TournamentDeps;
}

describe('/checkin', () => {
  it('объявляет defer и называется checkin', () => {
    const command = createCheckinCommand(depsWith(vi.fn<RegistrationService['checkIn']>()));

    expect(command.defer).toEqual({ ephemeral: true });
    expect(command.builder.name).toBe('checkin');
  });

  it('отмечает участника и называет его в ответе', async () => {
    const checkIn = vi.fn<RegistrationService['checkIn']>(
      async () => ({ id: 5, displayName: 'Красные' }) as never,
    );
    const command = createCheckinCommand(depsWith(checkIn));
    const fake = fakeCommandInteraction('checkin', { integers: { tournament: 7 }, userId: '222222222222222222' });

    await command.execute(fake.interaction, ctx);

    expect(checkIn).toHaveBeenCalledWith({
      tournamentId: 7,
      guildId: '111111111111111111',
      userId: '222222222222222222',
    });
    expect(fake.lastText()).toContain('Красные');
  });

  it('пропускает наружу ошибку сервиса — её показывает роутер', async () => {
    const checkIn = vi.fn<RegistrationService['checkIn']>(async () => {
      throw new UserError('Ты не участвуешь в этом турнире.');
    });
    const command = createCheckinCommand(depsWith(checkIn));
    const fake = fakeCommandInteraction('checkin', { integers: { tournament: 7 } });

    await expect(command.execute(fake.interaction, ctx)).rejects.toThrow(/не участвуешь/);
  });
});
```

- [ ] **Step 3: Запустить тесты — убедиться, что падают**

Run: `npx vitest run tests/modules/tournaments/commands/`
Expected: FAIL — модули `guards.js`, `bracket.js`, `checkin.js` не найдены.

- [ ] **Step 4: Реализовать `src/modules/tournaments/deps.ts`**

```ts
import type { MatchesService } from './services/matches.js';
import type { RegistrationService } from './services/registration.js';
import type { StartService } from './services/start.js';
import type { TeamsService } from './services/teams.js';
import type { TournamentsService } from './services/tournaments.js';
import type { ViewService } from './services/view.js';

/**
 * Всё, что нужно командам модуля. Один тип на все команды, а не свой у каждой:
 * манифест собирает сервисы один раз и передаёт этот объект целиком.
 */
export interface TournamentDeps {
  tournaments: TournamentsService;
  registration: RegistrationService;
  teams: TeamsService;
  start: StartService;
  matches: MatchesService;
  view: ViewService;
  /** Для ссылки на витрину: `${publicBaseUrl}/t/${id}`. */
  publicBaseUrl: string;
}
```

- [ ] **Step 5: Реализовать `src/modules/tournaments/commands/guards.ts`**

```ts
import { PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';
import { UserError } from '../../../core/errors.js';

export function requireGuild(interaction: ChatInputCommandInteraction): string {
  const guildId = interaction.guildId;
  if (guildId === null) {
    throw new UserError('Эта команда работает только на сервере.');
  }
  return guildId;
}

/**
 * Право организатора проверяется здесь, а не через setDefaultMemberPermissions:
 * у `/tournament` подкоманды и организаторские, и участниковые, а флаг команды
 * действует на неё целиком — закрыв её, мы отобрали бы у участников `/tournament join`.
 */
export function requireOrganizer(interaction: ChatInputCommandInteraction): void {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) !== true) {
    throw new UserError('Эта подкоманда только для организаторов: нужно право «Управление сервером».');
  }
}
```

- [ ] **Step 6: Реализовать `src/modules/tournaments/commands/bracket.ts`**

```ts
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { CommandDefinition } from '../../../core/module.js';
import { renderBracket } from '../bracket/render.js';
import type { TournamentDeps } from '../deps.js';
import { requireGuild } from './guards.js';

export function createBracketCommand(deps: TournamentDeps): CommandDefinition {
  return {
    // Читает Postgres до первого ответа — defer обязателен.
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('bracket')
      .setDescription('Показать сетку турнира')
      .addIntegerOption((option) =>
        option.setName('tournament').setDescription('Номер турнира').setRequired(true).setMinValue(1),
      ),

    async execute(interaction) {
      const guildId = requireGuild(interaction);
      const tournamentId = interaction.options.getInteger('tournament', true);

      const bracket = await deps.view.bracketOf(tournamentId, guildId);
      const text = renderBracket({
        name: bracket.tournament.name,
        size: bracket.size,
        url: `${deps.publicBaseUrl}/t/${bracket.tournament.id}`,
        entrants: bracket.entrants,
        matches: bracket.matches,
      });

      await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
    },
  };
}
```

- [ ] **Step 7: Реализовать `src/modules/tournaments/commands/checkin.ts`**

```ts
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { CommandDefinition } from '../../../core/module.js';
import type { TournamentDeps } from '../deps.js';
import { requireGuild } from './guards.js';

export function createCheckinCommand(deps: TournamentDeps): CommandDefinition {
  return {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('checkin')
      .setDescription('Отметиться перед началом турнира')
      .addIntegerOption((option) =>
        option.setName('tournament').setDescription('Номер турнира').setRequired(true).setMinValue(1),
      ),

    async execute(interaction) {
      const guildId = requireGuild(interaction);
      const tournamentId = interaction.options.getInteger('tournament', true);

      const entrant = await deps.registration.checkIn({ tournamentId, guildId, userId: interaction.user.id });

      await interaction.followUp({
        content: `Отметил: **${entrant.displayName}**. Чек-ин на состав сетки не влияет — он нужен организатору, чтобы видеть, кто на месте.`,
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}
```

- [ ] **Step 8: Прогнать тесты**

Run: `npx vitest run tests/modules/tournaments/commands/ && npm run typecheck`
Expected: 10 тестов PASS (4 в `guards.test.ts`, 3 в `bracket.test.ts`, 3 в `checkin.test.ts`), тайпчек чистый.

- [ ] **Step 9: Коммит**

```bash
git add src/modules/tournaments/deps.ts src/modules/tournaments/commands/guards.ts src/modules/tournaments/commands/bracket.ts src/modules/tournaments/commands/checkin.ts tests/helpers/interaction.ts tests/modules/tournaments/commands/guards.test.ts tests/modules/tournaments/commands/bracket.test.ts tests/modules/tournaments/commands/checkin.test.ts
git commit -m "feat(tournaments): команды /bracket и /checkin, проверка прав организатора"
```

---

### Task 14: Кнопки подтверждения и спора

**Files:**
- Create: `src/modules/tournaments/buttons.ts`
- Modify: `tests/helpers/interaction.ts` — добавить `fakeButtonInteraction`
- Test: `tests/modules/tournaments/buttons.test.ts`

**Interfaces:**
- Consumes: `EventHandler`, `ModuleContext` из `src/core/module.ts`; `describeForUser` из `src/core/errors.ts`; `MatchesService` (Tasks 10-11).
- Produces:
  - `const CONFIRM_BUTTON_PREFIX = 'tmatch:confirm:'`
  - `const DISPUTE_BUTTON_PREFIX = 'tmatch:dispute:'`
  - `function matchButtonRow(matchId: number): ActionRowBuilder<ButtonBuilder>`
  - `function parseMatchButton(customId: string): { kind: 'confirm' | 'dispute'; matchId: number } | null`
  - `function createMatchButtonHandler(deps: { matches: MatchesService }): EventHandler<'interactionCreate'>`
  - `function fakeButtonInteraction(customId: string, options?: { userId?: string; guildId?: string | null }): FakeButton` в `tests/helpers/interaction.ts`, где `interface FakeButton { interaction: ButtonInteraction; replies(): FakeReplyPayload[]; lastText(): string }`.

**Почему обработчик кнопок живёт в модуле, а не в роутере ядра.** `src/core/commands/router.ts` обслуживает только `isChatInputCommand()` — это его контракт, и расширять ядро под нужды одного модуля нельзя. Модуль объявляет обычный `EventHandler<'interactionCreate'>`, который `src/index.ts` уже умеет подключать. Из этого следуют две обязанности, которых у команд нет: **свой `deferReply`** (роутер его не сделает) и **своя граница ошибок** — `src/index.ts` только логирует упавший обработчик события, и без перехвата пользователь увидит вечное «бот думает». Поэтому весь обработчик обёрнут в `try/catch` с `describeForUser`.

**Почему `customId` разбирается схемой, а не `Number(...)`.** `customId` приходит от клиента Discord и может быть чем угодно, включая обрезанный или подделанный. `Number('tmatch:confirm:')` даёт `NaN`, и `NaN` дошёл бы до запроса в базу. Поэтому `parseMatchButton` возвращает `null` на всём, что не является положительным целым, и обработчик молча выходит.

- [ ] **Step 1: Дополнить `tests/helpers/interaction.ts`**

Дописать в конец файла (типы `FakeReplyPayload` уже объявлены Task 13):

```ts
export interface FakeButton {
  interaction: ButtonInteraction;
  replies(): FakeReplyPayload[];
  lastText(): string;
}

/** Фейк нажатия кнопки. isButton() истинно, всё остальное — минимум, нужный обработчику. */
export function fakeButtonInteraction(
  customId: string,
  options: { userId?: string; guildId?: string | null } = {},
): FakeButton {
  const state = { deferred: false, replied: false };
  const collected: FakeReplyPayload[] = [];

  const send = async (payload: FakeReplyPayload): Promise<void> => {
    state.replied = true;
    collected.push(payload);
  };

  const interaction = {
    customId,
    id: '900000000000000004',
    guildId: options.guildId === undefined ? '111111111111111111' : options.guildId,
    user: { id: options.userId ?? '222222222222222222' },
    isButton: () => true,
    isChatInputCommand: () => false,
    deferReply: vi.fn<() => Promise<void>>(async () => {
      state.deferred = true;
    }),
    reply: vi.fn<(payload: FakeReplyPayload) => Promise<void>>(send),
    followUp: vi.fn<(payload: FakeReplyPayload) => Promise<void>>(send),
    get deferred() {
      return state.deferred;
    },
    get replied() {
      return state.replied;
    },
  } as unknown as ButtonInteraction;

  return { interaction, replies: () => [...collected], lastText: () => collected.at(-1)?.content ?? '' };
}
```

Импорт в шапке файла дополнить типом `ButtonInteraction`:

```ts
import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
```

- [ ] **Step 2: Написать падающий тест**

Файл `tests/modules/tournaments/buttons.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Interaction } from 'discord.js';
import type { Config } from '../../../src/core/config.js';
import { UserError } from '../../../src/core/errors.js';
import { createLogger } from '../../../src/core/logger.js';
import type { ModuleContext } from '../../../src/core/module.js';
import {
  CONFIRM_BUTTON_PREFIX,
  DISPUTE_BUTTON_PREFIX,
  createMatchButtonHandler,
  matchButtonRow,
  parseMatchButton,
} from '../../../src/modules/tournaments/buttons.js';
import type { MatchesService, SettleOutcome } from '../../../src/modules/tournaments/services/matches.js';
import { fakeButtonInteraction, fakeCommandInteraction } from '../../helpers/interaction.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);
/** Обработчику от контекста нужен только логгер — этот контекст для него полный. */
const ctx = { logger } as unknown as ModuleContext;

function outcome(changed: boolean): SettleOutcome {
  return {
    changed,
    match: { id: 42, tournamentId: 7, round: 1, slot: 0, winnerEntrantId: 3 },
    nextReady: null,
    championEntrantId: null,
  } as unknown as SettleOutcome;
}

function handlerWith(overrides: Partial<MatchesService>) {
  const matches = {
    confirm: vi.fn<MatchesService['confirm']>(async () => outcome(true)),
    dispute: vi.fn<MatchesService['dispute']>(async () => ({ id: 42 }) as never),
    ...overrides,
  } as unknown as MatchesService;
  return { matches, handler: createMatchButtonHandler({ matches }) };
}

describe('parseMatchButton', () => {
  it('разбирает подтверждение и спор', () => {
    expect(parseMatchButton(`${CONFIRM_BUTTON_PREFIX}42`)).toEqual({ kind: 'confirm', matchId: 42 });
    expect(parseMatchButton(`${DISPUTE_BUTTON_PREFIX}7`)).toEqual({ kind: 'dispute', matchId: 7 });
  });

  it('отвергает чужие и битые идентификаторы вместо NaN', () => {
    expect(parseMatchButton('rolemap:set')).toBeNull();
    expect(parseMatchButton(CONFIRM_BUTTON_PREFIX)).toBeNull();
    expect(parseMatchButton(`${CONFIRM_BUTTON_PREFIX}abc`)).toBeNull();
    expect(parseMatchButton(`${CONFIRM_BUTTON_PREFIX}0`)).toBeNull();
    expect(parseMatchButton(`${CONFIRM_BUTTON_PREFIX}-3`)).toBeNull();
    expect(parseMatchButton(`${CONFIRM_BUTTON_PREFIX}1.5`)).toBeNull();
  });
});

describe('matchButtonRow', () => {
  it('строит две кнопки с идентификаторами матча', () => {
    const json = matchButtonRow(42).toJSON();
    const ids = json.components.map((component) => ('custom_id' in component ? component.custom_id : ''));

    expect(ids).toEqual([`${CONFIRM_BUTTON_PREFIX}42`, `${DISPUTE_BUTTON_PREFIX}42`]);
  });
});

describe('обработчик нажатий', () => {
  it('пропускает интеракции, которые не нажатие кнопки', async () => {
    const { matches, handler } = handlerWith({});
    const fake = fakeCommandInteraction('bracket');

    await expect(handler.handle(ctx, fake.interaction as unknown as Interaction)).resolves.toBeUndefined();
    expect(matches.confirm).not.toHaveBeenCalled();
  });

  it('не реагирует на кнопки других модулей', async () => {
    const { matches, handler } = handlerWith({});
    const fake = fakeButtonInteraction('rolemap:set:1');

    await handler.handle(ctx, fake.interaction);

    expect(matches.confirm).not.toHaveBeenCalled();
    expect(fake.replies()).toHaveLength(0);
  });

  it('подтверждает матч от имени нажавшего', async () => {
    const { matches, handler } = handlerWith({});
    const fake = fakeButtonInteraction(`${CONFIRM_BUTTON_PREFIX}42`, { userId: '333333333333333333' });

    await handler.handle(ctx, fake.interaction);

    expect(matches.confirm).toHaveBeenCalledWith({ matchId: 42, userId: '333333333333333333' });
    expect(fake.interaction.deferred).toBe(true);
    expect(fake.lastText()).toContain('Результат подтверждён');
  });

  it('на повторное нажатие отвечает «уже подтверждён», а не ошибкой', async () => {
    const { handler } = handlerWith({ confirm: vi.fn<MatchesService['confirm']>(async () => outcome(false)) });
    const fake = fakeButtonInteraction(`${CONFIRM_BUTTON_PREFIX}42`);

    await handler.handle(ctx, fake.interaction);

    expect(fake.lastText()).toContain('уже подтверждён');
  });

  it('оспаривает матч и говорит, что решать будет организатор', async () => {
    const { matches, handler } = handlerWith({});
    const fake = fakeButtonInteraction(`${DISPUTE_BUTTON_PREFIX}42`, { userId: '444444444444444444' });

    await handler.handle(ctx, fake.interaction);

    expect(matches.dispute).toHaveBeenCalledWith({ matchId: 42, userId: '444444444444444444', reason: null });
    expect(fake.lastText()).toContain('организатор');
  });

  it('показывает текст UserError вместо того, чтобы упасть в шину событий', async () => {
    const { handler } = handlerWith({
      confirm: vi.fn<MatchesService['confirm']>(async () => {
        throw new UserError('Подтвердить результат должен кто-то из состава соперника.');
      }),
    });
    const fake = fakeButtonInteraction(`${CONFIRM_BUTTON_PREFIX}42`);

    await expect(handler.handle(ctx, fake.interaction)).resolves.toBeUndefined();

    expect(fake.lastText()).toContain('из состава соперника');
  });

  it('на нашу поломку отвечает кодом инцидента, а не молчанием', async () => {
    const { handler } = handlerWith({
      confirm: vi.fn<MatchesService['confirm']>(async () => {
        throw new Error('внутренняя поломка');
      }),
    });
    const fake = fakeButtonInteraction(`${CONFIRM_BUTTON_PREFIX}42`);

    await expect(handler.handle(ctx, fake.interaction)).resolves.toBeUndefined();

    expect(fake.lastText()).toContain('Код инцидента');
  });
});
```

- [ ] **Step 3: Запустить тест — убедиться, что падает**

Run: `npx vitest run tests/modules/tournaments/buttons.test.ts`
Expected: FAIL — модуль `buttons.js` не найден.

- [ ] **Step 4: Реализовать `src/modules/tournaments/buttons.ts`**

```ts
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { describeForUser } from '../../core/errors.js';
import type { EventHandler } from '../../core/module.js';
import type { MatchesService } from './services/matches.js';

export const CONFIRM_BUTTON_PREFIX = 'tmatch:confirm:';
export const DISPUTE_BUTTON_PREFIX = 'tmatch:dispute:';

export function matchButtonRow(matchId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CONFIRM_BUTTON_PREFIX}${matchId}`)
      .setLabel('Подтвердить')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${DISPUTE_BUTTON_PREFIX}${matchId}`)
      .setLabel('Оспорить')
      .setStyle(ButtonStyle.Danger),
  );
}

/**
 * customId приходит от клиента и может быть любым — обрезанным, подделанным, чужим.
 * Number('tmatch:confirm:') даёт NaN, и NaN дошёл бы до запроса в базу, поэтому
 * разбор здесь строгий: только положительное целое, иначе null.
 */
export function parseMatchButton(customId: string): { kind: 'confirm' | 'dispute'; matchId: number } | null {
  const kind = customId.startsWith(CONFIRM_BUTTON_PREFIX)
    ? ('confirm' as const)
    : customId.startsWith(DISPUTE_BUTTON_PREFIX)
      ? ('dispute' as const)
      : null;
  if (kind === null) return null;

  const raw = customId.slice((kind === 'confirm' ? CONFIRM_BUTTON_PREFIX : DISPUTE_BUTTON_PREFIX).length);
  if (!/^\d+$/.test(raw)) return null;

  const matchId = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(matchId) || matchId <= 0) return null;

  return { kind, matchId };
}

/**
 * Обработчик нажатий. Роутер ядра обслуживает только slash-команды, поэтому здесь
 * две обязанности, которых у команд нет:
 *  - свой deferReply: иначе окно интеракции в три секунды закроется на запросе к БД;
 *  - своя граница ошибок: src/index.ts упавший обработчик события только логирует,
 *    и без перехвата пользователь остался бы с вечным «бот думает».
 */
export function createMatchButtonHandler(deps: { matches: MatchesService }): EventHandler<'interactionCreate'> {
  return {
    event: 'interactionCreate',

    async handle(ctx, interaction): Promise<void> {
      if (!interaction.isButton()) return;

      const parsed = parseMatchButton(interaction.customId);
      // Чужая кнопка — не наша забота: молча выходим, её обработает свой модуль.
      if (parsed === null) return;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        if (parsed.kind === 'confirm') {
          const outcome = await deps.matches.confirm({ matchId: parsed.matchId, userId: interaction.user.id });
          await interaction.followUp({
            content: outcome.changed
              ? 'Результат подтверждён, победитель прошёл в следующий круг.'
              : 'Этот результат уже подтверждён — второе нажатие ничего не меняет.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await deps.matches.dispute({ matchId: parsed.matchId, userId: interaction.user.id, reason: null });
        await interaction.followUp({
          content: 'Матч отмечен спорным. Бот такие матчи не решает — победителя назначит организатор.',
          flags: MessageFlags.Ephemeral,
        });
      } catch (error) {
        const described = describeForUser(error);
        if (described.incidentId) {
          ctx.logger.error(
            { err: error, incidentId: described.incidentId, matchId: parsed.matchId },
            'обработка нажатия кнопки матча упала',
          );
        } else {
          ctx.logger.info({ err: error, matchId: parsed.matchId }, 'нажатие кнопки матча отклонено');
        }
        await interaction.followUp({ content: described.text, flags: MessageFlags.Ephemeral });
      }
    },
  };
}
```

- [ ] **Step 5: Прогнать тесты**

Run: `npx vitest run tests/modules/tournaments/buttons.test.ts && npm run typecheck`
Expected: 10 тестов PASS (2 в `parseMatchButton`, 1 в `matchButtonRow`, 7 в «обработчик нажатий»), тайпчек чистый.

Если тайпчек ругается на присвоение `EventHandler<'interactionCreate'>` в массив `EventHandler[]` манифеста (Task 19), причина не здесь: `handle` объявлен методом, и методы в TypeScript биваринтны даже при `strictFunctionTypes`, поэтому присвоение законно. Ошибка в этом месте означала бы, что `handle` где-то переписали в виде свойства-стрелки — так делать не надо.

- [ ] **Step 6: Коммит**

```bash
git add src/modules/tournaments/buttons.ts tests/helpers/interaction.ts tests/modules/tournaments/buttons.test.ts
git commit -m "feat(tournaments): кнопки подтверждения и спора со своим defer и своей границей ошибок"
```

---

### Task 15: Ветки под матчи, объявления и адаптер Discord

**Files:**
- Create: `src/modules/tournaments/discord/gateway.ts`, `src/modules/tournaments/services/announce.ts`
- Test: `tests/modules/tournaments/discord/gateway.test.ts`, `tests/integration/tournaments/announce.test.ts`

**Interfaces:**
- Consumes: `Client`, `Logger`, `Database`; схема (Task 1); `matchButtonRow` (Task 14).
- Produces:
  - `interface DiscordGateway { createMatchThread(input: { parentChannelId: string; name: string; memberUserIds: readonly string[] }): Promise<string | null>; archiveThread(threadId: string): Promise<void>; post(input: { channelId: string; content: string; matchButtonsFor?: number }): Promise<void>; notifyUser(userId: string, content: string): Promise<void> }`
  - `function createDiscordGateway(deps: { client: Client; logger: Logger }): DiscordGateway`
  - `interface AnnounceService { openMatches(input: { tournamentId: number; matchIds: readonly number[] }): Promise<{ created: number; failed: number; skipped: number }>; postReport(input: { matchId: number; content: string }): Promise<void>; archiveMatch(matchId: number): Promise<void>; announce(input: { tournamentId: number; content: string }): Promise<void> }`
  - `function createAnnounceService(deps: { db: Database; gateway: DiscordGateway; logger: Logger }): AnnounceService`

**Ветка — удобство, а не носитель состояния.** Ни один сбой Discord не должен отменять записанный результат, поэтому:
- `createMatchThread` возвращает `null` вместо исключения — матч создан и играется без ветки;
- `post`, `archiveThread` и `notifyUser` ничего не бросают: отказ логируется;
- `AnnounceService` **дополнительно** оборачивает каждый вызов шлюза в `try/catch`. Это не паранойя: сервис не должен зависеть от вежливости конкретной реализации шлюза, а тест обязан проверить именно это — заглушка шлюза в тесте **бросает**, и `openMatches` всё равно возвращается со счётчиком `failed`, не срывая обработку остальных матчей.

**Почему ветка, а не канал.** Ветки дешевле по лимитам Discord, сами архивируются и не превращают список каналов сервера в свалку после турнира на 32 команды. Приватная ветка (`ChannelType.PrivateThread`) не видна тем, кто в матче не играет.

- [ ] **Step 1: Написать падающий тест адаптера**

Файл `tests/modules/tournaments/discord/gateway.test.ts`:

```ts
import type { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../../src/core/config.js';
import { createLogger } from '../../../../src/core/logger.js';
import { createDiscordGateway } from '../../../../src/modules/tournaments/discord/gateway.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

interface Sent {
  content?: string;
  components?: unknown[];
}

function clientWith(overrides: {
  threadCreate?: () => Promise<unknown>;
  memberAdd?: (userId: string) => Promise<void>;
  channelFetch?: () => Promise<unknown>;
  setArchived?: () => Promise<void>;
}) {
  const sent: Sent[] = [];
  const added: string[] = [];

  const thread = {
    id: '600000000000000001',
    isThread: () => true,
    isTextBased: () => true,
    send: vi.fn<(payload: Sent) => Promise<void>>(async (payload) => {
      sent.push(payload);
    }),
    setArchived: overrides.setArchived ?? vi.fn<() => Promise<void>>(async () => {}),
    members: {
      add:
        overrides.memberAdd ??
        (async (userId: string) => {
          added.push(userId);
        }),
    },
  };

  const parent = {
    id: '600000000000000002',
    isThread: () => false,
    isTextBased: () => true,
    threads: { create: overrides.threadCreate ?? (async () => thread) },
    send: vi.fn<(payload: Sent) => Promise<void>>(async (payload) => {
      sent.push(payload);
    }),
  };

  const client = {
    channels: { fetch: overrides.channelFetch ?? (async () => parent) },
    users: { fetch: async () => ({ send: async () => {} }) },
  } as unknown as Client;

  return { client, sent, added, thread, parent };
}

describe('createDiscordGateway.createMatchThread', () => {
  it('создаёт приватную ветку и добавляет обоих игроков', async () => {
    const fake = clientWith({});
    const gateway = createDiscordGateway({ client: fake.client, logger });

    const threadId = await gateway.createMatchThread({
      parentChannelId: '600000000000000002',
      name: 'Матч #1: Красные — Синие',
      memberUserIds: ['222222222222222222', '333333333333333333'],
    });

    expect(threadId).toBe('600000000000000001');
    expect(fake.added).toEqual(['222222222222222222', '333333333333333333']);
  });

  it('возвращает null, когда создать ветку не удалось', async () => {
    const fake = clientWith({
      threadCreate: async () => {
        throw new Error('Missing Permissions');
      },
    });
    const gateway = createDiscordGateway({ client: fake.client, logger });

    await expect(
      gateway.createMatchThread({ parentChannelId: '600000000000000002', name: 'Матч', memberUserIds: [] }),
    ).resolves.toBeNull();
  });

  it('не теряет ветку из-за одного не добавленного игрока', async () => {
    const fake = clientWith({
      memberAdd: async (userId: string) => {
        if (userId === '333333333333333333') throw new Error('Cannot add user');
      },
    });
    const gateway = createDiscordGateway({ client: fake.client, logger });

    const threadId = await gateway.createMatchThread({
      parentChannelId: '600000000000000002',
      name: 'Матч',
      memberUserIds: ['222222222222222222', '333333333333333333'],
    });

    expect(threadId).toBe('600000000000000001');
  });

  it('возвращает null, когда канал не найден', async () => {
    const fake = clientWith({
      channelFetch: async () => {
        throw new Error('Unknown Channel');
      },
    });
    const gateway = createDiscordGateway({ client: fake.client, logger });

    await expect(
      gateway.createMatchThread({ parentChannelId: '600000000000000009', name: 'Матч', memberUserIds: [] }),
    ).resolves.toBeNull();
  });
});

describe('createDiscordGateway.post и archiveThread', () => {
  it('отправляет сообщение с кнопками матча', async () => {
    const fake = clientWith({});
    const gateway = createDiscordGateway({ client: fake.client, logger });

    await gateway.post({ channelId: '600000000000000002', content: 'Результат заявлен', matchButtonsFor: 42 });

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.content).toBe('Результат заявлен');
    expect(fake.sent[0]?.components).toHaveLength(1);
  });

  it('не бросает, когда архивация не удалась', async () => {
    const fake = clientWith({
      setArchived: async () => {
        throw new Error('Missing Access');
      },
      channelFetch: async () => ({
        id: '600000000000000001',
        isThread: () => true,
        isTextBased: () => true,
        setArchived: async () => {
          throw new Error('Missing Access');
        },
      }),
    });
    const gateway = createDiscordGateway({ client: fake.client, logger });

    await expect(gateway.archiveThread('600000000000000001')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Написать падающий тест сервиса объявлений**

Файл `tests/integration/tournaments/announce.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { EventBus } from '../../../src/core/events/bus.js';
import { createLogger } from '../../../src/core/logger.js';
import type { DiscordGateway } from '../../../src/modules/tournaments/discord/gateway.js';
import {
  tournamentEntrantMembers,
  tournamentEntrants,
  tournamentMatches,
} from '../../../src/modules/tournaments/schema.js';
import { createAnnounceService } from '../../../src/modules/tournaments/services/announce.js';
import { createTournamentsService } from '../../../src/modules/tournaments/services/tournaments.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

const GUILD = '140000000000000001';
const PARENT = '140000000000000002';
const ANNOUNCE = '140000000000000003';
const A1 = '141000000000000001';
const A2 = '141000000000000002';
const B1 = '141000000000000003';
const B2 = '141000000000000004';

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} отсутствует`);
  return value;
}

interface GatewayCalls {
  threads: Array<{ parentChannelId: string; name: string; memberUserIds: readonly string[] }>;
  posts: Array<{ channelId: string; content: string; matchButtonsFor?: number }>;
  archived: string[];
}

function gatewayStub(
  overrides: Partial<DiscordGateway> = {},
): { gateway: DiscordGateway; calls: GatewayCalls } {
  const calls: GatewayCalls = { threads: [], posts: [], archived: [] };
  const gateway: DiscordGateway = {
    createMatchThread: vi.fn<DiscordGateway['createMatchThread']>(async (input) => {
      calls.threads.push(input);
      return `thread-${calls.threads.length}`;
    }),
    post: vi.fn<DiscordGateway['post']>(async (input) => {
      calls.posts.push(input);
    }),
    archiveThread: vi.fn<DiscordGateway['archiveThread']>(async (threadId) => {
      calls.archived.push(threadId);
    }),
    notifyUser: vi.fn<DiscordGateway['notifyUser']>(async () => {}),
    ...overrides,
  };
  return { gateway, calls };
}

let counter = 0;

interface Fixture {
  tournamentId: number;
  matchId: number;
}

async function tournamentWithMatch(channels: {
  matchParentId: string | null;
  announceChannelId: string | null;
}): Promise<Fixture> {
  counter += 1;
  const bus = new EventBus(logger);
  const tournamentsService = createTournamentsService({ db: pg.db, bus });
  const { tournament } = await tournamentsService.create({
    guildId: GUILD,
    name: `Объявления ${counter}`,
    game: 'other',
    entryMode: 'team',
    teamSize: 2,
    maxEntrants: 4,
    seeding: 'random',
    bestOf: 1,
    requireVerified: false,
    createdBy: A1,
    announceChannelId: channels.announceChannelId,
    matchParentId: channels.matchParentId,
  });

  const first = required(
    (
      await pg.db
        .insert(tournamentEntrants)
        .values({ tournamentId: tournament.id, displayName: 'Красные', captainUserId: A1, seed: 1 })
        .returning()
    )[0],
    'первая команда',
  );
  const second = required(
    (
      await pg.db
        .insert(tournamentEntrants)
        .values({ tournamentId: tournament.id, displayName: 'Синие', captainUserId: B1, seed: 2 })
        .returning()
    )[0],
    'вторая команда',
  );
  await pg.db.insert(tournamentEntrantMembers).values([
    { entrantId: first.id, tournamentId: tournament.id, userId: A1, role: 'captain' },
    { entrantId: first.id, tournamentId: tournament.id, userId: A2, role: 'player' },
    { entrantId: second.id, tournamentId: tournament.id, userId: B1, role: 'captain' },
    { entrantId: second.id, tournamentId: tournament.id, userId: B2, role: 'player' },
  ]);

  const match = required(
    (
      await pg.db
        .insert(tournamentMatches)
        .values({
          tournamentId: tournament.id,
          round: 1,
          slot: 0,
          entrantAId: first.id,
          entrantBId: second.id,
          state: 'ready',
        })
        .returning()
    )[0],
    'матч',
  );

  return { tournamentId: tournament.id, matchId: match.id };
}

beforeEach(async () => {
  const bus = new EventBus(logger);
  const tournamentsService = createTournamentsService({ db: pg.db, bus });
  await tournamentsService.ensureGuild(GUILD);
  for (const userId of [A1, A2, B1, B2]) await tournamentsService.ensureUser(userId);
});

describe('openMatches', () => {
  it('создаёт ветку под матч, зовёт в неё всех игроков и запоминает её id', async () => {
    const { gateway, calls } = gatewayStub();
    const service = createAnnounceService({ db: pg.db, gateway, logger });
    const fixture = await tournamentWithMatch({ matchParentId: PARENT, announceChannelId: ANNOUNCE });

    const result = await service.openMatches({ tournamentId: fixture.tournamentId, matchIds: [fixture.matchId] });

    expect(result).toEqual({ created: 1, failed: 0, skipped: 0 });
    expect(calls.threads[0]?.parentChannelId).toBe(PARENT);
    expect(calls.threads[0]?.name).toContain('Красные');
    expect([...(calls.threads[0]?.memberUserIds ?? [])].sort()).toEqual([A1, A2, B1, B2].sort());
    const [match] = await pg.db.select().from(tournamentMatches).where(eq(tournamentMatches.id, fixture.matchId));
    expect(match?.threadId).toBe('thread-1');
  });

  it('матч остаётся играбельным, когда ветку создать не удалось', async () => {
    const { gateway } = gatewayStub({
      createMatchThread: vi.fn<DiscordGateway['createMatchThread']>(async () => null),
    });
    const service = createAnnounceService({ db: pg.db, gateway, logger });
    const fixture = await tournamentWithMatch({ matchParentId: PARENT, announceChannelId: ANNOUNCE });

    const result = await service.openMatches({ tournamentId: fixture.tournamentId, matchIds: [fixture.matchId] });

    expect(result).toEqual({ created: 0, failed: 1, skipped: 0 });
    const [match] = await pg.db.select().from(tournamentMatches).where(eq(tournamentMatches.id, fixture.matchId));
    expect(match?.threadId).toBeNull();
    expect(match?.state).toBe('ready');
  });

  it('не срывается на исключении шлюза', async () => {
    const { gateway } = gatewayStub({
      createMatchThread: vi.fn<DiscordGateway['createMatchThread']>(async () => {
        throw new Error('Discord упал');
      }),
    });
    const service = createAnnounceService({ db: pg.db, gateway, logger });
    const fixture = await tournamentWithMatch({ matchParentId: PARENT, announceChannelId: ANNOUNCE });

    const result = await service.openMatches({ tournamentId: fixture.tournamentId, matchIds: [fixture.matchId] });

    expect(result).toEqual({ created: 0, failed: 1, skipped: 0 });
  });

  it('не создаёт ветку, когда канал для веток не настроен', async () => {
    const { gateway, calls } = gatewayStub();
    const service = createAnnounceService({ db: pg.db, gateway, logger });
    const fixture = await tournamentWithMatch({ matchParentId: null, announceChannelId: ANNOUNCE });

    const result = await service.openMatches({ tournamentId: fixture.tournamentId, matchIds: [fixture.matchId] });

    expect(result).toEqual({ created: 0, failed: 0, skipped: 1 });
    expect(calls.threads).toHaveLength(0);
  });
});

describe('postReport', () => {
  it('пишет в ветку матча и добавляет кнопки', async () => {
    const { gateway, calls } = gatewayStub();
    const service = createAnnounceService({ db: pg.db, gateway, logger });
    const fixture = await tournamentWithMatch({ matchParentId: PARENT, announceChannelId: ANNOUNCE });
    await service.openMatches({ tournamentId: fixture.tournamentId, matchIds: [fixture.matchId] });

    await service.postReport({ matchId: fixture.matchId, content: 'Красные заявили победу' });

    const last = calls.posts.at(-1);
    expect(last?.channelId).toBe('thread-1');
    expect(last?.matchButtonsFor).toBe(fixture.matchId);
  });

  it('пишет в канал объявлений, когда ветки нет', async () => {
    const { gateway, calls } = gatewayStub();
    const service = createAnnounceService({ db: pg.db, gateway, logger });
    const fixture = await tournamentWithMatch({ matchParentId: null, announceChannelId: ANNOUNCE });

    await service.postReport({ matchId: fixture.matchId, content: 'Красные заявили победу' });

    expect(calls.posts.at(-1)?.channelId).toBe(ANNOUNCE);
  });

  it('молчит, когда нет ни ветки, ни канала объявлений', async () => {
    const { gateway, calls } = gatewayStub();
    const service = createAnnounceService({ db: pg.db, gateway, logger });
    const fixture = await tournamentWithMatch({ matchParentId: null, announceChannelId: null });

    await expect(service.postReport({ matchId: fixture.matchId, content: 'что-то' })).resolves.toBeUndefined();
    expect(calls.posts).toHaveLength(0);
  });
});

describe('archiveMatch и announce', () => {
  it('архивирует ветку матча', async () => {
    const { gateway, calls } = gatewayStub();
    const service = createAnnounceService({ db: pg.db, gateway, logger });
    const fixture = await tournamentWithMatch({ matchParentId: PARENT, announceChannelId: ANNOUNCE });
    await service.openMatches({ tournamentId: fixture.tournamentId, matchIds: [fixture.matchId] });

    await service.archiveMatch(fixture.matchId);

    expect(calls.archived).toEqual(['thread-1']);
  });

  it('не падает, когда архивация не удалась', async () => {
    const { gateway } = gatewayStub({
      archiveThread: vi.fn<DiscordGateway['archiveThread']>(async () => {
        throw new Error('Missing Access');
      }),
    });
    const service = createAnnounceService({ db: pg.db, gateway, logger });
    const fixture = await tournamentWithMatch({ matchParentId: PARENT, announceChannelId: ANNOUNCE });
    await service.openMatches({ tournamentId: fixture.tournamentId, matchIds: [fixture.matchId] });

    await expect(service.archiveMatch(fixture.matchId)).resolves.toBeUndefined();
  });

  it('отправляет объявление в канал турнира и молчит, когда канала нет', async () => {
    const { gateway, calls } = gatewayStub();
    const service = createAnnounceService({ db: pg.db, gateway, logger });
    const withChannel = await tournamentWithMatch({ matchParentId: PARENT, announceChannelId: ANNOUNCE });
    const without = await tournamentWithMatch({ matchParentId: PARENT, announceChannelId: null });

    await service.announce({ tournamentId: withChannel.tournamentId, content: 'Круг 1 начался' });
    await service.announce({ tournamentId: without.tournamentId, content: 'Круг 1 начался' });

    expect(calls.posts).toHaveLength(1);
    expect(calls.posts[0]).toMatchObject({ channelId: ANNOUNCE, content: 'Круг 1 начался' });
  });
});
```

- [ ] **Step 3: Запустить тесты — убедиться, что падают**

Run: `npx vitest run tests/modules/tournaments/discord/gateway.test.ts`
Expected: FAIL — модуль `gateway.js` не найден.

Run: `npm run test:int -- tests/integration/tournaments/announce.test.ts`
Expected: FAIL — модуль `announce.js` не найден.

- [ ] **Step 4: Реализовать `src/modules/tournaments/discord/gateway.ts`**

```ts
import { ChannelType, ThreadAutoArchiveDuration, type Client, type TextChannel, type ThreadChannel } from 'discord.js';
import type { Logger } from '../../../core/logger.js';
import { matchButtonRow } from '../buttons.js';

/** Предел Discord на имя ветки. */
const THREAD_NAME_LIMIT = 100;

export interface DiscordGateway {
  /** null — создать не удалось. Причина уже в логе; матч играется без ветки. */
  createMatchThread(input: {
    parentChannelId: string;
    name: string;
    memberUserIds: readonly string[];
  }): Promise<string | null>;
  archiveThread(threadId: string): Promise<void>;
  post(input: { channelId: string; content: string; matchButtonsFor?: number }): Promise<void>;
  notifyUser(userId: string, content: string): Promise<void>;
}

/**
 * Единственное место модуля, знающее discord.js. Ни один метод не бросает: отказ
 * Discord (нет прав, исчерпан лимит веток, канал удалён) не должен отменять уже
 * записанный результат матча.
 */
export function createDiscordGateway(deps: { client: Client; logger: Logger }): DiscordGateway {
  const { client, logger } = deps;

  /** Канал, в котором можно создавать ветки. Ветка сама таким каналом не является. */
  async function threadParent(channelId: string): Promise<TextChannel | null> {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('threads' in channel)) return null;
      return channel as TextChannel;
    } catch (error) {
      logger.warn({ err: error, channelId }, 'канал для веток матчей недоступен');
      return null;
    }
  }

  /** Всё, куда можно отправить сообщение: и обычный канал, и ветка. */
  async function sendable(channelId: string): Promise<{ send: TextChannel['send'] } | null> {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('send' in channel)) return null;
      return channel as unknown as { send: TextChannel['send'] };
    } catch (error) {
      logger.warn({ err: error, channelId }, 'канал для сообщения недоступен');
      return null;
    }
  }

  return {
    async createMatchThread(input): Promise<string | null> {
      const parent = await threadParent(input.parentChannelId);
      if (!parent) return null;

      try {
        const thread = await parent.threads.create({
          name: input.name.slice(0, THREAD_NAME_LIMIT),
          // Приватная: тем, кто в матче не играет, там делать нечего.
          type: ChannelType.PrivateThread,
          invitable: false,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          reason: 'матч турнира',
        });

        for (const userId of input.memberUserIds) {
          try {
            await thread.members.add(userId);
          } catch (error) {
            // Один не добавленный игрок не повод выбрасывать ветку целиком.
            logger.warn({ err: error, userId, threadId: thread.id }, 'не удалось добавить игрока в ветку матча');
          }
        }

        return thread.id;
      } catch (error) {
        logger.warn({ err: error, parentChannelId: input.parentChannelId }, 'не удалось создать ветку под матч');
        return null;
      }
    },

    async archiveThread(threadId): Promise<void> {
      try {
        const channel = await client.channels.fetch(threadId);
        if (!channel || !channel.isThread()) return;
        await (channel as ThreadChannel).setArchived(true, 'матч завершён');
      } catch (error) {
        logger.warn({ err: error, threadId }, 'не удалось заархивировать ветку матча');
      }
    },

    async post(input): Promise<void> {
      const channel = await sendable(input.channelId);
      if (!channel) return;

      try {
        await channel.send({
          content: input.content,
          ...(input.matchButtonsFor === undefined
            ? {}
            : { components: [matchButtonRow(input.matchButtonsFor)] }),
        });
      } catch (error) {
        logger.warn({ err: error, channelId: input.channelId }, 'не удалось отправить сообщение турнира');
      }
    },

    async notifyUser(userId, content): Promise<void> {
      try {
        const user = await client.users.fetch(userId);
        await user.send(content);
      } catch (error) {
        // Личные сообщения могут быть закрыты — это не ошибка бота.
        logger.info({ err: error, userId }, 'личное сообщение о турнире не доставлено');
      }
    },
  };
}
```

- [ ] **Step 5: Реализовать `src/modules/tournaments/services/announce.ts`**

```ts
import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../../../core/db/client.js';
import type { Logger } from '../../../core/logger.js';
import type { DiscordGateway } from '../discord/gateway.js';
import { tournamentEntrantMembers, tournamentEntrants, tournamentMatches, tournaments } from '../schema.js';

export interface AnnounceService {
  /**
   * Создаёт ветки под матчи. created — сколько создано, failed — сколько не удалось
   * (матчи при этом играются), skipped — сколько пропущено, потому что канал для
   * веток не настроен.
   */
  openMatches(input: {
    tournamentId: number;
    matchIds: readonly number[];
  }): Promise<{ created: number; failed: number; skipped: number }>;
  /** Сообщение о заявленном результате с кнопками — в ветку, иначе в канал объявлений. */
  postReport(input: { matchId: number; content: string }): Promise<void>;
  archiveMatch(matchId: number): Promise<void>;
  announce(input: { tournamentId: number; content: string }): Promise<void>;
}

export function createAnnounceService(deps: {
  db: Database;
  gateway: DiscordGateway;
  logger: Logger;
}): AnnounceService {
  const { db, gateway, logger } = deps;

  /**
   * Каждый вызов шлюза обёрнут здесь дополнительно. Сама реализация шлюза ничего не
   * бросает, но сервис не должен на это опираться: гарантия «отказ Discord не
   * отменяет результат» обязана держаться и на шлюзе, который бросает.
   */
  async function guarded<T>(what: string, action: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await action();
    } catch (error) {
      logger.warn({ err: error }, `${what}: обращение к Discord не удалось`);
      return fallback;
    }
  }

  async function nameOf(entrantId: number | null): Promise<string> {
    if (entrantId === null) return '?';
    const [row] = await db
      .select({ displayName: tournamentEntrants.displayName })
      .from(tournamentEntrants)
      .where(eq(tournamentEntrants.id, entrantId));
    return row?.displayName ?? '?';
  }

  async function membersOfMatch(match: { entrantAId: number | null; entrantBId: number | null }): Promise<string[]> {
    const entrantIds = [match.entrantAId, match.entrantBId].filter((id): id is number => id !== null);
    if (entrantIds.length === 0) return [];

    const rows = await db
      .select({ userId: tournamentEntrantMembers.userId })
      .from(tournamentEntrantMembers)
      .where(inArray(tournamentEntrantMembers.entrantId, entrantIds));
    return rows.map((row) => row.userId);
  }

  return {
    async openMatches(input): Promise<{ created: number; failed: number; skipped: number }> {
      if (input.matchIds.length === 0) return { created: 0, failed: 0, skipped: 0 };

      const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, input.tournamentId));
      if (!tournament) return { created: 0, failed: 0, skipped: 0 };

      const matches = await db
        .select()
        .from(tournamentMatches)
        .where(inArray(tournamentMatches.id, [...input.matchIds]));

      let created = 0;
      let failed = 0;
      let skipped = 0;

      for (const match of matches) {
        const parentChannelId = tournament.matchParentId;
        if (parentChannelId === null) {
          skipped += 1;
          continue;
        }
        if (match.threadId !== null) {
          // Ветка уже есть: повторная доставка match.ready не должна плодить ветки.
          skipped += 1;
          continue;
        }

        const name = `Матч #${match.id}: ${await nameOf(match.entrantAId)} — ${await nameOf(match.entrantBId)}`;
        const memberUserIds = await membersOfMatch(match);

        const threadId = await guarded(
          'создание ветки матча',
          () => gateway.createMatchThread({ parentChannelId, name, memberUserIds }),
          null,
        );

        if (threadId === null) {
          // Ветка — удобство, а не носитель состояния: матч остаётся играбельным.
          failed += 1;
          logger.warn({ matchId: match.id }, 'матч играется без ветки');
          continue;
        }

        await db.update(tournamentMatches).set({ threadId }).where(eq(tournamentMatches.id, match.id));
        await guarded(
          'приглашение в ветку матча',
          () =>
            gateway.post({
              channelId: threadId,
              content: `${name}\nКогда доиграете, победитель вызывает \`/match report\`, соперник подтверждает. Через час без ответа результат подтвердится сам.`,
            }),
          undefined,
        );
        created += 1;
      }

      return { created, failed, skipped };
    },

    async postReport(input): Promise<void> {
      const [match] = await db.select().from(tournamentMatches).where(eq(tournamentMatches.id, input.matchId));
      if (!match) return;

      const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, match.tournamentId));
      // Ветка предпочтительнее: там уже собраны оба состава. Нет ветки — канал
      // объявлений. Нет и его — писать некуда, и это не ошибка.
      const channelId = match.threadId ?? tournament?.announceChannelId ?? null;
      if (channelId === null) return;

      await guarded(
        'сообщение о заявленном результате',
        () => gateway.post({ channelId, content: input.content, matchButtonsFor: match.id }),
        undefined,
      );
    },

    async archiveMatch(matchId): Promise<void> {
      const [match] = await db.select().from(tournamentMatches).where(eq(tournamentMatches.id, matchId));
      const threadId = match?.threadId ?? null;
      if (threadId === null) return;

      await guarded('архивация ветки матча', () => gateway.archiveThread(threadId), undefined);
    },

    async announce(input): Promise<void> {
      const [tournament] = await db.select().from(tournaments).where(eq(tournaments.id, input.tournamentId));
      const channelId = tournament?.announceChannelId ?? null;
      if (channelId === null) return;

      await guarded('объявление турнира', () => gateway.post({ channelId, content: input.content }), undefined);
    },
  };
}
```

- [ ] **Step 6: Прогнать тесты**

Run: `npx vitest run tests/modules/tournaments/discord/gateway.test.ts && npm run test:int -- tests/integration/tournaments/announce.test.ts && npm run typecheck`
Expected: 6 тестов PASS в `gateway.test.ts` (4 в блоке `createMatchThread`, 2 в блоке `post и archiveThread`), 10 тестов PASS в `announce.test.ts` (4 + 3 + 3 по describe-блокам), тайпчек чистый.

- [ ] **Step 7: Коммит**

```bash
git add src/modules/tournaments/discord/gateway.ts src/modules/tournaments/services/announce.ts tests/modules/tournaments/discord/gateway.test.ts tests/integration/tournaments/announce.test.ts
git commit -m "feat(tournaments): ветки под матчи и объявления, отказ Discord не отменяет результат"
```

---

### Task 16: Команда `/tournament`

**Files:**
- Create: `src/modules/tournaments/commands/tournament.ts`
- Test: `tests/modules/tournaments/commands/tournament.test.ts`

**Interfaces:**
- Consumes: `CommandDefinition`, `UserError`; `TournamentDeps` и `requireGuild`, `requireOrganizer` (Task 13); `TOURNAMENT_GAME_CHOICES`, `isTournamentGame` (Task 2); `TournamentsService` (Task 6), `RegistrationService` (Task 7), `StartService` (Task 9).
- Produces: `function createTournamentCommand(deps: TournamentDeps): CommandDefinition` — команда `tournament` с подкомандами `create`, `open`, `close`, `start`, `cancel`, `join`, `leave`.

**Три вещи, которые легко сделать неправильно.**

*`setDefaultMemberPermissions` здесь не ставится.* Он действует на команду целиком, а `join` и `leave` — для всех. Право организатора проверяется `requireOrganizer` внутри обработчика, и вызывается он **после** ветвления на `join`/`leave`, иначе участник получит отказ на своей же подкоманде.

*Значения опций проверяются, а не приводятся приведением типа.* Discord ограничивает выбор списком, но интеракция приходит по сети, и `as TournamentGame` на строке из сети — это ложь компилятору. Поэтому `isTournamentGame` и явные сравнения для режима и жеребьёвки.

*Команда не создаёт ветки и не пишет объявления.* Она вызывает сервис и отвечает. Ветки под матчи первого круга создаёт подписчик `match.ready` (Task 19) — так отказ Discord не может ни сорвать старт, ни оказаться внутри транзакции.

- [ ] **Step 1: Написать падающий тест**

Файл `tests/modules/tournaments/commands/tournament.test.ts`:

```ts
import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../../src/core/config.js';
import { UserError } from '../../../../src/core/errors.js';
import { createLogger } from '../../../../src/core/logger.js';
import type { ModuleContext } from '../../../../src/core/module.js';
import { createTournamentCommand } from '../../../../src/modules/tournaments/commands/tournament.js';
import type { TournamentDeps } from '../../../../src/modules/tournaments/deps.js';
import type { RegistrationService } from '../../../../src/modules/tournaments/services/registration.js';
import type { StartService } from '../../../../src/modules/tournaments/services/start.js';
import type { TournamentsService } from '../../../../src/modules/tournaments/services/tournaments.js';
import { fakeCommandInteraction } from '../../../helpers/interaction.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);
const ctx = { logger } as unknown as ModuleContext;
const ORGANIZER = [PermissionFlagsBits.ManageGuild];

function depsWith(overrides: {
  create?: TournamentsService['create'];
  open?: TournamentsService['open'];
  close?: TournamentsService['close'];
  cancel?: TournamentsService['cancel'];
  start?: StartService['start'];
  joinSolo?: RegistrationService['joinSolo'];
  leave?: RegistrationService['leave'];
} = {}): TournamentDeps {
  return {
    tournaments: {
      create:
        overrides.create ??
        vi.fn<TournamentsService['create']>(async () => ({
          tournament: { id: 7, name: 'Кубок сервера' },
          notes: [],
        }) as never),
      open: overrides.open ?? vi.fn<TournamentsService['open']>(async () => ({ id: 7 }) as never),
      close: overrides.close ?? vi.fn<TournamentsService['close']>(async () => ({ id: 7 }) as never),
      cancel: overrides.cancel ?? vi.fn<TournamentsService['cancel']>(async () => ({ id: 7 }) as never),
    },
    registration: {
      joinSolo:
        overrides.joinSolo ??
        vi.fn<RegistrationService['joinSolo']>(async () => ({ id: 3, displayName: 'Игрок#EUW' }) as never),
      leave: overrides.leave ?? vi.fn<RegistrationService['leave']>(async () => ({ withdrawn: false })),
    },
    start: {
      start:
        overrides.start ??
        vi.fn<StartService['start']>(async () => ({
          tournament: { id: 7 },
          size: 8,
          rounds: 3,
          entrants: 8,
          matches: [],
          readyMatches: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
          byeMatches: [],
        }) as never),
    },
    publicBaseUrl: 'https://bot.example.com',
  } as unknown as TournamentDeps;
}

const CREATE_OPTIONS = {
  subcommand: 'create',
  strings: { name: 'Кубок сервера', game: 'lol', mode: 'team', seeding: 'rank' },
  integers: { 'team-size': 5, 'max-entrants': 8, 'best-of': 3 },
  booleans: { 'require-verified': true },
  channels: { 'announce-channel': { id: '150000000000000001' }, 'match-parent': { id: '150000000000000002' } },
  permissions: ORGANIZER,
};

describe('/tournament', () => {
  it('объявляет семь подкоманд и эфемерный defer', () => {
    const command = createTournamentCommand(depsWith());
    const json = command.builder.toJSON();

    expect(command.defer).toEqual({ ephemeral: true });
    expect(json.options?.map((option) => option.name).sort()).toEqual([
      'cancel',
      'close',
      'create',
      'join',
      'leave',
      'open',
      'start',
    ]);
  });

  it('не ставит ограничение прав на команду целиком: иначе участники не запишутся', () => {
    const command = createTournamentCommand(depsWith());
    const json = command.builder.toJSON();

    expect(json.default_member_permissions ?? null).toBeNull();
  });

  it('создаёт турнир и передаёт все параметры в сервис', async () => {
    const create = vi.fn<TournamentsService['create']>(async () => ({
      tournament: { id: 7, name: 'Кубок сервера' },
      notes: ['Турнир одиночный, поэтому размер состава выставлен в 1.'],
    }) as never);
    const command = createTournamentCommand(depsWith({ create }));
    const fake = fakeCommandInteraction('tournament', { ...CREATE_OPTIONS, userId: '222222222222222222' });

    await command.execute(fake.interaction, ctx);

    expect(create).toHaveBeenCalledWith({
      guildId: '111111111111111111',
      name: 'Кубок сервера',
      game: 'lol',
      entryMode: 'team',
      teamSize: 5,
      maxEntrants: 8,
      seeding: 'rank',
      bestOf: 3,
      requireVerified: true,
      createdBy: '222222222222222222',
      announceChannelId: '150000000000000001',
      matchParentId: '150000000000000002',
    });
    expect(fake.lastText()).toContain('7');
    expect(fake.lastText()).toContain('размер состава');
  });

  it('отвергает неизвестную игру до обращения к сервису', async () => {
    const create = vi.fn<TournamentsService['create']>();
    const command = createTournamentCommand(depsWith({ create }));
    const fake = fakeCommandInteraction('tournament', {
      ...CREATE_OPTIONS,
      strings: { name: 'Кубок', game: 'cs2', mode: 'team', seeding: 'rank' },
    });

    await expect(command.execute(fake.interaction, ctx)).rejects.toThrow(UserError);
    expect(create).not.toHaveBeenCalled();
  });

  it('не даёт создать турнир без права «Управление сервером»', async () => {
    const create = vi.fn<TournamentsService['create']>();
    const command = createTournamentCommand(depsWith({ create }));
    const fake = fakeCommandInteraction('tournament', { ...CREATE_OPTIONS, permissions: [] });

    await expect(command.execute(fake.interaction, ctx)).rejects.toThrow(/Управление сервером/);
    expect(create).not.toHaveBeenCalled();
  });

  it('открывает, закрывает и отменяет запись только организатору', async () => {
    const open = vi.fn<TournamentsService['open']>(async () => ({ id: 7 }) as never);
    const close = vi.fn<TournamentsService['close']>(async () => ({ id: 7 }) as never);
    const cancel = vi.fn<TournamentsService['cancel']>(async () => ({ id: 7 }) as never);
    const command = createTournamentCommand(depsWith({ open, close, cancel }));

    for (const subcommand of ['open', 'close', 'cancel']) {
      const allowed = fakeCommandInteraction('tournament', {
        subcommand,
        integers: { tournament: 7 },
        permissions: ORGANIZER,
      });
      await command.execute(allowed.interaction, ctx);

      const denied = fakeCommandInteraction('tournament', {
        subcommand,
        integers: { tournament: 7 },
        permissions: [],
      });
      await expect(command.execute(denied.interaction, ctx)).rejects.toThrow(UserError);
    }

    expect(open).toHaveBeenCalledWith(7, '111111111111111111');
    expect(close).toHaveBeenCalledWith(7, '111111111111111111');
    expect(cancel).toHaveBeenCalledWith(7, '111111111111111111');
  });

  it('стартует турнир и рассказывает про размер сетки и пропуски', async () => {
    const start = vi.fn<StartService['start']>(async () => ({
      tournament: { id: 7 },
      size: 8,
      rounds: 3,
      entrants: 5,
      matches: [],
      readyMatches: [{ id: 1 }],
      byeMatches: [{ id: 2 }, { id: 3 }, { id: 4 }],
    }) as never);
    const command = createTournamentCommand(depsWith({ start }));
    const fake = fakeCommandInteraction('tournament', {
      subcommand: 'start',
      integers: { tournament: 7 },
      permissions: ORGANIZER,
    });

    await command.execute(fake.interaction, ctx);

    expect(start).toHaveBeenCalledWith({ tournamentId: 7, guildId: '111111111111111111' });
    expect(fake.lastText()).toContain('участников: 5');
    expect(fake.lastText()).toContain('пропусков: 3');
    expect(fake.lastText()).toContain('/bracket');
  });

  it('записывает участника без всяких прав', async () => {
    const joinSolo = vi.fn<RegistrationService['joinSolo']>(
      async () => ({ id: 3, displayName: 'Игрок#EUW' }) as never,
    );
    const command = createTournamentCommand(depsWith({ joinSolo }));
    const fake = fakeCommandInteraction('tournament', {
      subcommand: 'join',
      integers: { tournament: 7 },
      permissions: [],
      userId: '222222222222222222',
      username: 'aleksei',
    });

    await command.execute(fake.interaction, ctx);

    expect(joinSolo).toHaveBeenCalledWith({
      tournamentId: 7,
      guildId: '111111111111111111',
      userId: '222222222222222222',
      fallbackName: 'aleksei',
    });
    expect(fake.lastText()).toContain('Игрок#EUW');
  });

  it('по-разному отвечает на выход до старта и на снятие после старта', async () => {
    const beforeStart = createTournamentCommand(
      depsWith({ leave: vi.fn<RegistrationService['leave']>(async () => ({ withdrawn: false })) }),
    );
    const afterStart = createTournamentCommand(
      depsWith({ leave: vi.fn<RegistrationService['leave']>(async () => ({ withdrawn: true })) }),
    );
    const options = { subcommand: 'leave', integers: { tournament: 7 }, permissions: [] };

    const first = fakeCommandInteraction('tournament', options);
    await beforeStart.execute(first.interaction, ctx);
    const second = fakeCommandInteraction('tournament', options);
    await afterStart.execute(second.interaction, ctx);

    expect(first.lastText()).toContain('Запись отменена');
    expect(second.lastText()).toContain('walkover');
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npx vitest run tests/modules/tournaments/commands/tournament.test.ts`
Expected: FAIL — модуль `tournament.js` не найден.

- [ ] **Step 3: Реализовать `src/modules/tournaments/commands/tournament.ts`**

```ts
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { UserError } from '../../../core/errors.js';
import type { CommandDefinition } from '../../../core/module.js';
import { TOURNAMENT_GAME_CHOICES, isTournamentGame } from '../games.js';
import type { TournamentDeps } from '../deps.js';
import { requireGuild, requireOrganizer } from './guards.js';

const MODE_CHOICES = [
  { name: 'одиночный', value: 'solo' },
  { name: 'командный', value: 'team' },
];

const SEEDING_CHOICES = [
  { name: 'случайная', value: 'random' },
  { name: 'по рангу', value: 'rank' },
];

const BEST_OF_CHOICES = [
  { name: '1 карта', value: 1 },
  { name: '3 карты', value: 3 },
  { name: '5 карт', value: 5 },
];

export function createTournamentCommand(deps: TournamentDeps): CommandDefinition {
  return {
    // Каждая подкоманда читает или пишет Postgres до первого ответа.
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('tournament')
      .setDescription('Турниры сервера')
      // setDefaultMemberPermissions здесь НЕ ставится: join и leave — для всех, а
      // флаг действует на команду целиком. Права организатора проверяет requireOrganizer.
      .addSubcommand((sub) =>
        sub
          .setName('create')
          .setDescription('Создать турнир (черновик)')
          .addStringOption((option) =>
            option.setName('name').setDescription('Название турнира').setRequired(true).setMaxLength(80),
          )
          .addStringOption((option) =>
            option.setName('game').setDescription('Игра').setRequired(true).addChoices(...TOURNAMENT_GAME_CHOICES),
          )
          .addStringOption((option) =>
            option.setName('mode').setDescription('Состав').setRequired(true).addChoices(...MODE_CHOICES),
          )
          .addStringOption((option) =>
            option.setName('seeding').setDescription('Жеребьёвка').setRequired(true).addChoices(...SEEDING_CHOICES),
          )
          .addIntegerOption((option) =>
            option
              .setName('max-entrants')
              .setDescription('Сколько участников максимум (2–64)')
              .setRequired(true)
              .setMinValue(2)
              .setMaxValue(64),
          )
          .addIntegerOption((option) =>
            option
              .setName('team-size')
              .setDescription('Игроков в составе (для командного турнира)')
              .setMinValue(1)
              .setMaxValue(10),
          )
          .addIntegerOption((option) =>
            option.setName('best-of').setDescription('Карт в матче').addChoices(...BEST_OF_CHOICES),
          )
          .addBooleanOption((option) =>
            option.setName('require-verified').setDescription('Требовать подтверждённую привязку аккаунта'),
          )
          .addChannelOption((option) =>
            option.setName('announce-channel').setDescription('Куда объявлять круги'),
          )
          .addChannelOption((option) =>
            option.setName('match-parent').setDescription('Где создавать ветки под матчи'),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('open')
          .setDescription('Открыть запись')
          .addIntegerOption((option) =>
            option.setName('tournament').setDescription('Номер турнира').setRequired(true).setMinValue(1),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('close')
          .setDescription('Закрыть запись')
          .addIntegerOption((option) =>
            option.setName('tournament').setDescription('Номер турнира').setRequired(true).setMinValue(1),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('start')
          .setDescription('Провести жеребьёвку и построить сетку')
          .addIntegerOption((option) =>
            option.setName('tournament').setDescription('Номер турнира').setRequired(true).setMinValue(1),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('cancel')
          .setDescription('Отменить турнир')
          .addIntegerOption((option) =>
            option.setName('tournament').setDescription('Номер турнира').setRequired(true).setMinValue(1),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('join')
          .setDescription('Записаться на одиночный турнир')
          .addIntegerOption((option) =>
            option.setName('tournament').setDescription('Номер турнира').setRequired(true).setMinValue(1),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('leave')
          .setDescription('Отказаться от участия')
          .addIntegerOption((option) =>
            option.setName('tournament').setDescription('Номер турнира').setRequired(true).setMinValue(1),
          ),
      ),

    async execute(interaction) {
      const guildId = requireGuild(interaction);
      const subcommand = interaction.options.getSubcommand();

      // Участниковые подкоманды — до проверки прав организатора.
      if (subcommand === 'join') {
        const tournamentId = interaction.options.getInteger('tournament', true);
        const entrant = await deps.registration.joinSolo({
          tournamentId,
          guildId,
          userId: interaction.user.id,
          fallbackName: interaction.user.username,
        });
        await interaction.followUp({
          content: `Записал: **${entrant.displayName}**. Отметиться перед началом — \`/checkin ${tournamentId}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'leave') {
        const tournamentId = interaction.options.getInteger('tournament', true);
        const result = await deps.registration.leave({ tournamentId, guildId, userId: interaction.user.id });
        await interaction.followUp({
          content: result.withdrawn
            ? 'Ты снят с турнира. Сетка не пересобирается: сопернику организатор поставит walkover.'
            : 'Запись отменена.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      requireOrganizer(interaction);

      if (subcommand === 'create') {
        const game = interaction.options.getString('game', true);
        // Проверка, а не приведение типа: строка приходит по сети, и `as` тут был бы
        // обещанием, которого никто не проверял.
        if (!isTournamentGame(game)) {
          throw new UserError('Такой игры в списке нет. Выбери игру из предложенных.');
        }

        const mode = interaction.options.getString('mode', true);
        if (mode !== 'solo' && mode !== 'team') {
          throw new UserError('Состав бывает только одиночный или командный.');
        }

        const seeding = interaction.options.getString('seeding', true);
        if (seeding !== 'random' && seeding !== 'rank') {
          throw new UserError('Жеребьёвка бывает только случайной или по рангу.');
        }

        const result = await deps.tournaments.create({
          guildId,
          name: interaction.options.getString('name', true),
          game,
          entryMode: mode,
          teamSize: interaction.options.getInteger('team-size') ?? (mode === 'team' ? 5 : 1),
          maxEntrants: interaction.options.getInteger('max-entrants', true),
          seeding,
          bestOf: interaction.options.getInteger('best-of') ?? 1,
          requireVerified: interaction.options.getBoolean('require-verified') ?? true,
          createdBy: interaction.user.id,
          announceChannelId: interaction.options.getChannel('announce-channel')?.id ?? null,
          matchParentId: interaction.options.getChannel('match-parent')?.id ?? null,
        });

        const notes = result.notes.length > 0 ? `\n${result.notes.join('\n')}` : '';
        await interaction.followUp({
          content:
            `Турнир **${result.tournament.name}** создан, номер **${result.tournament.id}**. ` +
            `Пока это черновик: откроешь запись через \`/tournament open ${result.tournament.id}\`.${notes}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const tournamentId = interaction.options.getInteger('tournament', true);

      if (subcommand === 'open') {
        await deps.tournaments.open(tournamentId, guildId);
        await interaction.followUp({
          content: `Запись открыта. Участники записываются через \`/tournament join ${tournamentId}\` или \`/team create\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'close') {
        await deps.tournaments.close(tournamentId, guildId);
        await interaction.followUp({
          content: 'Запись закрыта. Турнир вернулся в черновик — можно стартовать или открыть запись снова.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'cancel') {
        await deps.tournaments.cancel(tournamentId, guildId);
        await interaction.followUp({ content: 'Турнир отменён.', flags: MessageFlags.Ephemeral });
        return;
      }

      // subcommand === 'start'
      const result = await deps.start.start({ tournamentId, guildId });
      await interaction.followUp({
        content:
          `Сетка построена: участников: ${result.entrants}, размер сетки: ${result.size}, кругов: ${result.rounds}. ` +
          `Матчей к игре: ${result.readyMatches.length}, пропусков: ${result.byeMatches.length}.\n` +
          `Смотреть сетку: \`/bracket ${tournamentId}\`. Ветки под матчи создаются сами.`,
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}
```

- [ ] **Step 4: Прогнать тест**

Run: `npx vitest run tests/modules/tournaments/commands/tournament.test.ts && npm run typecheck`
Expected: 9 тестов PASS, тайпчек чистый.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/tournaments/commands/tournament.ts tests/modules/tournaments/commands/tournament.test.ts
git commit -m "feat(tournaments): команда /tournament с созданием, записью и стартом"
```

---

### Task 17: Команда `/team`

**Files:**
- Create: `src/modules/tournaments/commands/team.ts`
- Test: `tests/modules/tournaments/commands/team.test.ts`

**Interfaces:**
- Consumes: `CommandDefinition`, `UserError`; `TournamentDeps`, `requireGuild` (Task 13); `TeamsService` (Task 8).
- Produces: `function createTeamCommand(deps: TournamentDeps): CommandDefinition` — команда `team` с подкомандами `create`, `invite`, `kick`, `leave`, `disband`.

**Права организатора здесь не нужны ни одной подкоманде:** составом распоряжается капитан, и «капитанство» проверяет сервис по данным турнира, а не Discord по правам сервера. Приглашение добавляет игрока сразу — таблицы приглашений в модели нет, а ошибочно добавленный выходит через `/team leave`.

- [ ] **Step 1: Написать падающий тест**

Файл `tests/modules/tournaments/commands/team.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../../src/core/config.js';
import { UserError } from '../../../../src/core/errors.js';
import { createLogger } from '../../../../src/core/logger.js';
import type { ModuleContext } from '../../../../src/core/module.js';
import { createTeamCommand } from '../../../../src/modules/tournaments/commands/team.js';
import type { TournamentDeps } from '../../../../src/modules/tournaments/deps.js';
import type { TeamsService } from '../../../../src/modules/tournaments/services/teams.js';
import { fakeCommandInteraction } from '../../../helpers/interaction.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);
const ctx = { logger } as unknown as ModuleContext;
const CAPTAIN = '222222222222222222';
const MATE = '333333333333333333';

function depsWith(overrides: Partial<TeamsService> = {}): TournamentDeps {
  return {
    teams: {
      create: vi.fn<TeamsService['create']>(async () => ({ id: 5, displayName: 'Красные' }) as never),
      invite: vi.fn<TeamsService['invite']>(async () => ({
        entrant: { id: 5, displayName: 'Красные' },
        role: 'player',
      }) as never),
      kick: vi.fn<TeamsService['kick']>(async () => {}),
      leave: vi.fn<TeamsService['leave']>(async () => {}),
      disband: vi.fn<TeamsService['disband']>(async () => ({ withdrawn: false })),
      ...overrides,
    },
  } as unknown as TournamentDeps;
}

describe('/team', () => {
  it('объявляет пять подкоманд и эфемерный defer', () => {
    const command = createTeamCommand(depsWith());
    const json = command.builder.toJSON();

    expect(command.defer).toEqual({ ephemeral: true });
    expect(json.options?.map((option) => option.name).sort()).toEqual([
      'create',
      'disband',
      'invite',
      'kick',
      'leave',
    ]);
  });

  it('создаёт команду от имени вызвавшего', async () => {
    const create = vi.fn<TeamsService['create']>(async () => ({ id: 5, displayName: 'Красные' }) as never);
    const command = createTeamCommand(depsWith({ create }));
    const fake = fakeCommandInteraction('team', {
      subcommand: 'create',
      integers: { tournament: 7 },
      strings: { name: 'Красные' },
      userId: CAPTAIN,
    });

    await command.execute(fake.interaction, ctx);

    expect(create).toHaveBeenCalledWith({
      tournamentId: 7,
      guildId: '111111111111111111',
      captainUserId: CAPTAIN,
      name: 'Красные',
    });
    expect(fake.lastText()).toContain('Красные');
  });

  it('приглашает игрока и называет его роль', async () => {
    const invite = vi.fn<TeamsService['invite']>(async () => ({
      entrant: { id: 5, displayName: 'Красные' },
      role: 'sub',
    }) as never);
    const command = createTeamCommand(depsWith({ invite }));
    const fake = fakeCommandInteraction('team', {
      subcommand: 'invite',
      integers: { tournament: 7 },
      users: { player: { id: MATE } },
      userId: CAPTAIN,
    });

    await command.execute(fake.interaction, ctx);

    expect(invite).toHaveBeenCalledWith({
      tournamentId: 7,
      guildId: '111111111111111111',
      captainUserId: CAPTAIN,
      userId: MATE,
    });
    expect(fake.lastText()).toContain('запасным');
  });

  it('исключает игрока из состава', async () => {
    const kick = vi.fn<TeamsService['kick']>(async () => {});
    const command = createTeamCommand(depsWith({ kick }));
    const fake = fakeCommandInteraction('team', {
      subcommand: 'kick',
      integers: { tournament: 7 },
      users: { player: { id: MATE } },
      userId: CAPTAIN,
    });

    await command.execute(fake.interaction, ctx);

    expect(kick).toHaveBeenCalledWith({
      tournamentId: 7,
      guildId: '111111111111111111',
      captainUserId: CAPTAIN,
      userId: MATE,
    });
  });

  it('выпускает игрока из состава', async () => {
    const leave = vi.fn<TeamsService['leave']>(async () => {});
    const command = createTeamCommand(depsWith({ leave }));
    const fake = fakeCommandInteraction('team', {
      subcommand: 'leave',
      integers: { tournament: 7 },
      userId: MATE,
    });

    await command.execute(fake.interaction, ctx);

    expect(leave).toHaveBeenCalledWith({ tournamentId: 7, guildId: '111111111111111111', userId: MATE });
  });

  it('по-разному отвечает на роспуск до старта и на снятие после старта', async () => {
    const before = createTeamCommand(
      depsWith({ disband: vi.fn<TeamsService['disband']>(async () => ({ withdrawn: false })) }),
    );
    const after = createTeamCommand(
      depsWith({ disband: vi.fn<TeamsService['disband']>(async () => ({ withdrawn: true })) }),
    );
    const options = { subcommand: 'disband', integers: { tournament: 7 }, userId: CAPTAIN };

    const first = fakeCommandInteraction('team', options);
    await before.execute(first.interaction, ctx);
    const second = fakeCommandInteraction('team', options);
    await after.execute(second.interaction, ctx);

    expect(first.lastText()).toContain('удалена');
    expect(second.lastText()).toContain('walkover');
  });

  it('пропускает наружу ошибку сервиса — её показывает роутер', async () => {
    const create = vi.fn<TeamsService['create']>(async () => {
      throw new UserError('Команда с названием «Красные» в этом турнире уже есть — выбери другое.');
    });
    const command = createTeamCommand(depsWith({ create }));
    const fake = fakeCommandInteraction('team', {
      subcommand: 'create',
      integers: { tournament: 7 },
      strings: { name: 'Красные' },
    });

    await expect(command.execute(fake.interaction, ctx)).rejects.toThrow(/уже есть/);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npx vitest run tests/modules/tournaments/commands/team.test.ts`
Expected: FAIL — модуль `team.js` не найден.

- [ ] **Step 3: Реализовать `src/modules/tournaments/commands/team.ts`**

```ts
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { UserError } from '../../../core/errors.js';
import type { CommandDefinition } from '../../../core/module.js';
import type { TournamentDeps } from '../deps.js';
import { requireGuild } from './guards.js';

const ROLE_LABEL: Record<string, string> = {
  captain: 'капитаном',
  player: 'игроком',
  sub: 'запасным',
};

export function createTeamCommand(deps: TournamentDeps): CommandDefinition {
  return {
    // Каждая подкоманда пишет или читает Postgres.
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('team')
      .setDescription('Состав команды на турнир')
      // Права организатора не нужны: составом распоряжается капитан, и капитанство
      // проверяет сервис по данным турнира, а не Discord по правам сервера.
      .addSubcommand((sub) =>
        sub
          .setName('create')
          .setDescription('Создать команду и записать её на турнир')
          .addIntegerOption((option) =>
            option.setName('tournament').setDescription('Номер турнира').setRequired(true).setMinValue(1),
          )
          .addStringOption((option) =>
            option.setName('name').setDescription('Название команды').setRequired(true).setMaxLength(40),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('invite')
          .setDescription('Добавить игрока в свой состав')
          .addIntegerOption((option) =>
            option.setName('tournament').setDescription('Номер турнира').setRequired(true).setMinValue(1),
          )
          .addUserOption((option) => option.setName('player').setDescription('Кого добавить').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('kick')
          .setDescription('Убрать игрока из своего состава')
          .addIntegerOption((option) =>
            option.setName('tournament').setDescription('Номер турнира').setRequired(true).setMinValue(1),
          )
          .addUserOption((option) => option.setName('player').setDescription('Кого убрать').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('leave')
          .setDescription('Выйти из состава')
          .addIntegerOption((option) =>
            option.setName('tournament').setDescription('Номер турнира').setRequired(true).setMinValue(1),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('disband')
          .setDescription('Снять свою команду с турнира')
          .addIntegerOption((option) =>
            option.setName('tournament').setDescription('Номер турнира').setRequired(true).setMinValue(1),
          ),
      ),

    async execute(interaction) {
      const guildId = requireGuild(interaction);
      const subcommand = interaction.options.getSubcommand();
      const tournamentId = interaction.options.getInteger('tournament', true);
      const userId = interaction.user.id;

      if (subcommand === 'create') {
        const entrant = await deps.teams.create({
          tournamentId,
          guildId,
          captainUserId: userId,
          name: interaction.options.getString('name', true),
        });
        await interaction.followUp({
          content: `Команда **${entrant.displayName}** записана. Добавляй игроков: \`/team invite ${tournamentId}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'leave') {
        await deps.teams.leave({ tournamentId, guildId, userId });
        await interaction.followUp({ content: 'Ты вышел из состава.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (subcommand === 'disband') {
        const result = await deps.teams.disband({ tournamentId, guildId, captainUserId: userId });
        await interaction.followUp({
          content: result.withdrawn
            ? 'Команда снята с турнира. Сетка не пересобирается: сопернику организатор поставит walkover.'
            : 'Команда удалена с турнира.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const player = interaction.options.getUser('player', true);
      if (player.id === userId && subcommand === 'kick') {
        throw new UserError('Себя исключить нельзя: сними команду целиком через `/team disband`.');
      }

      if (subcommand === 'invite') {
        const result = await deps.teams.invite({
          tournamentId,
          guildId,
          captainUserId: userId,
          userId: player.id,
        });
        await interaction.followUp({
          content: `Добавил <@${player.id}> в состав **${result.entrant.displayName}** ${ROLE_LABEL[result.role] ?? 'игроком'}. Если это ошибка — \`/team kick ${tournamentId}\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // subcommand === 'kick'
      await deps.teams.kick({ tournamentId, guildId, captainUserId: userId, userId: player.id });
      await interaction.followUp({
        content: `Убрал <@${player.id}> из состава.`,
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}
```

- [ ] **Step 4: Прогнать тест**

Run: `npx vitest run tests/modules/tournaments/commands/team.test.ts && npm run typecheck`
Expected: 7 тестов PASS, тайпчек чистый.

- [ ] **Step 5: Коммит**

```bash
git add src/modules/tournaments/commands/team.ts tests/modules/tournaments/commands/team.test.ts
git commit -m "feat(tournaments): команда /team для составов"
```

---

### Task 18: Команда `/match`

**Files:**
- Create: `src/modules/tournaments/commands/match.ts`
- Modify: `src/modules/tournaments/deps.ts` — добавить в `TournamentDeps` поле `announce: AnnounceService`
- Test: `tests/modules/tournaments/commands/match.test.ts`

**Interfaces:**
- Consumes: `CommandDefinition`, `UserError`; `TournamentDeps`, `requireGuild`, `requireOrganizer` (Task 13); `MatchesService`, `sideOf` (Tasks 10-11); `AnnounceService` (Task 15).
- Produces: `function createMatchCommand(deps: TournamentDeps): CommandDefinition` — команда `match` с подкомандами `report`, `confirm`, `dispute`, `resolve`, `walkover`. `TournamentDeps` дополняется полем `announce: AnnounceService`.

**Почему участник не вводит номер матча и не вводит имя победителя.** Он выбирает только «мы победили» или «мы проиграли». Матч находится сам — у участника в турнире в каждый момент не больше одного матча в состоянии `ready`, потому что он играет по одному матчу за круг. Победитель вычисляется из состава вызвавшего: он либо его собственный участник, либо соперник. Так исчезает целый класс ошибок ввода — и заодно невозможно «случайно» заявить победу в чужом матче.

Организаторские `resolve` и `walkover`, наоборот, принимают **номер матча** (он напечатан в `/bracket` как `#12`) и **сторону** (`a`/`b` — «слева»/«справа» в той же строке `/bracket`).

- [ ] **Step 1: Написать падающий тест**

Файл `tests/modules/tournaments/commands/match.test.ts`:

```ts
import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../../src/core/config.js';
import { UserError } from '../../../../src/core/errors.js';
import { createLogger } from '../../../../src/core/logger.js';
import type { ModuleContext } from '../../../../src/core/module.js';
import { createMatchCommand } from '../../../../src/modules/tournaments/commands/match.js';
import type { TournamentDeps } from '../../../../src/modules/tournaments/deps.js';
import type { AnnounceService } from '../../../../src/modules/tournaments/services/announce.js';
import type { MatchesService } from '../../../../src/modules/tournaments/services/matches.js';
import { fakeCommandInteraction } from '../../../helpers/interaction.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);
const ctx = { logger } as unknown as ModuleContext;

const ME = '222222222222222222';
const RIVAL = '333333333333333333';
const ORGANIZER = [PermissionFlagsBits.ManageGuild];

const MY_ENTRANT = 11;
const RIVAL_ENTRANT = 22;
const MATCH_ID = 42;

/** Матч, в котором вызывающий играет за сторону a. */
const READY_MATCH = {
  id: MATCH_ID,
  tournamentId: 7,
  round: 1,
  slot: 0,
  entrantAId: MY_ENTRANT,
  entrantBId: RIVAL_ENTRANT,
  state: 'ready' as const,
  winnerEntrantId: null,
};

const REPORTED_MATCH = { ...READY_MATCH, state: 'reported' as const, winnerEntrantId: MY_ENTRANT };

function depsWith(overrides: Partial<MatchesService> = {}, announceOverrides: Partial<AnnounceService> = {}) {
  const matches = {
    matchesFor: vi.fn<MatchesService['matchesFor']>(async () => [READY_MATCH] as never),
    sidesOf: vi.fn<MatchesService['sidesOf']>(async () => ({
      match: READY_MATCH,
      aUserIds: [ME],
      bUserIds: [RIVAL],
    }) as never),
    report: vi.fn<MatchesService['report']>(async () => REPORTED_MATCH as never),
    confirm: vi.fn<MatchesService['confirm']>(async () => ({
      changed: true,
      match: REPORTED_MATCH,
      nextReady: null,
      championEntrantId: null,
    }) as never),
    dispute: vi.fn<MatchesService['dispute']>(async () => REPORTED_MATCH as never),
    resolve: vi.fn<MatchesService['resolve']>(async () => ({
      changed: true,
      match: REPORTED_MATCH,
      nextReady: null,
      championEntrantId: null,
    }) as never),
    walkover: vi.fn<MatchesService['walkover']>(async () => ({
      changed: true,
      match: REPORTED_MATCH,
      nextReady: null,
      championEntrantId: null,
    }) as never),
    ...overrides,
  } as unknown as MatchesService;

  const announce = {
    postReport: vi.fn<AnnounceService['postReport']>(async () => {}),
    openMatches: vi.fn<AnnounceService['openMatches']>(async () => ({ created: 0, failed: 0, skipped: 0 })),
    archiveMatch: vi.fn<AnnounceService['archiveMatch']>(async () => {}),
    announce: vi.fn<AnnounceService['announce']>(async () => {}),
    ...announceOverrides,
  } as unknown as AnnounceService;

  return { matches, announce, deps: { matches, announce } as unknown as TournamentDeps };
}

describe('/match', () => {
  it('объявляет пять подкоманд и эфемерный defer', () => {
    const command = createMatchCommand(depsWith().deps);
    const json = command.builder.toJSON();

    expect(command.defer).toEqual({ ephemeral: true });
    expect(json.options?.map((option) => option.name).sort()).toEqual([
      'confirm',
      'dispute',
      'report',
      'resolve',
      'walkover',
    ]);
  });

  it('«мы победили» заявляет победителем состав вызвавшего', async () => {
    const { matches, deps } = depsWith();
    const command = createMatchCommand(deps);
    const fake = fakeCommandInteraction('match', {
      subcommand: 'report',
      integers: { tournament: 7 },
      strings: { result: 'won' },
      userId: ME,
    });

    await command.execute(fake.interaction, ctx);

    expect(matches.report).toHaveBeenCalledWith({ matchId: MATCH_ID, userId: ME, winnerEntrantId: MY_ENTRANT });
  });

  it('«мы проиграли» заявляет победителем соперника', async () => {
    const { matches, deps } = depsWith();
    const command = createMatchCommand(deps);
    const fake = fakeCommandInteraction('match', {
      subcommand: 'report',
      integers: { tournament: 7 },
      strings: { result: 'lost' },
      userId: ME,
    });

    await command.execute(fake.interaction, ctx);

    expect(matches.report).toHaveBeenCalledWith({ matchId: MATCH_ID, userId: ME, winnerEntrantId: RIVAL_ENTRANT });
  });

  it('после заявки пишет в ветку матча сообщение с кнопками', async () => {
    const { announce, deps } = depsWith();
    const command = createMatchCommand(deps);
    const fake = fakeCommandInteraction('match', {
      subcommand: 'report',
      integers: { tournament: 7 },
      strings: { result: 'won' },
      userId: ME,
    });

    await command.execute(fake.interaction, ctx);

    expect(announce.postReport).toHaveBeenCalledWith({
      matchId: MATCH_ID,
      content: expect.stringContaining('Подтвердить'),
    });
  });

  it('говорит понятным текстом, когда играть нечего', async () => {
    const { matches, deps } = depsWith({ matchesFor: vi.fn<MatchesService['matchesFor']>(async () => []) });
    const command = createMatchCommand(deps);
    const fake = fakeCommandInteraction('match', {
      subcommand: 'report',
      integers: { tournament: 7 },
      strings: { result: 'won' },
      userId: ME,
    });

    await expect(command.execute(fake.interaction, ctx)).rejects.toThrow(/нет матча/);
    expect(matches.report).not.toHaveBeenCalled();
  });

  it('подтверждает заявленный матч, найденный по составу', async () => {
    const { matches, deps } = depsWith({
      matchesFor: vi.fn<MatchesService['matchesFor']>(async () => [REPORTED_MATCH] as never),
    });
    const command = createMatchCommand(deps);
    const fake = fakeCommandInteraction('match', {
      subcommand: 'confirm',
      integers: { tournament: 7 },
      userId: RIVAL,
    });

    await command.execute(fake.interaction, ctx);

    expect(matches.matchesFor).toHaveBeenCalledWith(7, RIVAL, ['reported']);
    expect(matches.confirm).toHaveBeenCalledWith({ matchId: MATCH_ID, userId: RIVAL });
    expect(fake.lastText()).toContain('подтверждён');
  });

  it('оспаривает матч и передаёт причину', async () => {
    const { matches, deps } = depsWith({
      matchesFor: vi.fn<MatchesService['matchesFor']>(async () => [REPORTED_MATCH] as never),
    });
    const command = createMatchCommand(deps);
    const fake = fakeCommandInteraction('match', {
      subcommand: 'dispute',
      integers: { tournament: 7 },
      strings: { reason: 'вторая карта не доиграна' },
      userId: RIVAL,
    });

    await command.execute(fake.interaction, ctx);

    expect(matches.dispute).toHaveBeenCalledWith({
      matchId: MATCH_ID,
      userId: RIVAL,
      reason: 'вторая карта не доиграна',
    });
    expect(fake.lastText()).toContain('организатор');
  });

  it('не даёт участнику решить спорный матч за организатора', async () => {
    const { matches, deps } = depsWith();
    const command = createMatchCommand(deps);
    const fake = fakeCommandInteraction('match', {
      subcommand: 'resolve',
      integers: { match: MATCH_ID },
      strings: { winner: 'a' },
      permissions: [],
      userId: ME,
    });

    await expect(command.execute(fake.interaction, ctx)).rejects.toThrow(/Управление сервером/);
    expect(matches.resolve).not.toHaveBeenCalled();
  });

  it('решает спорный матч по номеру и стороне', async () => {
    const { matches, deps } = depsWith();
    const command = createMatchCommand(deps);
    const fake = fakeCommandInteraction('match', {
      subcommand: 'resolve',
      integers: { match: MATCH_ID },
      strings: { winner: 'b' },
      permissions: ORGANIZER,
      userId: '444444444444444444',
    });

    await command.execute(fake.interaction, ctx);

    expect(matches.resolve).toHaveBeenCalledWith({
      matchId: MATCH_ID,
      guildId: '111111111111111111',
      adminUserId: '444444444444444444',
      side: 'b',
    });
  });

  it('ставит неявку и сообщает, если результат уже был окончательным', async () => {
    const { matches, deps } = depsWith({
      walkover: vi.fn<MatchesService['walkover']>(async () => ({
        changed: false,
        match: REPORTED_MATCH,
        nextReady: null,
        championEntrantId: null,
      }) as never),
    });
    const command = createMatchCommand(deps);
    const fake = fakeCommandInteraction('match', {
      subcommand: 'walkover',
      integers: { match: MATCH_ID },
      strings: { winner: 'a' },
      permissions: ORGANIZER,
    });

    await command.execute(fake.interaction, ctx);

    expect(matches.walkover).toHaveBeenCalled();
    expect(fake.lastText()).toContain('уже был окончательным');
  });

  it('отвергает неизвестную сторону, не трогая сервис', async () => {
    const { matches, deps } = depsWith();
    const command = createMatchCommand(deps);
    const fake = fakeCommandInteraction('match', {
      subcommand: 'resolve',
      integers: { match: MATCH_ID },
      strings: { winner: 'третий' },
      permissions: ORGANIZER,
    });

    await expect(command.execute(fake.interaction, ctx)).rejects.toThrow(UserError);
    expect(matches.resolve).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npx vitest run tests/modules/tournaments/commands/match.test.ts`
Expected: FAIL — модуль `match.js` не найден.

- [ ] **Step 3: Дополнить `src/modules/tournaments/deps.ts`**

Добавить импорт и поле:

```ts
import type { AnnounceService } from './services/announce.js';
```

и в `interface TournamentDeps`:

```ts
  /** Ветки под матчи и объявления. Команды пишут в Discord только через него. */
  announce: AnnounceService;
```

- [ ] **Step 4: Реализовать `src/modules/tournaments/commands/match.ts`**

```ts
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { UserError } from '../../../core/errors.js';
import type { CommandDefinition } from '../../../core/module.js';
import type { TournamentDeps } from '../deps.js';
import { sideOf } from '../services/matches.js';
import { requireGuild, requireOrganizer } from './guards.js';

const RESULT_CHOICES = [
  { name: 'мы победили', value: 'won' },
  { name: 'мы проиграли', value: 'lost' },
];

const SIDE_CHOICES = [
  { name: 'первый участник (слева в /bracket)', value: 'a' },
  { name: 'второй участник (справа в /bracket)', value: 'b' },
];

export function createMatchCommand(deps: TournamentDeps): CommandDefinition {
  return {
    defer: { ephemeral: true },
    builder: new SlashCommandBuilder()
      .setName('match')
      .setDescription('Результаты матчей турнира')
      // Ограничение прав на команду целиком не ставится: report, confirm и dispute —
      // для участников. Организаторские подкоманды закрывает requireOrganizer.
      .addSubcommand((sub) =>
        sub
          .setName('report')
          .setDescription('Заявить результат своего матча')
          .addIntegerOption((option) =>
            option.setName('tournament').setDescription('Номер турнира').setRequired(true).setMinValue(1),
          )
          .addStringOption((option) =>
            option.setName('result').setDescription('Чем закончился матч').setRequired(true).addChoices(...RESULT_CHOICES),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('confirm')
          .setDescription('Подтвердить результат, заявленный соперником')
          .addIntegerOption((option) =>
            option.setName('tournament').setDescription('Номер турнира').setRequired(true).setMinValue(1),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('dispute')
          .setDescription('Оспорить результат, заявленный соперником')
          .addIntegerOption((option) =>
            option.setName('tournament').setDescription('Номер турнира').setRequired(true).setMinValue(1),
          )
          .addStringOption((option) =>
            option.setName('reason').setDescription('Что не так').setMaxLength(300),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('resolve')
          .setDescription('Назначить победителя спорного матча (организатор)')
          .addIntegerOption((option) =>
            option.setName('match').setDescription('Номер матча из /bracket').setRequired(true).setMinValue(1),
          )
          .addStringOption((option) =>
            option.setName('winner').setDescription('Кто победил').setRequired(true).addChoices(...SIDE_CHOICES),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('walkover')
          .setDescription('Отдать победу за неявку соперника (организатор)')
          .addIntegerOption((option) =>
            option.setName('match').setDescription('Номер матча из /bracket').setRequired(true).setMinValue(1),
          )
          .addStringOption((option) =>
            option.setName('winner').setDescription('Кто проходит дальше').setRequired(true).addChoices(...SIDE_CHOICES),
          ),
      ),

    async execute(interaction) {
      const guildId = requireGuild(interaction);
      const subcommand = interaction.options.getSubcommand();
      const userId = interaction.user.id;

      if (subcommand === 'report') {
        const tournamentId = interaction.options.getInteger('tournament', true);
        const result = interaction.options.getString('result', true);
        if (result !== 'won' && result !== 'lost') {
          throw new UserError('Выбери один из двух вариантов результата.');
        }

        // Матч ищется сам: у участника в каждый момент не больше одного готового матча,
        // потому что он играет по одному матчу за круг.
        const [match] = await deps.matches.matchesFor(tournamentId, userId, ['ready']);
        if (!match) {
          throw new UserError(
            'У тебя нет матча, ожидающего результата. Посмотри сетку: `/bracket <номер турнира>`.',
          );
        }

        const sides = await deps.matches.sidesOf(match.id);
        const mySide = sideOf(sides, userId);
        if (mySide === null) throw new UserError('Ты не играешь в этом матче.');

        const myEntrantId = mySide === 'a' ? match.entrantAId : match.entrantBId;
        const rivalEntrantId = mySide === 'a' ? match.entrantBId : match.entrantAId;
        const winnerEntrantId = result === 'won' ? myEntrantId : rivalEntrantId;
        if (winnerEntrantId === null) {
          throw new UserError('Соперник ещё не известен: дождись, пока определится победитель предыдущего круга.');
        }

        await deps.matches.report({ matchId: match.id, userId, winnerEntrantId });

        // Сообщение с кнопками — сопернику, в ветку матча. Отказ Discord здесь уже
        // ничего не отменяет: результат записан.
        await deps.announce.postReport({
          matchId: match.id,
          content:
            `Заявлен результат матча \`#${match.id}\`: победа участника **${winnerEntrantId === match.entrantAId ? 'слева' : 'справа'}**.\n` +
            'Соперник: нажми «Подтвердить» или «Оспорить». Через час без ответа результат подтвердится сам.',
        });

        await interaction.followUp({
          content: `Результат заявлен. Ждём подтверждения соперника — через час он подтвердится сам.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'confirm' || subcommand === 'dispute') {
        const tournamentId = interaction.options.getInteger('tournament', true);
        const [match] = await deps.matches.matchesFor(tournamentId, userId, ['reported']);
        if (!match) {
          throw new UserError('Нет матча с заявленным результатом, который тебе нужно было бы подтвердить.');
        }

        if (subcommand === 'confirm') {
          const outcome = await deps.matches.confirm({ matchId: match.id, userId });
          await interaction.followUp({
            content: outcome.changed
              ? 'Результат подтверждён, победитель прошёл в следующий круг.'
              : 'Этот результат уже подтверждён.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await deps.matches.dispute({
          matchId: match.id,
          userId,
          reason: interaction.options.getString('reason'),
        });
        await interaction.followUp({
          content: 'Матч отмечен спорным. Бот такие матчи не решает — победителя назначит организатор.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      requireOrganizer(interaction);

      const matchId = interaction.options.getInteger('match', true);
      const side = interaction.options.getString('winner', true);
      if (side !== 'a' && side !== 'b') {
        throw new UserError('Сторона бывает только первой или второй — выбери из списка.');
      }

      if (subcommand === 'resolve') {
        const outcome = await deps.matches.resolve({ matchId, guildId, adminUserId: userId, side });
        await interaction.followUp({
          content: outcome.changed
            ? 'Победитель назначен, он прошёл в следующий круг. Решение записано в журнал матча.'
            : 'Результат этого матча уже был окончательным — ничего не изменилось.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // subcommand === 'walkover'
      const outcome = await deps.matches.walkover({ matchId, guildId, adminUserId: userId, side });
      await interaction.followUp({
        content: outcome.changed
          ? 'Неявка оформлена, участник прошёл дальше. Решение записано в журнал матча.'
          : 'Результат этого матча уже был окончательным — ничего не изменилось.',
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}
```

- [ ] **Step 5: Прогнать тест**

Run: `npx vitest run tests/modules/tournaments/commands/match.test.ts && npm run typecheck`
Expected: 11 тестов PASS, тайпчек чистый.

- [ ] **Step 6: Коммит**

```bash
git add src/modules/tournaments/commands/match.ts src/modules/tournaments/deps.ts tests/modules/tournaments/commands/match.test.ts
git commit -m "feat(tournaments): команда /match с репортом, подтверждением, спором и решениями организатора"
```

---

### Task 19: Манифест модуля, подключение и сквозной сценарий

**Files:**
- Create: `src/modules/tournaments/index.ts`
- Modify: `src/modules.ts` — `buildModules` принимает зависимости двух модулей; `src/index.ts` — собрать шлюз Discord и передать зависимости; `scripts/deploy-commands.ts` — заглушка шлюза
- Test: `tests/integration/tournaments/module.test.ts`, `tests/integration/tournaments/acceptance.test.ts`

**Interfaces:**
- Consumes: всё, что создано в Tasks 5-18; `BotModule`, `ScheduledJob` из `src/core/module.ts`; `buildRegistry` из `src/core/registry.ts`.
- Produces:
  - `interface TournamentsModuleDeps { db: Database; bus: EventBus; logger: Logger; config: Config; gateway: DiscordGateway }`
  - `function createTournamentsModule(deps: TournamentsModuleDeps): BotModule`
  - `interface ModulesDeps { identity: IdentityModuleDeps; tournaments: TournamentsModuleDeps }` и `function buildModules(deps: ModulesDeps): BotModule[]` в `src/modules.ts`
  - константы `AUTO_CONFIRM_CRON = '*/5 * * * *'`, `AUTO_CONFIRM_BATCH = 50`

**Почему объявления и ветки живут в подписках на шину, а не в командах.** Команда `/tournament start` строит сетку в транзакции; вызывать Discord оттуда нельзя. Поэтому старт публикует `match.ready`, а подписчик создаёт ветки — уже после коммита, и его отказ не может ни откатить сетку, ни сорвать ответ команде. Тот же приём для архивации ветки на `match.confirmed` и для объявлений на `tournament.started` / `tournament.finished`.

**Обработчики подписок не читают `ctx`.** Всё, что им нужно (шлюз, сервисы, логгер), приходит в `deps` модуля. Поэтому их можно проверять напрямую, не подделывая `client`, и тест доходит до проверяемой ветки, а не падает на неинициализированном поле контекста — `EventBus.emit` гасит исключения обработчиков через `Promise.allSettled`, и такое падение осталось бы незамеченным.

- [ ] **Step 1: Написать падающий тест манифеста**

Файл `tests/integration/tournaments/module.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { EventBus } from '../../../src/core/events/bus.js';
import { createLogger } from '../../../src/core/logger.js';
import type { ModuleContext } from '../../../src/core/module.js';
import { buildRegistry } from '../../../src/core/registry.js';
import type { DiscordGateway } from '../../../src/modules/tournaments/discord/gateway.js';
import { createTournamentsModule } from '../../../src/modules/tournaments/index.js';
import {
  tournamentEntrantMembers,
  tournamentEntrants,
  tournamentMatches,
  tournaments,
} from '../../../src/modules/tournaments/schema.js';
import { createTournamentsService } from '../../../src/modules/tournaments/services/tournaments.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

const GUILD = '160000000000000001';
const PARENT = '160000000000000002';
const ANNOUNCE = '160000000000000003';
const A1 = '161000000000000001';
const B1 = '161000000000000002';

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} отсутствует`);
  return value;
}

interface GatewayCalls {
  threads: number;
  posts: Array<{ channelId: string; content: string }>;
  archived: string[];
}

function moduleWith(options: { threadsFail?: boolean } = {}) {
  const bus = new EventBus(logger);
  const calls: GatewayCalls = { threads: 0, posts: [], archived: [] };
  const gateway: DiscordGateway = {
    createMatchThread: vi.fn<DiscordGateway['createMatchThread']>(async () => {
      if (options.threadsFail === true) return null;
      calls.threads += 1;
      return `thread-${calls.threads}`;
    }),
    post: vi.fn<DiscordGateway['post']>(async (input) => {
      calls.posts.push({ channelId: input.channelId, content: input.content });
    }),
    archiveThread: vi.fn<DiscordGateway['archiveThread']>(async (threadId) => {
      calls.archived.push(threadId);
    }),
    notifyUser: vi.fn<DiscordGateway['notifyUser']>(async () => {}),
  };

  const module = createTournamentsModule({
    db: pg.db,
    bus,
    logger,
    config: { PUBLIC_BASE_URL: 'https://bot.example.com' } as Config,
    gateway,
  });

  return { module, bus, calls };
}

/** Контекст, полный для этого модуля: его подписки и джоба читают только deps. */
const ctx = { logger } as unknown as ModuleContext;

let counter = 0;

async function tournamentWithReadyMatch(): Promise<{ tournamentId: number; matchId: number }> {
  counter += 1;
  const bus = new EventBus(logger);
  const service = createTournamentsService({ db: pg.db, bus });
  const { tournament } = await service.create({
    guildId: GUILD,
    name: `Манифест ${counter}`,
    game: 'other',
    entryMode: 'solo',
    teamSize: 1,
    maxEntrants: 4,
    seeding: 'random',
    bestOf: 1,
    requireVerified: false,
    createdBy: A1,
    announceChannelId: ANNOUNCE,
    matchParentId: PARENT,
  });
  await pg.db.update(tournaments).set({ state: 'running' }).where(eq(tournaments.id, tournament.id));

  const first = required(
    (
      await pg.db
        .insert(tournamentEntrants)
        .values({ tournamentId: tournament.id, displayName: 'Первый', captainUserId: A1, seed: 1 })
        .returning()
    )[0],
    'первый участник',
  );
  const second = required(
    (
      await pg.db
        .insert(tournamentEntrants)
        .values({ tournamentId: tournament.id, displayName: 'Второй', captainUserId: B1, seed: 2 })
        .returning()
    )[0],
    'второй участник',
  );
  await pg.db.insert(tournamentEntrantMembers).values([
    { entrantId: first.id, tournamentId: tournament.id, userId: A1, role: 'captain' },
    { entrantId: second.id, tournamentId: tournament.id, userId: B1, role: 'captain' },
  ]);

  const match = required(
    (
      await pg.db
        .insert(tournamentMatches)
        .values({
          tournamentId: tournament.id,
          round: 1,
          slot: 0,
          entrantAId: first.id,
          entrantBId: second.id,
          state: 'reported',
          winnerEntrantId: first.id,
          reportedBy: A1,
          reportedAt: new Date(Date.now() - 61 * 60_000),
        })
        .returning()
    )[0],
    'матч',
  );

  return { tournamentId: tournament.id, matchId: match.id };
}

beforeEach(async () => {
  const bus = new EventBus(logger);
  const service = createTournamentsService({ db: pg.db, bus });
  await service.ensureGuild(GUILD);
  await service.ensureUser(A1);
  await service.ensureUser(B1);
});

describe('модуль tournaments', () => {
  it('называется tournaments', () => {
    expect(moduleWith().module.name).toBe('tournaments');
  });

  it('объявляет все пять команд', () => {
    const names = moduleWith().module.commands?.map((command) => command.builder.name).sort();

    expect(names).toEqual(['bracket', 'checkin', 'match', 'team', 'tournament']);
  });

  it('регистрируется в реестре ядра без конфликтов имён', () => {
    const registry = buildRegistry([moduleWith().module]);

    expect(registry.commands.size).toBe(5);
    expect(registry.jobs).toHaveLength(1);
  });

  it('объявляет обработчик нажатий на interactionCreate', () => {
    const events = moduleWith().module.events;

    expect(events).toHaveLength(1);
    expect(events?.[0]?.event).toBe('interactionCreate');
  });

  it('объявляет джобу автоподтверждения каждые пять минут', () => {
    const jobs = moduleWith().module.jobs;

    expect(jobs?.[0]?.name).toBe('tournaments:auto-confirm');
    expect(jobs?.[0]?.cron).toBe('*/5 * * * *');
  });

  it('джоба подтверждает просроченную заявку', async () => {
    const { module } = moduleWith();
    const fixture = await tournamentWithReadyMatch();

    await required(module.jobs?.[0], 'джоба').run(ctx);

    const [match] = await pg.db.select().from(tournamentMatches).where(eq(tournamentMatches.id, fixture.matchId));
    expect(match?.state).toBe('confirmed');
  });

  it('на match.ready создаёт ветку под матч', async () => {
    const { module, bus, calls } = moduleWith();
    const fixture = await tournamentWithReadyMatch();
    await module.setup?.(ctx);

    await bus.emit('match.ready', { tournamentId: fixture.tournamentId, matchId: fixture.matchId, round: 1 });

    expect(calls.threads).toBe(1);
    const [match] = await pg.db.select().from(tournamentMatches).where(eq(tournamentMatches.id, fixture.matchId));
    expect(match?.threadId).toBe('thread-1');
  });

  it('сообщает организатору в канал объявлений, когда ветку создать не удалось', async () => {
    const { module, bus, calls } = moduleWith({ threadsFail: true });
    const fixture = await tournamentWithReadyMatch();
    await module.setup?.(ctx);

    await bus.emit('match.ready', { tournamentId: fixture.tournamentId, matchId: fixture.matchId, round: 1 });

    const complaint = calls.posts.find((post) => post.content.includes('Не удалось создать ветку'));
    expect(complaint?.channelId).toBe(ANNOUNCE);
    const [match] = await pg.db.select().from(tournamentMatches).where(eq(tournamentMatches.id, fixture.matchId));
    // Матч остаётся играбельным: ветка — удобство, а не носитель состояния.
    expect(match?.threadId).toBeNull();
    expect(match?.state).toBe('reported');
  });

  it('на match.confirmed архивирует ветку матча', async () => {
    const { module, bus, calls } = moduleWith();
    const fixture = await tournamentWithReadyMatch();
    await module.setup?.(ctx);
    await bus.emit('match.ready', { tournamentId: fixture.tournamentId, matchId: fixture.matchId, round: 1 });

    await bus.emit('match.confirmed', {
      tournamentId: fixture.tournamentId,
      matchId: fixture.matchId,
      winnerEntrantId: 1,
    });

    expect(calls.archived).toEqual(['thread-1']);
  });

  it('на tournament.started и tournament.finished пишет в канал объявлений', async () => {
    const { module, bus, calls } = moduleWith();
    const fixture = await tournamentWithReadyMatch();
    await module.setup?.(ctx);

    await bus.emit('tournament.started', { tournamentId: fixture.tournamentId, guildId: GUILD, entrants: 2 });
    await bus.emit('tournament.finished', {
      tournamentId: fixture.tournamentId,
      guildId: GUILD,
      winnerEntrantId: 1,
      winnerUserIds: [A1],
    });

    const announcements = calls.posts.filter((post) => post.channelId === ANNOUNCE);
    expect(announcements).toHaveLength(2);
    expect(announcements[1]?.content).toContain(`<@${A1}>`);
  });
});
```

- [ ] **Step 2: Написать падающий сквозной тест**

Файл `tests/integration/tournaments/acceptance.test.ts`. Это критерий готовности из спеки, собранный целиком: организатор создаёт командный турнир по LoL с требованием подтверждённой привязки и жеребьёвкой по рангу, команды записываются, старт строит сетку, участники репортят и подтверждают, спорный матч разбирает администратор, победитель определён, событие опубликовано.

```ts
import { and, asc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { EventBus } from '../../../src/core/events/bus.js';
import type { BotEvents } from '../../../src/core/events/events.js';
import { createLogger } from '../../../src/core/logger.js';
import { users } from '../../../src/core/db/schema/core.js';
import { gameAccounts, rankSnapshots } from '../../../src/modules/identity/schema.js';
import type { DiscordGateway } from '../../../src/modules/tournaments/discord/gateway.js';
import { createIdentityLookup } from '../../../src/modules/tournaments/identity-port.js';
import { tournamentEntrants, tournamentMatches, tournaments } from '../../../src/modules/tournaments/schema.js';
import { createAnnounceService } from '../../../src/modules/tournaments/services/announce.js';
import { createMatchesService } from '../../../src/modules/tournaments/services/matches.js';
import { createRegistrationService } from '../../../src/modules/tournaments/services/registration.js';
import { createStartService } from '../../../src/modules/tournaments/services/start.js';
import { createTeamsService } from '../../../src/modules/tournaments/services/teams.js';
import { createTournamentsService } from '../../../src/modules/tournaments/services/tournaments.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();
const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

const GUILD = '170000000000000001';
const PARENT = '170000000000000002';
const ANNOUNCE = '170000000000000003';
const ADMIN = '179999999999999999';
/** Восемь команд по пять человек — ровно тот состав, что назван в критерии готовности. */
const TEAM_COUNT = 8;
const TEAM_SIZE = 5;
const PLAYERS = Array.from(
  { length: TEAM_COUNT * TEAM_SIZE },
  (_unused, index) => `17100000000000${String(index + 100)}`,
);
/**
 * Ранг команды по её номеру: восемь строго убывающих значений rankScore, чтобы
 * жеребьёвку по рангу можно было проверить числом, а не на глаз (индексы RIOT_TIERS:
 * DIAMOND 6, EMERALD 5, PLATINUM 4, GOLD 3, SILVER 2, BRONZE 1, IRON 0;
 * DIVISION_ORDER: I → 3, IV → 0; очки обрезаются сотней):
 * DIAMOND I 50 = 6·1000 + 3·100 + 50 = 6350; DIAMOND IV 50 = 6050; EMERALD I = 5350;
 * PLATINUM I = 4350; GOLD I = 3350; SILVER I = 2350; BRONZE I = 1350; IRON I = 350.
 */
const TEAM_RANKS: Array<{ tier: string; division: string }> = [
  { tier: 'DIAMOND', division: 'I' },
  { tier: 'DIAMOND', division: 'IV' },
  { tier: 'EMERALD', division: 'I' },
  { tier: 'PLATINUM', division: 'I' },
  { tier: 'GOLD', division: 'I' },
  { tier: 'SILVER', division: 'I' },
  { tier: 'BRONZE', division: 'I' },
  { tier: 'IRON', division: 'I' },
];

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} отсутствует`);
  return value;
}

function services(bus: EventBus) {
  const identity = createIdentityLookup({ db: pg.db });
  const tournamentsService = createTournamentsService({ db: pg.db, bus });
  const teams = createTeamsService({ db: pg.db, identity, tournaments: tournamentsService });
  const registration = createRegistrationService({ db: pg.db, identity, tournaments: tournamentsService });
  const start = createStartService({
    db: pg.db,
    identity,
    teams,
    tournaments: tournamentsService,
    bus,
    logger,
  });
  const matches = createMatchesService({ db: pg.db, bus, logger });
  const gateway: DiscordGateway = {
    createMatchThread: vi.fn<DiscordGateway['createMatchThread']>(async () => 'thread'),
    post: vi.fn<DiscordGateway['post']>(async () => {}),
    archiveThread: vi.fn<DiscordGateway['archiveThread']>(async () => {}),
    notifyUser: vi.fn<DiscordGateway['notifyUser']>(async () => {}),
  };
  const announce = createAnnounceService({ db: pg.db, gateway, logger });
  return { tournamentsService, teams, registration, start, matches, announce };
}

/** Подтверждённая привязка LoL и снимок ранга: без них турнир с require_verified никого не пустит. */
beforeAll(async () => {
  await pg.db.insert(users).values(PLAYERS.map((id) => ({ id })));
  await pg.db.insert(users).values({ id: ADMIN }).onConflictDoNothing();

  for (const [index, userId] of PLAYERS.entries()) {
    const [account] = await pg.db
      .insert(gameAccounts)
      .values({
        userId,
        provider: 'riot-lol',
        externalId: `PUUID-ACC-${index}`,
        displayName: `Игрок${index}#EUW`,
        region: 'euw1',
        verifiedAt: new Date('2026-07-01T00:00:00Z'),
        verificationMethod: 'riot-third-party-code',
      })
      .returning();

    const rank = required(TEAM_RANKS[Math.floor(index / TEAM_SIZE)], 'ранг команды');
    await pg.db.insert(rankSnapshots).values({
      accountId: required(account, 'привязка').id,
      mode: 'solo-duo',
      scale: 'riot-tier',
      tier: rank.tier,
      division: rank.division,
      points: 50,
      source: 'api',
      raw: {},
    });
  }
});

async function fullTournament(bus: EventBus): Promise<{ tournamentId: number }> {
  const { tournamentsService, teams } = services(bus);
  const { tournament } = await tournamentsService.create({
    guildId: GUILD,
    name: 'Кубок сервера',
    game: 'lol',
    entryMode: 'team',
    teamSize: TEAM_SIZE,
    maxEntrants: TEAM_COUNT,
    seeding: 'rank',
    bestOf: 3,
    requireVerified: true,
    createdBy: ADMIN,
    announceChannelId: ANNOUNCE,
    matchParentId: PARENT,
  });
  await tournamentsService.open(tournament.id, GUILD);

  for (let team = 0; team < TEAM_COUNT; team += 1) {
    const captain = required(PLAYERS[team * TEAM_SIZE], 'капитан');
    await teams.create({
      tournamentId: tournament.id,
      guildId: GUILD,
      captainUserId: captain,
      name: `Команда ${team + 1}`,
    });
    for (let slot = 1; slot < TEAM_SIZE; slot += 1) {
      const mate = required(PLAYERS[team * TEAM_SIZE + slot], 'игрок состава');
      await teams.invite({ tournamentId: tournament.id, guildId: GUILD, captainUserId: captain, userId: mate });
    }
  }

  return { tournamentId: tournament.id };
}

const captainOf = (team: number): string => required(PLAYERS[team * TEAM_SIZE], 'капитан');

describe('критерий готовности: турнир целиком, не выходя из Discord', () => {
  it('проводит турнир на восемь команд по пять человек от создания до победителя', async () => {
    const bus = new EventBus(logger);
    const finished: Array<BotEvents['tournament.finished']> = [];
    bus.on('tournament.finished', (payload) => {
      finished.push(payload);
    });

    const { registration, start, matches } = services(bus);
    const { tournamentId } = await fullTournament(bus);

    // Чек-ин доступен участникам и на состав сетки не влияет.
    await registration.checkIn({ tournamentId, guildId: GUILD, userId: captainOf(0) });

    const started = await start.start({ tournamentId, guildId: GUILD });
    expect(started.entrants).toBe(TEAM_COUNT);
    expect(started.size).toBe(8);
    expect(started.rounds).toBe(3);
    expect(started.matches).toHaveLength(7);
    expect(started.readyMatches).toHaveLength(4);
    // Восемь участников на сетку из восьми — пропусков быть не должно.
    expect(started.byeMatches).toHaveLength(0);

    // Жеребьёвка по рангу: сиды строго по силе состава, от сильнейшей команды к слабейшей.
    const seeded = await pg.db
      .select()
      .from(tournamentEntrants)
      .where(eq(tournamentEntrants.tournamentId, tournamentId))
      .orderBy(asc(tournamentEntrants.seed));
    expect(seeded.map((entrant) => entrant.displayName)).toEqual(
      Array.from({ length: TEAM_COUNT }, (_unused, index) => `Команда ${index + 1}`),
    );

    /**
     * Играем все три круга. Победителем всегда объявляется сторона a — кроме одного
     * матча первого круга, который соперник оспаривает и который разбирает
     * администратор. Итог предсказуем: сторона a первого круга — это всегда старший
     * сеяный пары, поэтому побеждает первый сеяный, а спорный матч в слоте 1 на его
     * путь не влияет (он меняет только соперника во втором круге).
     */
    let disputesLeft = 1;
    for (let round = 1; round <= 3; round += 1) {
      const inRound = await pg.db
        .select()
        .from(tournamentMatches)
        .where(and(eq(tournamentMatches.tournamentId, tournamentId), eq(tournamentMatches.round, round)))
        .orderBy(asc(tournamentMatches.slot));

      expect(inRound.every((match) => match.state === 'ready')).toBe(true);

      for (const match of inRound) {
        const sides = await matches.sidesOf(match.id);
        const reporter = required(sides.aUserIds[0], 'игрок стороны a');
        const rival = required(sides.bUserIds[0], 'игрок стороны b');

        await matches.report({
          matchId: match.id,
          userId: reporter,
          winnerEntrantId: required(match.entrantAId, 'участник a'),
        });

        if (disputesLeft > 0 && round === 1 && match.slot === 1) {
          disputesLeft -= 1;
          await matches.dispute({ matchId: match.id, userId: rival, reason: 'счёт на второй карте неверный' });
          // Бот спор не решает никогда — победителя назначает администратор.
          const resolved = await matches.resolve({
            matchId: match.id,
            guildId: GUILD,
            adminUserId: ADMIN,
            side: 'b',
          });
          expect(resolved.changed).toBe(true);
          continue;
        }

        const outcome = await matches.confirm({ matchId: match.id, userId: rival });
        expect(outcome.changed).toBe(true);
      }
    }

    // Победитель определён, турнир завершён, событие опубликовано ровно один раз.
    const [tournament] = await pg.db.select().from(tournaments).where(eq(tournaments.id, tournamentId));
    expect(tournament?.state).toBe('finished');
    expect(tournament?.finishedAt).toBeInstanceOf(Date);

    const champion = required(seeded[0], 'первый сеяный');
    expect(finished).toHaveLength(1);
    expect(finished[0]?.winnerEntrantId).toBe(champion.id);
    expect(finished[0]?.winnerUserIds).toHaveLength(TEAM_SIZE);
    expect(finished[0]?.guildId).toBe(GUILD);

    const all = await pg.db
      .select()
      .from(tournamentMatches)
      .where(eq(tournamentMatches.tournamentId, tournamentId));
    expect(all).toHaveLength(7);
    expect(all.every((match) => match.state === 'confirmed')).toBe(true);
    expect(all.every((match) => match.bestOf === 3)).toBe(true);
  });

  it('не пускает в турнир игрока без подтверждённой привязки', async () => {
    const bus = new EventBus(logger);
    const { tournamentsService, teams } = services(bus);
    const stranger = '178888888888888888';
    await tournamentsService.ensureUser(stranger);

    const { tournament } = await tournamentsService.create({
      guildId: GUILD,
      name: 'Кубок сервера 2',
      game: 'lol',
      entryMode: 'team',
      teamSize: 2,
      maxEntrants: 4,
      seeding: 'rank',
      bestOf: 1,
      requireVerified: true,
      createdBy: ADMIN,
      announceChannelId: null,
      matchParentId: null,
    });
    await tournamentsService.open(tournament.id, GUILD);

    await expect(
      teams.create({ tournamentId: tournament.id, guildId: GUILD, captainUserId: stranger, name: 'Пришлые' }),
    ).rejects.toThrow(/подтверждённый аккаунт League of Legends/);
  });
});
```

- [ ] **Step 3: Запустить тесты — убедиться, что падают**

Run: `npm run test:int -- tests/integration/tournaments/module.test.ts tests/integration/tournaments/acceptance.test.ts`
Expected: FAIL — модуль `src/modules/tournaments/index.js` не найден.

- [ ] **Step 4: Реализовать `src/modules/tournaments/index.ts`**

```ts
import type { Config } from '../../core/config.js';
import type { Database } from '../../core/db/client.js';
import type { EventBus } from '../../core/events/bus.js';
import type { Logger } from '../../core/logger.js';
import type { BotModule } from '../../core/module.js';
import { createMatchButtonHandler } from './buttons.js';
import { createBracketCommand } from './commands/bracket.js';
import { createCheckinCommand } from './commands/checkin.js';
import { createMatchCommand } from './commands/match.js';
import { createTeamCommand } from './commands/team.js';
import { createTournamentCommand } from './commands/tournament.js';
import type { TournamentDeps } from './deps.js';
import type { DiscordGateway } from './discord/gateway.js';
import { createIdentityLookup } from './identity-port.js';
import { createAnnounceService } from './services/announce.js';
import { createMatchesService } from './services/matches.js';
import { createRegistrationService } from './services/registration.js';
import { createStartService } from './services/start.js';
import { createTeamsService } from './services/teams.js';
import { createTournamentsService } from './services/tournaments.js';
import { createViewService } from './services/view.js';

/**
 * Автоподтверждение — cron, а не таймер в памяти: окно 60 минут не переживает
 * перезапуск процесса, а перезапуск бывает при каждом деплое. Раз в пять минут
 * достаточно: точность «плюс-минус пять минут» на часовом окне никого не задевает.
 */
const AUTO_CONFIRM_CRON = '*/5 * * * *';
const AUTO_CONFIRM_BATCH = 50;

export interface TournamentsModuleDeps {
  db: Database;
  bus: EventBus;
  logger: Logger;
  config: Config;
  /** Всё общение с Discord идёт через него. В тестах подменяется заглушкой. */
  gateway: DiscordGateway;
}

export function createTournamentsModule(deps: TournamentsModuleDeps): BotModule {
  const { db, bus, logger, config, gateway } = deps;

  const identity = createIdentityLookup({ db });
  const tournamentsService = createTournamentsService({ db, bus });
  const teams = createTeamsService({ db, identity, tournaments: tournamentsService });
  const registration = createRegistrationService({ db, identity, tournaments: tournamentsService });
  const start = createStartService({ db, identity, teams, tournaments: tournamentsService, bus, logger });
  const matches = createMatchesService({ db, bus, logger });
  const view = createViewService({ db, tournaments: tournamentsService });
  const announce = createAnnounceService({ db, gateway, logger });

  const commandDeps: TournamentDeps = {
    tournaments: tournamentsService,
    registration,
    teams,
    start,
    matches,
    view,
    announce,
    publicBaseUrl: config.PUBLIC_BASE_URL,
  };

  return {
    name: 'tournaments',

    commands: [
      createTournamentCommand(commandDeps),
      createTeamCommand(commandDeps),
      createMatchCommand(commandDeps),
      createCheckinCommand(commandDeps),
      createBracketCommand(commandDeps),
    ],

    events: [createMatchButtonHandler({ matches })],

    jobs: [
      {
        name: 'tournaments:auto-confirm',
        cron: AUTO_CONFIRM_CRON,
        run: async () => {
          await matches.autoConfirmDue(new Date(), AUTO_CONFIRM_BATCH);
        },
      },
    ],

    async setup() {
      // Ветки и объявления — только через шину, уже после коммита транзакций.
      // Ни один из этих обработчиков не читает ModuleContext: всё нужное в deps.
      bus.on('match.ready', async (payload) => {
        const result = await announce.openMatches({
          tournamentId: payload.tournamentId,
          matchIds: [payload.matchId],
        });
        if (result.failed > 0) {
          logger.warn(
            { tournamentId: payload.tournamentId, matchId: payload.matchId },
            'ветку под матч создать не удалось, матч играется без неё',
          );
          // Спека требует не только логировать отсутствие ветки, но и показывать его
          // организатору: в логи он не смотрит, а без ветки участники не поймут, где
          // договариваться. Пишем в канал объявлений — там организатор точно увидит.
          await announce.announce({
            tournamentId: payload.tournamentId,
            content: `Не удалось создать ветку под матч \`#${payload.matchId}\` — проверь права бота на канал матчей. Матч играется, результат репортится как обычно: \`/match report\`.`,
          });
        }
      });

      bus.on('match.confirmed', async (payload) => {
        await announce.archiveMatch(payload.matchId);
      });

      bus.on('tournament.started', async (payload) => {
        await announce.announce({
          tournamentId: payload.tournamentId,
          content: `Турнир начался: участников ${payload.entrants}. Сетка — \`/bracket ${payload.tournamentId}\`.`,
        });
      });

      bus.on('tournament.finished', async (payload) => {
        const winners = payload.winnerUserIds.map((userId) => `<@${userId}>`).join(', ');
        await announce.announce({
          tournamentId: payload.tournamentId,
          content: `Турнир завершён. Победитель: ${winners || 'участник ' + String(payload.winnerEntrantId)}. Спасибо всем!`,
        });
      });
    },
  };
}
```

- [ ] **Step 5: Подключить модуль в `src/modules.ts`**

Файл целиком:

```ts
import type { BotModule } from './core/module.js';
import { createIdentityModule, type IdentityModuleDeps } from './modules/identity/index.js';
import { pingModule } from './modules/ping/index.js';
import { createTournamentsModule, type TournamentsModuleDeps } from './modules/tournaments/index.js';

export interface ModulesDeps {
  identity: IdentityModuleDeps;
  tournaments: TournamentsModuleDeps;
}

/**
 * Единственное место, перечисляющее модули бота: и bootstrap (src/index.ts), и
 * регистрация команд (scripts/deploy-commands.ts) вызывают эту функцию — поэтому
 * набор команд, отправленный в Discord, не может разойтись с тем, что реально
 * запущено. Зависимости сгруппированы по модулям: их наборы почти не пересекаются
 * (турнирам не нужны ни HTTP-клиенты, ни лимитер, ни кэш), и плоский объект на два
 * модуля пришлось бы читать со словарём.
 */
export function buildModules(deps: ModulesDeps): BotModule[] {
  return [pingModule, createIdentityModule(deps.identity), createTournamentsModule(deps.tournaments)];
}
```

- [ ] **Step 6: Подключить модуль в `src/index.ts`**

Добавить импорт:

```ts
import { createDiscordGateway } from './modules/tournaments/discord/gateway.js';
```

и заменить вызов `buildModules` (строки 67-82 текущего файла) на:

```ts
const modules = buildModules({
  identity: {
    db,
    bus,
    logger,
    config,
    cooldown,
    rateLimiter,
    cache,
    fetchClientFor,
    fetchMember: async (guildId, userId) => {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return null;
      // Участник мог покинуть сервер между синхронизацией и выдачей роли.
      return guild.members.fetch(userId).catch(() => null);
    },
  },
  tournaments: {
    db,
    bus,
    logger,
    config,
    gateway: createDiscordGateway({ client, logger }),
  },
});
```

- [ ] **Step 7: Подключить модуль в `scripts/deploy-commands.ts`**

Скрипту нужны только билдеры команд, поэтому шлюз — заглушка, ни один метод которой не вызывается. Заменить вызов `buildModules`:

```ts
const modules = buildModules({
  identity: {
    db,
    bus,
    logger,
    config,
    cooldown: { hit: async () => ({ allowed: true, retryAfterMs: 0 }), close: async () => {} },
    rateLimiter: { acquire: async () => {}, close: async () => {} },
    cache,
    fetchClientFor: () => ({ json: async () => ({}) }) as never,
    fetchMember: async () => null,
  },
  tournaments: {
    db,
    bus,
    logger,
    config,
    gateway: {
      createMatchThread: async () => null,
      archiveThread: async () => {},
      post: async () => {},
      notifyUser: async () => {},
    },
  },
});
```

- [ ] **Step 8: Прогнать всё**

Run: `npm run test:int -- tests/integration/tournaments/module.test.ts tests/integration/tournaments/acceptance.test.ts && npm run typecheck && npm run lint`
Expected: 10 тестов PASS в `module.test.ts`, 2 теста PASS в `acceptance.test.ts`, тайпчек и линт чистые.

Run: `npm test && npm run test:int`
Expected: всё зелёное, включая тесты этапов 0 и 1. Если упал тест этапа 1 — смотреть на `src/modules.ts`: у `buildModules` изменилась форма аргумента.

- [ ] **Step 9: Проверить регистрацию команд вручную**

Run: `npm run deploy-commands`
Expected: в логе `команды зарегистрированы на сервере` и `count: 11` (ping, пять команд identity, пять команд турниров).

- [ ] **Step 10: Коммит**

```bash
git add src/modules/tournaments/index.ts src/modules.ts src/index.ts scripts/deploy-commands.ts tests/integration/tournaments/module.test.ts tests/integration/tournaments/acceptance.test.ts
git commit -m "feat(tournaments): манифест модуля, подключение к ядру и сквозной сценарий турнира"
```

---

## Что этот план сознательно не делает

- **Веб-витрина (раздел 7 спеки)** — отдельный план: маршруты `/t/:id`, `/t/:id/entrants`, `/leaderboard/:game`, `/p/:userId`, `/`, флаг `profile_public` в `users`, кэш готовых страниц в Redis на 60 секунд, приватность. `/bracket` уже выдаёт ссылку `${PUBLIC_BASE_URL}/t/${id}` — от появления страницы она не изменится.
- **Double elimination и Swiss** — колонка `format` заведена значением `'single-elim'`, движок продвижения вынесен в `bracket/advance.ts`, но второй формат не реализуется.
- **Награды за победу** — прогрессия (этап 2) отложена; турнир публикует `tournament.finished` с `winnerUserIds`, и это всё, что от него требуется.
- **Автоопределение исхода по API игры, призовой фонд, автостарт кругов по расписанию** — вне скоупа спеки.

