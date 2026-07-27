# Этап 0: ядро и каркас бота — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Работающий Discord-бот с командой `/ping`, готовой инфраструктурой (Postgres, Redis, миграции, конфиг, логи, метрики, планировщик) и модульным ядром, в которое последующие этапы вставляются без изменения ядра.

**Architecture:** Модульный монолит. Тонкое ядро (`src/core/`) не знает о фичах: оно создаёт Discord-клиент, собирает модули из реестра, маршрутизирует интеракции, держит границу ошибок и предоставляет модулям `ModuleContext` с зависимостями. Модули (`src/modules/`) объявляют команды, слушателей и cron-джобы данными и общаются между собой через типизированную шину событий, а не через прямые импорты.

**Tech Stack:** Node.js 24 LTS, TypeScript (strict, ESM), discord.js 14.27, PostgreSQL 16 + Drizzle ORM, Redis 7 (ioredis), Fastify, pino, zod, prom-client, croner, vitest + Testcontainers (на Podman), Podman Compose + Caddy.

**Spec:** [docs/superpowers/specs/2026-07-27-discord-gaming-bot-design.md](../specs/2026-07-27-discord-gaming-bot-design.md)

## Global Constraints

Требования ниже действуют для **каждой** задачи плана.

- **Node.js `>=24.0.0`.** Версия на машине разработки — 24 LTS. `vitest 4` требует `^20 || ^22 || >=24`, discord.js — `>=18`.
- **Контейнеры — Podman, не Docker.** Testcontainers работает с Podman через docker-совместимый сокет; `podman compose` заменяется на `podman compose`. Переменные `DOCKER_HOST` и `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` настраиваются один раз в окружении и в коде не упоминаются.
- **discord.js `14.27.x`**, Postgres `16`, Redis `7`.
- **TypeScript закреплён на `~5.9.3`, не 7.x.** `typescript-eslint@8` требует `typescript <6.1.0`, а его версии 9+ не существует; TypeScript 7 оставил бы проект без линтера. `@types/node` — `^24`, строго под рантайм.
- **ESM.** В `package.json` стоит `"type": "module"`, в `tsconfig` — `"module": "nodenext"`. Следствие, которое ломает сборку чаще всего: **все относительные импорты пишутся с расширением `.js`**, даже когда файл на диске `.ts` (`import { loadConfig } from './config.js'`).
- **TypeScript strict**, включая `noUncheckedIndexedAccess` и `exactOptionalPropertyTypes`. `any` допустим только со строкой комментария, объясняющей почему.
- **Snowflake-идентификаторы Discord хранятся и передаются как `text`/`string`.** Никогда как число.
- **Все времена — `timestamptz` в UTC.** XP, валюта, LP — целые числа, никогда float.
- **Эфемерные ответы — через `flags: MessageFlags.Ephemeral`.** Опция `ephemeral: true` объявлена deprecated в discord.js и в новом коде не используется.
- **Ответ на интеракцию не позже 3 секунд.** Любой хендлер, делающий сетевой вызов или запрос к БД дольше одного простого SELECT, обязан начинаться с `deferReply()`.
- **Пользовательские строки и комментарии — по-русски.** В zod сообщение задаётся параметром схемы (`z.string({ error: '…' })`), а не вторым аргументом `.min()` / `.regex()`: второй аргумент привязан только к своей проверке и не покрывает базовую проверку типа, поэтому у отсутствующего значения протекает английский текст zod.
- **Коммиты в стиле conventional commits** (`feat:`, `fix:`, `chore:`, `test:`, `docs:`).
- **Значения из спеки, не подлежащие изменению:** TTL кэша — профиль 24 ч (просроченное отдавать до 7 суток), ранг 20 мин (до 24 ч), история матчей 5 мин (до 1 ч); челлендж верификации 15 минут и 5 попыток; кулдаун `/ranksync` 10 минут; таймаут внешнего вызова 5 секунд при 3 попытках; circuit breaker открывается после 5 подряд сбоев и пробует снова через 60 секунд; cron синхронизации — каждые 30 минут по 100 аккаунтов.

## Структура файлов

Создаётся на этапе 0. Каждый файл имеет одну ответственность; ядро не импортирует ничего из `src/modules/`.

| Файл | Ответственность |
|---|---|
| `package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `vitest.integration.config.ts` | сборка, типы, линт, тесты |
| `drizzle.config.ts` | генерация миграций |
| `.env.example`, `.gitignore` | контракт окружения, игнор |
| `src/core/config.ts` | zod-схема окружения, падение на старте |
| `src/core/errors.ts` | `UserError` / `ProviderError` / `BugError`, генерация кода инцидента |
| `src/core/logger.ts` | pino, редакция секретов |
| `src/core/db/schema/core.ts` | таблицы `guilds`, `users`, `members`, `audit_log` |
| `src/core/db/schema/index.ts` | точка сборки схем всех модулей |
| `src/core/db/client.ts` | пул Postgres, экземпляр Drizzle, закрытие |
| `src/core/cache.ts` | Redis-обёртка, stale-while-revalidate, лок от стампида |
| `src/core/events/events.ts` | карта событий `BotEvents` — единственное место связи модулей |
| `src/core/events/bus.ts` | типизированная шина с изоляцией ошибок обработчиков |
| `src/core/module.ts` | типы `BotModule`, `ModuleContext`, `CommandDefinition`, `ScheduledJob` |
| `src/core/registry.ts` | сборка модулей, проверка уникальности имён |
| `src/core/commands/router.ts` | маршрутизация интеракций, граница ошибок, авто-defer |
| `src/core/metrics.ts` | реестр Prometheus и метрики команд |
| `src/core/http/server.ts` | Fastify: `/healthz`, `/metrics` |
| `src/core/scheduler.ts` | запуск cron-джоб модулей с защитой от наложения |
| `src/core/client.ts` | фабрика Discord-клиента и набор интентов |
| `src/core/shutdown.ts` | graceful shutdown, учёт незавершённой работы |
| `src/index.ts` | bootstrap: связывание всего перечисленного |
| `src/modules/ping/index.ts` | эталонный модуль-образец |
| `scripts/migrate.ts` | применение миграций отдельным шагом |
| `scripts/deploy-commands.ts` | guild-scoped регистрация slash-команд |
| `tests/helpers/postgres.ts` | Testcontainers-хелпер для интеграционных тестов |
| `tests/helpers/redis.ts` | Testcontainers-хелпер для Redis |
| `tests/helpers/interaction.ts` | фейковая интеракция для тестов хендлеров |
| `Dockerfile`, `docker-compose.yml`, `Caddyfile`, `.github/workflows/ci.yml` | деплой и CI |

---

### Task 1: Каркас проекта

**Files:**
- Create: `package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: ничего.
- Produces: команды `npm run typecheck`, `npm run lint`, `npm test`; ESM-окружение с `.js`-расширениями в импортах.

- [ ] **Step 1: Создать `package.json`**

```json
{
  "name": "dis-bot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/src/index.js",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run",
    "test:int": "vitest run --config vitest.integration.config.ts",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx scripts/migrate.ts",
    "deploy-commands": "tsx scripts/deploy-commands.ts"
  },
  "dependencies": {
    "croner": "^10.0.1",
    "discord.js": "^14.27.0",
    "drizzle-orm": "^0.45.2",
    "fastify": "^5.10.0",
    "ioredis": "^5.11.1",
    "pg": "^8.22.0",
    "pino": "^10.3.1",
    "prom-client": "^15.1.3",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@testcontainers/postgresql": "^12.0.4",
    "@testcontainers/redis": "^12.0.4",
    "@types/node": "^24.13.3",
    "@types/pg": "^8.20.0",
    "drizzle-kit": "^0.31.10",
    "eslint": "^10.8.0",
    "pino-pretty": "^13.1.3",
    "tsx": "^4.23.1",
    "typescript": "~5.9.3",
    "typescript-eslint": "^8.65.0",
    "vitest": "^4.1.10"
  }
}
```

**TypeScript намеренно остаётся на 5.9, хотя вышел 7.x.** `typescript-eslint@8.65.0`
объявляет peer-зависимость `typescript: >=4.8.4 <6.1.0`, а версии 9+ у него не
выпущено. Взять TypeScript 7 — значит остаться без линтера вообще. Диапазон записан
как `~5.9.3`, чтобы `npm install` не подтянул мажор молча. Пересматривать после
выхода `typescript-eslint`, поддерживающего 7.x.

**`@types/node` привязан к 24.x, а не к последней 26.x** — типы должны соответствовать
рантайму, иначе компилятор разрешит вызовы API, которых на Node 24 нет.

- [ ] **Step 2: Создать `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src", "scripts", "tests"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: Создать `eslint.config.js`**

```js
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'src/core/db/migrations/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'off',
      'no-console': 'error',
    },
  },
);
```

- [ ] **Step 4: Создать `vitest.config.ts`**

Интеграционные тесты исключены — они требуют запущенную podman-машину и запускаются отдельной командой.

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', 'tests/contract/**', 'node_modules/**'],
    environment: 'node',
  },
});
```

- [ ] **Step 5: Создать `.gitignore`**

```gitignore
node_modules/
dist/
.env
.env.*
!.env.example
*.log
coverage/
```

- [ ] **Step 6: Создать `.env.example`**

```dotenv
NODE_ENV=development
LOG_LEVEL=debug

# Discord Developer Portal → Bot → Token
DISCORD_TOKEN=
# Discord Developer Portal → General Information → Application ID
DISCORD_APP_ID=
# ID сервера: правый клик по серверу → Copy Server ID (нужен режим разработчика)
DISCORD_GUILD_ID=

DATABASE_URL=postgres://bot:bot@localhost:5432/disbot
REDIS_URL=redis://localhost:6379

HTTP_PORT=3000
# Публичный HTTPS-адрес бота. Нужен для OAuth-колбэков на этапе 1.
PUBLIC_BASE_URL=https://bot.example.com

# Необязательны на этапе 0.
STEAM_API_KEY=
RIOT_API_KEY=
```

- [ ] **Step 7: Написать падающий тест**

Файл `tests/smoke.test.ts`. Проверяет ровно одно: что ESM-импорт с расширением `.js` работает и тестовый прогон настроен.

```ts
import { describe, expect, it } from 'vitest';
import { projectName } from '../src/core/meta.js';

describe('каркас проекта', () => {
  it('экспортирует имя проекта', () => {
    expect(projectName).toBe('dis-bot');
  });
});
```

- [ ] **Step 8: Установить зависимости и запустить тест — убедиться, что падает**

Run: `npm install && npm test`
Expected: FAIL — `Cannot find module '../src/core/meta.js'`.

- [ ] **Step 9: Минимальная реализация**

Файл `src/core/meta.ts`:

```ts
export const projectName = 'dis-bot';
```

- [ ] **Step 10: Прогнать тест, линт и типы**

Run: `npm test && npm run typecheck && npm run lint`
Expected: тест PASS, `typecheck` и `lint` без ошибок.

- [ ] **Step 11: Коммит**

```bash
git add package.json package-lock.json tsconfig.json eslint.config.js vitest.config.ts .gitignore .env.example src/core/meta.ts tests/smoke.test.ts
git commit -m "chore: каркас проекта на TypeScript ESM с vitest и eslint"
```

---

### Task 2: Конфигурация окружения

**Files:**
- Create: `src/core/config.ts`
- Test: `tests/core/config.test.ts`

**Interfaces:**
- Consumes: ничего.
- Produces: `type Config = z.infer<typeof envSchema>` с полями `NODE_ENV`, `LOG_LEVEL`, `DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_GUILD_ID`, `DATABASE_URL`, `REDIS_URL`, `HTTP_PORT: number`, `PUBLIC_BASE_URL`, `STEAM_API_KEY?`, `RIOT_API_KEY?`; функция `loadConfig(env?: NodeJS.ProcessEnv): Config`, бросающая `Error` с перечислением всех проблем.

- [ ] **Step 1: Написать падающие тесты**

Файл `tests/core/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';

const valid = {
  DISCORD_TOKEN: 'token',
  DISCORD_APP_ID: '123456789012345678',
  DISCORD_GUILD_ID: '876543210987654321',
  DATABASE_URL: 'postgres://bot:bot@localhost:5432/disbot',
  REDIS_URL: 'redis://localhost:6379',
  PUBLIC_BASE_URL: 'https://bot.example.com',
};

describe('loadConfig', () => {
  it('заполняет значения по умолчанию', () => {
    const config = loadConfig(valid);
    expect(config.NODE_ENV).toBe('development');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.HTTP_PORT).toBe(3000);
  });

  it('приводит HTTP_PORT к числу', () => {
    const config = loadConfig({ ...valid, HTTP_PORT: '8080' });
    expect(config.HTTP_PORT).toBe(8080);
  });

  it('перечисляет в сообщении все отсутствующие параметры сразу', () => {
    let message = '';
    try {
      loadConfig({ DISCORD_TOKEN: 'token' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('REDIS_URL');
    expect(message).toContain('DISCORD_APP_ID');
  });

  it('пишет сообщения по-русски и для полностью отсутствующих переменных', () => {
    // Регрессия: второй аргумент .min()/.regex() не покрывает базовую проверку типа,
    // из-за чего у отсутствующих переменных протекал английский текст zod.
    let message = '';
    try {
      loadConfig({ DISCORD_TOKEN: 'token' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toMatch(/Invalid input/);
    expect(message).not.toMatch(/expected string/);
    expect(message).toContain('обязателен');
  });

  it('отвергает snowflake неверного формата', () => {
    expect(() => loadConfig({ ...valid, DISCORD_APP_ID: 'не-число' })).toThrow(/DISCORD_APP_ID/);
  });

  it('считает пустую строку необязательного ключа отсутствующим значением', () => {
    const config = loadConfig({ ...valid, RIOT_API_KEY: '' });
    expect(config.RIOT_API_KEY).toBeUndefined();
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `npx vitest run tests/core/config.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/config.js'`.

- [ ] **Step 3: Реализовать `src/core/config.ts`**

`emptyToUndefined` нужен потому, что `.env`-файлы почти всегда содержат `RIOT_API_KEY=` — пустую строку, которую zod без препроцессора примет как заданное значение.

```ts
import { z } from 'zod';

// Сообщение задаётся параметром схемы `{ error }`, а не вторым аргументом .min()/.regex().
// Второй аргумент привязывается только к своей проверке и НЕ покрывает базовую проверку
// типа: при полностью отсутствующей переменной zod сначала выдаёт invalid_type по-английски,
// и русское сообщение недостижимо. Параметр схемы покрывает оба случая.
const snowflake = z
  .string({ error: 'ожидается Discord snowflake из 17–20 цифр' })
  .regex(/^\d{17,20}$/);

const emptyToUndefined = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production'], { error: 'допустимо: development, test, production' }).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'], { error: 'допустимо: trace, debug, info, warn, error, fatal' }).default('info'),

  DISCORD_TOKEN: z.string({ error: 'обязателен' }).min(1),
  DISCORD_APP_ID: snowflake,
  DISCORD_GUILD_ID: snowflake,

  DATABASE_URL: z.string({ error: 'обязателен' }).min(1),
  REDIS_URL: z.string({ error: 'обязателен' }).min(1),

  HTTP_PORT: z.coerce.number({ error: 'ожидается целое число порта от 1 до 65535' }).int().min(1).max(65535).default(3000),
  PUBLIC_BASE_URL: z.url('ожидается абсолютный URL'),

  STEAM_API_KEY: emptyToUndefined(z.string().min(1).optional()),
  RIOT_API_KEY: emptyToUndefined(z.string().min(1).optional()),
});

export type Config = z.infer<typeof envSchema>;

/**
 * Валидирует окружение целиком. Бросает одну ошибку, перечисляя в ней все найденные
 * проблемы, — чтобы не выяснять их по одной за пять перезапусков.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (parsed.success) return parsed.data;

  const details = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(корень)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Некорректная конфигурация окружения:\n${details}`);
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `npx vitest run tests/core/config.test.ts && npm run typecheck`
Expected: 5 тестов PASS, типы чистые.

- [ ] **Step 5: Коммит**

```bash
git add src/core/config.ts tests/core/config.test.ts
git commit -m "feat: валидация конфигурации окружения через zod"
```

---

### Task 3: Классы ошибок и логгер

**Files:**
- Create: `src/core/errors.ts`, `src/core/logger.ts`
- Test: `tests/core/errors.test.ts`

**Interfaces:**
- Consumes: `Config` из Task 2.
- Produces: классы `UserError`, `ProviderError`, `BugError` с дискриминантом `kind`; `newIncidentId(): string`; `describeForUser(error: unknown): { text: string; incidentId?: string }`; `type Logger = pino.Logger`; `createLogger(config: Config): Logger`.

- [ ] **Step 1: Написать падающие тесты**

Файл `tests/core/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BugError, ProviderError, UserError, describeForUser, newIncidentId } from '../../src/core/errors.js';

describe('newIncidentId', () => {
  it('возвращает шесть шестнадцатеричных символов', () => {
    expect(newIncidentId()).toMatch(/^[0-9a-f]{6}$/);
  });

  it('не повторяется', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newIncidentId()));
    expect(ids.size).toBeGreaterThan(190);
  });
});

describe('describeForUser', () => {
  it('показывает текст UserError как есть и не выдаёт код инцидента', () => {
    const result = describeForUser(new UserError('Такой аккаунт уже привязан.'));
    expect(result.text).toBe('Такой аккаунт уже привязан.');
    expect(result.incidentId).toBeUndefined();
  });

  it('называет провайдера при ProviderError, но не раскрывает детали', () => {
    const result = describeForUser(new ProviderError('502 Bad Gateway', 'riot-lol'));
    expect(result.text).toContain('riot-lol');
    expect(result.text).not.toContain('502');
    expect(result.incidentId).toBeUndefined();
  });

  it('выдаёт код инцидента для BugError', () => {
    const result = describeForUser(new BugError('обращение к null'));
    expect(result.incidentId).toMatch(/^[0-9a-f]{6}$/);
    expect(result.text).toContain(result.incidentId!);
    expect(result.text).not.toContain('обращение к null');
  });

  it('обрабатывает произвольное брошенное значение как баг', () => {
    const result = describeForUser('строка вместо ошибки');
    expect(result.incidentId).toMatch(/^[0-9a-f]{6}$/);
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `npx vitest run tests/core/errors.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `src/core/errors.ts`**

```ts
import { randomBytes } from 'node:crypto';

/** Ошибка, текст которой предназначен пользователю и показывается дословно. */
export class UserError extends Error {
  readonly kind = 'user' as const;
}

/** Сбой внешнего сервиса. Детали идут в лог, пользователю — имя провайдера. */
export class ProviderError extends Error {
  readonly kind = 'provider' as const;

  constructor(
    message: string,
    readonly provider: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** Наша ошибка. Пользователю — только код инцидента, детали в лог. */
export class BugError extends Error {
  readonly kind = 'bug' as const;
}

export function newIncidentId(): string {
  return randomBytes(3).toString('hex');
}

export interface UserFacingError {
  text: string;
  /** Задан только когда ошибка наша: по нему находится стек в логах. */
  incidentId?: string;
}

export function describeForUser(error: unknown): UserFacingError {
  if (error instanceof UserError) {
    return { text: error.message };
  }
  if (error instanceof ProviderError) {
    return {
      text: `Сервис ${error.provider} сейчас недоступен. Попробуй позже — данные подтянутся сами.`,
    };
  }
  const incidentId = newIncidentId();
  return {
    text: `Что-то сломалось на нашей стороне. Код инцидента: \`${incidentId}\` — покажи его администратору.`,
    incidentId,
  };
}
```

- [ ] **Step 4: Реализовать `src/core/logger.ts`**

Редакция обязательна: токен бота и ключи API не должны попасть в лог ни при каком стечении обстоятельств.

```ts
import { pino } from 'pino';
import type { Config } from './config.js';

export type Logger = pino.Logger;

export function createLogger(config: Config): Logger {
  return pino({
    level: config.LOG_LEVEL,
    redact: {
      paths: [
        'config.DISCORD_TOKEN',
        'config.STEAM_API_KEY',
        'config.RIOT_API_KEY',
        'headers.authorization',
        'headers["x-riot-token"]',
      ],
      censor: '[вырезано]',
    },
    ...(config.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
      : {}),
  });
}
```

- [ ] **Step 5: Прогнать тесты**

Run: `npx vitest run tests/core/errors.test.ts && npm run typecheck`
Expected: 5 тестов PASS.

- [ ] **Step 6: Коммит**

```bash
git add src/core/errors.ts src/core/logger.ts tests/core/errors.test.ts
git commit -m "feat: классы ошибок с кодами инцидентов и структурированный логгер"
```

---

### Task 4: Схема базы, клиент и миграции

**Files:**
- Create: `src/core/db/schema/core.ts`, `src/core/db/schema/index.ts`, `src/core/db/client.ts`, `drizzle.config.ts`, `scripts/migrate.ts`, `vitest.integration.config.ts`, `tests/helpers/postgres.ts`
- Test: `tests/integration/db/core-schema.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 2), `Logger` (Task 3).
- Produces: таблицы `guilds`, `users`, `members`, `auditLog`; `type Database = NodePgDatabase<typeof schema>`; `createDatabase(config: Config): { db: Database; close(): Promise<void> }`; `runMigrations(config: Config, logger: Logger): Promise<void>`; хелпер `withPostgres()` для интеграционных тестов.

- [ ] **Step 1: Написать схему `src/core/db/schema/core.ts`**

```ts
import { bigserial, index, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/** Настройки сервера. Схема внутри jsonb принадлежит модулям, не ядру. */
export type GuildSettings = Record<string, unknown>;

export const guilds = pgTable('guilds', {
  id: text('id').primaryKey(),
  settings: jsonb('settings').$type<GuildSettings>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const members = pgTable(
  'members',
  {
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    guildId: text('guild_id').notNull(),
    /** NULL означает действие самого бота, а не человека. */
    actorId: text('actor_id'),
    action: text('action').notNull(),
    targetId: text('target_id'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('audit_log_guild_created_idx').on(table.guildId, table.createdAt.desc())],
);
```

- [ ] **Step 2: Создать точку сборки `src/core/db/schema/index.ts`**

Каждый следующий модуль добавляет сюда одну строку реэкспорта — это единственное место, которое знает обо всех таблицах.

```ts
export * from './core.js';
```

- [ ] **Step 3: Создать `src/core/db/client.ts`**

```ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Config } from '../config.js';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

export function createDatabase(config: Config): { db: Database; close: () => Promise<void> } {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5_000,
  });
  return {
    db: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}
```

- [ ] **Step 4: Создать `drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/core/db/schema/index.ts',
  out: './src/core/db/migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
});
```

- [ ] **Step 5: Сгенерировать миграцию**

Run: `npm run db:generate`
Expected: появился `src/core/db/migrations/0000_*.sql` с четырьмя `CREATE TABLE` и индексом `audit_log_guild_created_idx`. Открыть файл и глазами проверить, что все временные колонки объявлены как `timestamp with time zone`.

- [ ] **Step 6: Создать `scripts/migrate.ts`**

Миграции применяются отдельным шагом деплоя, а не при первом запросе к боту.

```ts
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../src/core/config.js';
import { createDatabase } from '../src/core/db/client.js';
import { createLogger } from '../src/core/logger.js';

const config = loadConfig();
const logger = createLogger(config);
const { db, close } = createDatabase(config);

try {
  await migrate(db, { migrationsFolder: 'src/core/db/migrations' });
  logger.info('миграции применены');
} catch (error) {
  logger.error({ err: error }, 'миграции не применились');
  process.exitCode = 1;
} finally {
  await close();
}
```

- [ ] **Step 7: Создать `vitest.integration.config.ts`**

Интеграционные тесты поднимают контейнеры, поэтому им нужен большой таймаут и запрет параллельного выполнения файлов.

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
```

- [ ] **Step 8: Создать хелпер `tests/helpers/postgres.ts`**

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { createDatabase, type Database } from '../../src/core/db/client.js';

interface PostgresFixture {
  get db(): Database;
}

/**
 * Поднимает настоящий Postgres в контейнере и применяет миграции.
 * Мок здесь не годится: половина проверяемого поведения живёт в ограничениях схемы.
 */
export function withPostgres(): PostgresFixture {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    const config = loadConfig({
      DISCORD_TOKEN: 'test',
      DISCORD_APP_ID: '123456789012345678',
      DISCORD_GUILD_ID: '876543210987654321',
      DATABASE_URL: container.getConnectionUri(),
      REDIS_URL: 'redis://localhost:6379',
      PUBLIC_BASE_URL: 'https://test.example.com',
      NODE_ENV: 'test',
    });
    const created = createDatabase(config);
    db = created.db;
    close = created.close;
    await migrate(db, { migrationsFolder: 'src/core/db/migrations' });
  });

  afterAll(async () => {
    await close?.();
    await container?.stop();
  });

  return {
    get db() {
      return db;
    },
  };
}
```

- [ ] **Step 9: Написать падающий интеграционный тест**

Файл `tests/integration/db/core-schema.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditLog, guilds, members, users } from '../../../src/core/db/schema/index.js';
import { withPostgres } from '../../helpers/postgres.js';

const pg = withPostgres();

describe('схема ядра', () => {
  it('сохраняет сервер, пользователя и участника', async () => {
    await pg.db.insert(guilds).values({ id: '111111111111111111' });
    await pg.db.insert(users).values({ id: '222222222222222222' });
    await pg.db.insert(members).values({
      guildId: '111111111111111111',
      userId: '222222222222222222',
      joinedAt: new Date(),
    });

    const rows = await pg.db.select().from(members).where(eq(members.guildId, '111111111111111111'));
    expect(rows).toHaveLength(1);
  });

  it('подставляет пустой объект в settings по умолчанию', async () => {
    await pg.db.insert(guilds).values({ id: '333333333333333333' });
    const [row] = await pg.db.select().from(guilds).where(eq(guilds.id, '333333333333333333'));
    expect(row?.settings).toEqual({});
  });

  it('запрещает участника без существующего сервера', async () => {
    await expect(
      pg.db.insert(members).values({
        guildId: '999999999999999999',
        userId: '222222222222222222',
        joinedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('пишет запись аудита с NULL в actor_id для действий бота', async () => {
    await pg.db.insert(auditLog).values({
      guildId: '111111111111111111',
      action: 'core.started',
      details: { version: '0.1.0' },
    });
    const rows = await pg.db.select().from(auditLog).where(eq(auditLog.action, 'core.started'));
    expect(rows[0]?.actorId).toBeNull();
    expect(rows[0]?.details).toEqual({ version: '0.1.0' });
  });
});
```

- [ ] **Step 10: Запустить интеграционные тесты**

Run: `npm run test:int`
Expected: 4 теста PASS. Требуется запущенная podman-машина (`podman machine start`). Первый прогон дольше — тянется образ `postgres:16-alpine`.

- [ ] **Step 11: Коммит**

```bash
git add src/core/db drizzle.config.ts scripts/migrate.ts vitest.integration.config.ts tests/helpers/postgres.ts tests/integration/db/core-schema.test.ts
git commit -m "feat: схема ядра, клиент Postgres и миграции на Drizzle"
```

---

### Task 5: Кэш с stale-while-revalidate

**Files:**
- Create: `src/core/cache.ts`, `tests/helpers/redis.ts`
- Test: `tests/integration/cache.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 2), `Logger` (Task 3).
- Produces: `interface CachedValue<T> { value: T; stale: boolean; storedAt: Date }`; класс `Cache` с методами `swr<T>(key: string, opts: { ttlMs: number; staleMs: number; load: () => Promise<T> }): Promise<CachedValue<T>>`, `drop(key: string): Promise<void>`, `close(): Promise<void>`; `createCache(config: Config, logger: Logger): Cache`.

- [ ] **Step 1: Создать хелпер `tests/helpers/redis.ts`**

```ts
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll } from 'vitest';

interface RedisFixture {
  get url(): string;
}

export function withRedis(): RedisFixture {
  let container: StartedRedisContainer;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  return {
    get url() {
      return container.getConnectionUrl();
    },
  };
}
```

- [ ] **Step 2: Написать падающие тесты**

Файл `tests/integration/cache.test.ts`. Четыре сценария описывают весь контракт: холодный промах, попадание, отдача просроченного при живом фоновом обновлении и отдача просроченного при упавшем загрузчике.

```ts
import { describe, expect, it, vi } from 'vitest';
import { Cache } from '../../src/core/cache.js';
import { loadConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import { withRedis } from '../helpers/redis.js';

const redis = withRedis();

function makeCache(): Cache {
  const config = loadConfig({
    DISCORD_TOKEN: 'test',
    DISCORD_APP_ID: '123456789012345678',
    DISCORD_GUILD_ID: '876543210987654321',
    DATABASE_URL: 'postgres://localhost:5432/x',
    REDIS_URL: redis.url,
    PUBLIC_BASE_URL: 'https://test.example.com',
    NODE_ENV: 'test',
  });
  return new Cache(config, createLogger(config));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Cache.swr', () => {
  it('вызывает загрузчик при холодном промахе', async () => {
    const cache = makeCache();
    const load = vi.fn(async () => 'значение');

    const result = await cache.swr('k:cold', { ttlMs: 60_000, staleMs: 600_000, load });

    expect(result.value).toBe('значение');
    expect(result.stale).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    await cache.close();
  });

  it('не трогает загрузчик, пока запись свежая', async () => {
    const cache = makeCache();
    const load = vi.fn(async () => 'значение');

    await cache.swr('k:hit', { ttlMs: 60_000, staleMs: 600_000, load });
    const second = await cache.swr('k:hit', { ttlMs: 60_000, staleMs: 600_000, load });

    expect(second.stale).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    await cache.close();
  });

  it('отдаёт просроченное немедленно и обновляет в фоне', async () => {
    const cache = makeCache();
    let counter = 0;
    const load = vi.fn(async () => `значение-${++counter}`);

    await cache.swr('k:stale', { ttlMs: 30, staleMs: 600_000, load });
    await wait(60);

    const stale = await cache.swr('k:stale', { ttlMs: 30, staleMs: 600_000, load });
    expect(stale.value).toBe('значение-1');
    expect(stale.stale).toBe(true);

    await wait(200);
    const refreshed = await cache.swr('k:stale', { ttlMs: 30, staleMs: 600_000, load });
    expect(refreshed.value).toBe('значение-2');
    await cache.close();
  });

  it('отдаёт просроченное, когда загрузчик падает', async () => {
    const cache = makeCache();
    await cache.swr('k:fail', { ttlMs: 30, staleMs: 600_000, load: async () => 'старое' });
    await wait(60);

    const result = await cache.swr('k:fail', {
      ttlMs: 30,
      staleMs: 600_000,
      load: async () => {
        throw new Error('провайдер лёг');
      },
    });

    expect(result.value).toBe('старое');
    expect(result.stale).toBe(true);
    await cache.close();
  });

  it('пробрасывает ошибку, когда просроченного нет', async () => {
    const cache = makeCache();
    await expect(
      cache.swr('k:empty', {
        ttlMs: 30,
        staleMs: 600_000,
        load: async () => {
          throw new Error('провайдер лёг');
        },
      }),
    ).rejects.toThrow('провайдер лёг');
    await cache.close();
  });
});
```

- [ ] **Step 3: Запустить тесты — убедиться, что падают**

Run: `npm run test:int -- tests/integration/cache.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/cache.js'`.

- [ ] **Step 4: Реализовать `src/core/cache.ts`**

Лок нужен, чтобы двадцать одновременных промахов не превратились в двадцать вызовов внешнего API.

```ts
import { Redis } from 'ioredis';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

export interface CachedValue<T> {
  value: T;
  /** true — значение отдано просроченным, обновление идёт в фоне. */
  stale: boolean;
  storedAt: Date;
}

export interface SwrOptions<T> {
  /** До этого возраста значение считается свежим. */
  ttlMs: number;
  /** До этого возраста просроченное значение ещё можно отдать. */
  staleMs: number;
  load: () => Promise<T>;
}

interface StoredEntry<T> {
  value: T;
  storedAt: number;
}

const REFRESH_LOCK_MS = 30_000;

export class Cache {
  private readonly redis: Redis;

  constructor(
    config: Config,
    private readonly logger: Logger,
  ) {
    this.redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
  }

  async swr<T>(key: string, options: SwrOptions<T>): Promise<CachedValue<T>> {
    const entry = await this.read<T>(key);
    const age = entry ? Date.now() - entry.storedAt : Number.POSITIVE_INFINITY;

    if (entry && age < options.ttlMs) {
      return { value: entry.value, stale: false, storedAt: new Date(entry.storedAt) };
    }

    if (entry && age < options.staleMs) {
      void this.refreshInBackground(key, options);
      return { value: entry.value, stale: true, storedAt: new Date(entry.storedAt) };
    }

    try {
      const value = await options.load();
      await this.write(key, value, options.staleMs);
      return { value, stale: false, storedAt: new Date() };
    } catch (error) {
      // Загрузчик упал. Просроченное лучше ошибки — но только если оно есть.
      if (entry) {
        this.logger.warn({ key, err: error }, 'загрузчик упал, отдаём просроченное значение');
        return { value: entry.value, stale: true, storedAt: new Date(entry.storedAt) };
      }
      throw error;
    }
  }

  async drop(key: string): Promise<void> {
    await this.redis.del(this.dataKey(key));
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  private async refreshInBackground<T>(key: string, options: SwrOptions<T>): Promise<void> {
    const acquired = await this.redis.set(this.lockKey(key), '1', 'PX', REFRESH_LOCK_MS, 'NX');
    if (acquired !== 'OK') return;

    try {
      const value = await options.load();
      await this.write(key, value, options.staleMs);
    } catch (error) {
      this.logger.warn({ key, err: error }, 'фоновое обновление кэша не удалось');
    } finally {
      await this.redis.del(this.lockKey(key));
    }
  }

  private async read<T>(key: string): Promise<StoredEntry<T> | null> {
    const raw = await this.redis.get(this.dataKey(key));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as StoredEntry<T>;
    } catch {
      // Битая запись бесполезна и неотличима от отсутствия — выбрасываем.
      await this.drop(key);
      return null;
    }
  }

  private async write<T>(key: string, value: T, staleMs: number): Promise<void> {
    const entry: StoredEntry<T> = { value, storedAt: Date.now() };
    await this.redis.set(this.dataKey(key), JSON.stringify(entry), 'PX', staleMs);
  }

  private dataKey(key: string): string {
    return `cache:${key}`;
  }

  private lockKey(key: string): string {
    return `cache:lock:${key}`;
  }
}

export function createCache(config: Config, logger: Logger): Cache {
  return new Cache(config, logger);
}
```

- [ ] **Step 5: Прогнать тесты**

Run: `npm run test:int -- tests/integration/cache.test.ts && npm run typecheck`
Expected: 5 тестов PASS.

- [ ] **Step 6: Коммит**

```bash
git add src/core/cache.ts tests/helpers/redis.ts tests/integration/cache.test.ts
git commit -m "feat: Redis-кэш со stale-while-revalidate и локом от стампида"
```

---

### Task 6: Типизированная шина событий

**Files:**
- Create: `src/core/events/events.ts`, `src/core/events/bus.ts`
- Test: `tests/core/bus.test.ts`

**Interfaces:**
- Consumes: `Logger` (Task 3).
- Produces: `interface BotEvents` — карта «имя события → тип полезной нагрузки», единственное место, через которое модули узнают друг о друге; класс `EventBus` с `on<K extends keyof BotEvents>(event: K, handler: (payload: BotEvents[K]) => void | Promise<void>): () => void` и `emit<K extends keyof BotEvents>(event: K, payload: BotEvents[K]): Promise<void>`.

- [ ] **Step 1: Написать падающие тесты**

Файл `tests/core/bus.test.ts`. Ключевая проверка — третий тест: упавший обработчик не должен мешать остальным, иначе один сломанный модуль отключит все остальные.

```ts
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/core/events/bus.js';
import { createLogger } from '../../src/core/logger.js';
import type { Config } from '../../src/core/config.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

describe('EventBus', () => {
  it('доставляет событие всем подписчикам', async () => {
    const bus = new EventBus(logger);
    const first = vi.fn();
    const second = vi.fn();
    bus.on('core.ready', first);
    bus.on('core.ready', second);

    await bus.emit('core.ready', { at: new Date('2026-07-27T10:00:00Z') });

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('перестаёт доставлять после отписки', async () => {
    const bus = new EventBus(logger);
    const handler = vi.fn();
    const unsubscribe = bus.on('core.ready', handler);

    unsubscribe();
    await bus.emit('core.ready', { at: new Date() });

    expect(handler).not.toHaveBeenCalled();
  });

  it('не даёт упавшему обработчику сорвать остальные', async () => {
    const bus = new EventBus(logger);
    const broken = vi.fn(() => {
      throw new Error('обработчик сломан');
    });
    const healthy = vi.fn();
    bus.on('core.ready', broken);
    bus.on('core.ready', healthy);

    await expect(bus.emit('core.ready', { at: new Date() })).resolves.toBeUndefined();
    expect(healthy).toHaveBeenCalledOnce();
  });

  it('дожидается асинхронных обработчиков', async () => {
    const bus = new EventBus(logger);
    let finished = false;
    bus.on('core.ready', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      finished = true;
    });

    await bus.emit('core.ready', { at: new Date() });

    expect(finished).toBe(true);
  });

  it('молча игнорирует событие без подписчиков', async () => {
    const bus = new EventBus(logger);
    await expect(bus.emit('core.ready', { at: new Date() })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `npx vitest run tests/core/bus.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Создать карту событий `src/core/events/events.ts`**

Каждый следующий модуль дописывает сюда свои события. Это осознанно централизовано: так типы событий проверяются компилятором, а модули по-прежнему не импортируют друг друга.

```ts
/**
 * Карта событий бота: имя → тип полезной нагрузки.
 *
 * Модули не импортируют друг друга — они публикуют и слушают события отсюда.
 * Добавляя событие, добавляй его сюда, а не в свой модуль.
 */
export interface BotEvents {
  'core.ready': { at: Date };
}
```

- [ ] **Step 4: Реализовать `src/core/events/bus.ts`**

```ts
import type { Logger } from '../logger.js';
import type { BotEvents } from './events.js';

type Handler<K extends keyof BotEvents> = (payload: BotEvents[K]) => void | Promise<void>;

export class EventBus {
  // Значения гетерогенны по ключу, поэтому единый тип здесь невыразим;
  // безопасность обеспечивают сигнатуры on/emit.
  private readonly handlers = new Map<keyof BotEvents, Set<(payload: never) => void | Promise<void>>>();

  constructor(private readonly logger: Logger) {}

  on<K extends keyof BotEvents>(event: K, handler: Handler<K>): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as (payload: never) => void | Promise<void>);
    this.handlers.set(event, set);
    return () => {
      set.delete(handler as (payload: never) => void | Promise<void>);
    };
  }

  /**
   * Доставляет событие всем подписчикам и дожидается их завершения.
   * Упавший обработчик логируется и не влияет на остальных.
   */
  async emit<K extends keyof BotEvents>(event: K, payload: BotEvents[K]): Promise<void> {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;

    const results = await Promise.allSettled(
      [...set].map(async (handler) => {
        await (handler as unknown as Handler<K>)(payload);
      }),
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error({ event, err: result.reason }, 'обработчик события упал');
      }
    }
  }
}
```

- [ ] **Step 5: Прогнать тесты**

Run: `npx vitest run tests/core/bus.test.ts && npm run typecheck`
Expected: 5 тестов PASS.

- [ ] **Step 6: Коммит**

```bash
git add src/core/events tests/core/bus.test.ts
git commit -m "feat: типизированная шина событий с изоляцией ошибок обработчиков"
```

---

### Task 7: Контракт модуля и реестр

**Files:**
- Create: `src/core/module.ts`, `src/core/registry.ts`
- Test: `tests/core/registry.test.ts`

**Interfaces:**
- Consumes: `Database` (Task 4), `Cache` (Task 5), `EventBus` (Task 6), `Logger` (Task 3), `Config` (Task 2).
- Produces: `interface ModuleContext { client, db, cache, logger, bus, config }`; `interface CommandDefinition { builder, defer?, execute }`; `interface ScheduledJob { name, cron, run }`; `interface EventHandler`; `interface BotModule { name, commands?, events?, jobs?, setup?, teardown? }`; `buildRegistry(modules: BotModule[]): Registry` с полем `commands: Map<string, { command: CommandDefinition; moduleName: string }>` и `jobs: Array<{ job: ScheduledJob; moduleName: string }>`.

- [ ] **Step 1: Написать падающие тесты**

Файл `tests/core/registry.test.ts`:

```ts
import { SlashCommandBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { BotModule } from '../../src/core/module.js';
import { buildRegistry } from '../../src/core/registry.js';

function moduleWithCommand(moduleName: string, commandName: string): BotModule {
  return {
    name: moduleName,
    commands: [
      {
        builder: new SlashCommandBuilder().setName(commandName).setDescription('тест'),
        execute: async () => {},
      },
    ],
  };
}

describe('buildRegistry', () => {
  it('индексирует команды по имени', () => {
    const registry = buildRegistry([moduleWithCommand('alpha', 'one'), moduleWithCommand('beta', 'two')]);

    expect([...registry.commands.keys()].sort()).toEqual(['one', 'two']);
    expect(registry.commands.get('one')?.moduleName).toBe('alpha');
  });

  it('падает на двух модулях с одинаковым именем', () => {
    expect(() => buildRegistry([moduleWithCommand('alpha', 'one'), moduleWithCommand('alpha', 'two')])).toThrow(
      /alpha/,
    );
  });

  it('падает на двух модулях, объявивших одну команду', () => {
    expect(() => buildRegistry([moduleWithCommand('alpha', 'dup'), moduleWithCommand('beta', 'dup')])).toThrow(/dup/);
  });

  it('собирает джобы с указанием модуля-владельца', () => {
    const registry = buildRegistry([
      { name: 'alpha', jobs: [{ name: 'sync', cron: '*/30 * * * *', run: async () => {} }] },
    ]);

    expect(registry.jobs).toHaveLength(1);
    expect(registry.jobs[0]?.moduleName).toBe('alpha');
  });

  it('принимает модуль без команд и джоб', () => {
    const registry = buildRegistry([{ name: 'пустой' }]);
    expect(registry.commands.size).toBe(0);
    expect(registry.modules).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `npx vitest run tests/core/registry.test.ts`
Expected: FAIL — модули не найдены.

- [ ] **Step 3: Реализовать `src/core/module.ts`**

Тип `builder` перечислен объединением, потому что `SlashCommandBuilder` меняет тип по мере добавления опций и подкоманд — все три варианта одинаково законны.

```ts
import type {
  ChatInputCommandInteraction,
  Client,
  ClientEvents,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import type { Cache } from './cache.js';
import type { Config } from './config.js';
import type { Database } from './db/client.js';
import type { EventBus } from './events/bus.js';
import type { Logger } from './logger.js';

/** Зависимости приходят аргументом, а не глобальным импортом — иначе модуль нечем тестировать. */
export interface ModuleContext {
  client: Client;
  db: Database;
  cache: Cache;
  logger: Logger;
  bus: EventBus;
  config: Config;
}

export type CommandBuilder =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

export interface CommandDefinition {
  builder: CommandBuilder;
  /**
   * Роутер вызовет deferReply() до execute. Обязательно для всего, что делает
   * сетевой вызов: окно ответа Discord — 3 секунды.
   */
  defer?: { ephemeral: boolean };
  execute(interaction: ChatInputCommandInteraction, ctx: ModuleContext): Promise<void>;
}

export interface EventHandler<K extends keyof ClientEvents = keyof ClientEvents> {
  event: K;
  once?: boolean;
  handle(ctx: ModuleContext, ...args: ClientEvents[K]): Promise<void>;
}

export interface ScheduledJob {
  name: string;
  /** Выражение cron с пятью полями, например '*\/30 * * * *'. */
  cron: string;
  run(ctx: ModuleContext): Promise<void>;
}

export interface BotModule {
  name: string;
  commands?: CommandDefinition[];
  events?: EventHandler[];
  jobs?: ScheduledJob[];
  setup?(ctx: ModuleContext): Promise<void>;
  teardown?(): Promise<void>;
}
```

- [ ] **Step 4: Реализовать `src/core/registry.ts`**

Столкновение имён обнаруживается на старте, а не в тот момент, когда пользователь нажал команду и получил чужой обработчик.

```ts
import type { BotModule, CommandDefinition, ScheduledJob } from './module.js';

export interface Registry {
  modules: BotModule[];
  commands: Map<string, { command: CommandDefinition; moduleName: string }>;
  jobs: Array<{ job: ScheduledJob; moduleName: string }>;
}

export function buildRegistry(modules: BotModule[]): Registry {
  const seenModules = new Set<string>();
  const commands = new Map<string, { command: CommandDefinition; moduleName: string }>();
  const jobs: Array<{ job: ScheduledJob; moduleName: string }> = [];

  for (const module of modules) {
    if (seenModules.has(module.name)) {
      throw new Error(`Два модуля с именем «${module.name}». Имена модулей должны быть уникальны.`);
    }
    seenModules.add(module.name);

    for (const command of module.commands ?? []) {
      const name = command.builder.name;
      const existing = commands.get(name);
      if (existing) {
        throw new Error(
          `Команда «${name}» объявлена дважды: в модулях «${existing.moduleName}» и «${module.name}».`,
        );
      }
      commands.set(name, { command, moduleName: module.name });
    }

    for (const job of module.jobs ?? []) {
      jobs.push({ job, moduleName: module.name });
    }
  }

  return { modules, commands, jobs };
}
```

- [ ] **Step 5: Прогнать тесты**

Run: `npx vitest run tests/core/registry.test.ts && npm run typecheck`
Expected: 5 тестов PASS.

- [ ] **Step 6: Коммит**

```bash
git add src/core/module.ts src/core/registry.ts tests/core/registry.test.ts
git commit -m "feat: контракт модуля и реестр с проверкой уникальности имён"
```

---

### Task 8: Метрики

**Files:**
- Create: `src/core/metrics.ts`
- Test: `tests/core/metrics.test.ts`

**Interfaces:**
- Consumes: ничего.
- Produces: `createMetrics(): Metrics` где `interface Metrics { registry: Registry; commandDuration: Histogram<'command' | 'outcome'>; providerErrors: Counter<'provider'>; render(): Promise<string> }`.

- [ ] **Step 1: Написать падающий тест**

Файл `tests/core/metrics.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMetrics } from '../../src/core/metrics.js';

describe('createMetrics', () => {
  it('отдаёт длительность команд в формате Prometheus', async () => {
    const metrics = createMetrics();
    metrics.commandDuration.observe({ command: 'ping', outcome: 'ok' }, 0.012);

    const rendered = await metrics.render();

    expect(rendered).toContain('bot_command_duration_seconds');
    expect(rendered).toContain('command="ping"');
    expect(rendered).toContain('outcome="ok"');
  });

  it('считает ошибки провайдеров', async () => {
    const metrics = createMetrics();
    metrics.providerErrors.inc({ provider: 'riot-lol' });

    const rendered = await metrics.render();

    expect(rendered).toContain('bot_provider_errors_total');
    expect(rendered).toContain('provider="riot-lol"');
  });

  it('включает метрики процесса', async () => {
    const metrics = createMetrics();
    const rendered = await metrics.render();
    expect(rendered).toContain('process_cpu_user_seconds_total');
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npx vitest run tests/core/metrics.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `src/core/metrics.ts`**

```ts
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface Metrics {
  registry: Registry;
  commandDuration: Histogram<'command' | 'outcome'>;
  providerErrors: Counter<'provider'>;
  render(): Promise<string>;
}

export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const commandDuration = new Histogram({
    name: 'bot_command_duration_seconds',
    help: 'Длительность обработки slash-команд',
    labelNames: ['command', 'outcome'] as const,
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 3, 10],
    registers: [registry],
  });

  const providerErrors = new Counter({
    name: 'bot_provider_errors_total',
    help: 'Сбои внешних игровых API',
    labelNames: ['provider'] as const,
    registers: [registry],
  });

  return {
    registry,
    commandDuration,
    providerErrors,
    render: () => registry.metrics(),
  };
}
```

- [ ] **Step 4: Прогнать тест**

Run: `npx vitest run tests/core/metrics.test.ts && npm run typecheck`
Expected: 3 теста PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/core/metrics.ts tests/core/metrics.test.ts
git commit -m "feat: реестр метрик Prometheus для команд и провайдеров"
```

---

### Task 9: Роутер команд с границей ошибок

**Files:**
- Create: `src/core/commands/router.ts`, `tests/helpers/interaction.ts`
- Test: `tests/core/router.test.ts`

**Interfaces:**
- Consumes: `Registry` (Task 7), `ModuleContext` (Task 7), `Metrics` (Task 8), `describeForUser` (Task 3).
- Produces: `createRouter(deps: { registry: Registry; ctx: ModuleContext; metrics: Metrics }): (interaction: Interaction) => Promise<void>`; хелпер `fakeChatInputInteraction(commandName: string)` для тестов.

- [ ] **Step 1: Создать хелпер `tests/helpers/interaction.ts`**

discord.js целиком не мокается — подделывается ровно та часть интеракции, которую использует роутер, и записывается всё, чем бот ответил.

```ts
import type { ChatInputCommandInteraction } from 'discord.js';
import { vi } from 'vitest';

export interface FakeInteraction {
  interaction: ChatInputCommandInteraction;
  calls: {
    reply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
    deferReply: ReturnType<typeof vi.fn>;
  };
}

export function fakeChatInputInteraction(commandName: string): FakeInteraction {
  const state = { deferred: false, replied: false };

  const deferReply = vi.fn(async () => {
    state.deferred = true;
  });
  const reply = vi.fn(async () => {
    state.replied = true;
  });
  const followUp = vi.fn(async () => {
    state.replied = true;
  });

  const interaction = {
    commandName,
    id: '900000000000000001',
    guildId: '111111111111111111',
    user: { id: '222222222222222222' },
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    get deferred() {
      return state.deferred;
    },
    get replied() {
      return state.replied;
    },
    deferReply,
    reply,
    followUp,
    // Подделывается только используемая роутером часть интеракции.
  } as unknown as ChatInputCommandInteraction;

  return { interaction, calls: { reply, followUp, deferReply } };
}
```

- [ ] **Step 2: Написать падающие тесты**

Файл `tests/core/router.test.ts`:

```ts
import { SlashCommandBuilder } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/core/config.js';
import { createRouter } from '../../src/core/commands/router.js';
import { UserError } from '../../src/core/errors.js';
import { createLogger } from '../../src/core/logger.js';
import { createMetrics } from '../../src/core/metrics.js';
import type { ModuleContext } from '../../src/core/module.js';
import { buildRegistry } from '../../src/core/registry.js';
import { fakeChatInputInteraction } from '../helpers/interaction.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);
const ctx = { logger } as unknown as ModuleContext;

function routerFor(execute: () => Promise<void>, defer?: { ephemeral: boolean }) {
  const registry = buildRegistry([
    {
      name: 'test',
      commands: [
        {
          builder: new SlashCommandBuilder().setName('cmd').setDescription('тест'),
          ...(defer ? { defer } : {}),
          execute,
        },
      ],
    },
  ]);
  return createRouter({ registry, ctx, metrics: createMetrics() });
}

describe('createRouter', () => {
  it('вызывает обработчик найденной команды', async () => {
    const execute = vi.fn(async () => {});
    const route = routerFor(execute);
    const { interaction } = fakeChatInputInteraction('cmd');

    await route(interaction);

    expect(execute).toHaveBeenCalledOnce();
  });

  it('делает deferReply до обработчика, когда команда так объявлена', async () => {
    const order: string[] = [];
    const route = routerFor(async () => {
      order.push('execute');
    }, { ephemeral: true });
    const { interaction, calls } = fakeChatInputInteraction('cmd');
    calls.deferReply.mockImplementation(async () => {
      order.push('defer');
    });

    await route(interaction);

    expect(order).toEqual(['defer', 'execute']);
  });

  it('показывает текст UserError пользователю дословно', async () => {
    const route = routerFor(async () => {
      throw new UserError('Аккаунт уже привязан.');
    });
    const { interaction, calls } = fakeChatInputInteraction('cmd');

    await route(interaction);

    expect(calls.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Аккаунт уже привязан.' }),
    );
  });

  it('превращает неожиданную ошибку в код инцидента', async () => {
    const route = routerFor(async () => {
      throw new Error('обращение к null');
    });
    const { interaction, calls } = fakeChatInputInteraction('cmd');

    await route(interaction);

    const content = calls.reply.mock.calls[0]?.[0]?.content as string;
    expect(content).toContain('Код инцидента');
    expect(content).not.toContain('обращение к null');
  });

  it('отвечает через followUp, если уже был deferReply', async () => {
    const route = routerFor(async () => {
      throw new Error('поломка');
    }, { ephemeral: true });
    const { interaction, calls } = fakeChatInputInteraction('cmd');

    await route(interaction);

    expect(calls.followUp).toHaveBeenCalled();
    expect(calls.reply).not.toHaveBeenCalled();
  });

  it('игнорирует интеракцию неизвестной команды без падения', async () => {
    const route = routerFor(async () => {});
    const { interaction, calls } = fakeChatInputInteraction('нет-такой');

    await expect(route(interaction)).resolves.toBeUndefined();
    expect(calls.reply).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Запустить тесты — убедиться, что падают**

Run: `npx vitest run tests/core/router.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/commands/router.js'`.

- [ ] **Step 4: Реализовать `src/core/commands/router.ts`**

```ts
import { MessageFlags, type Interaction } from 'discord.js';
import { describeForUser } from '../errors.js';
import type { Metrics } from '../metrics.js';
import type { ModuleContext } from '../module.js';
import type { Registry } from '../registry.js';

export interface RouterDeps {
  registry: Registry;
  ctx: ModuleContext;
  metrics: Metrics;
}

export function createRouter(deps: RouterDeps): (interaction: Interaction) => Promise<void> {
  const { registry, ctx, metrics } = deps;

  return async function route(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    const entry = registry.commands.get(interaction.commandName);
    if (!entry) {
      ctx.logger.warn({ command: interaction.commandName }, 'интеракция неизвестной команды');
      return;
    }

    const log = ctx.logger.child({
      command: interaction.commandName,
      module: entry.moduleName,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      correlationId: interaction.id,
    });
    const stopTimer = metrics.commandDuration.startTimer({ command: interaction.commandName });

    try {
      if (entry.command.defer) {
        await interaction.deferReply(
          entry.command.defer.ephemeral ? { flags: MessageFlags.Ephemeral } : {},
        );
      }
      await entry.command.execute(interaction, ctx);
      stopTimer({ outcome: 'ok' });
      log.info('команда выполнена');
    } catch (error) {
      stopTimer({ outcome: 'error' });
      const described = describeForUser(error);

      if (described.incidentId) {
        log.error({ err: error, incidentId: described.incidentId }, 'команда упала');
      } else {
        log.info({ err: error }, 'команда завершилась ожидаемой ошибкой');
      }

      await respond(interaction, described.text, log);
    }
  };
}

async function respond(interaction: Interaction, content: string, log: ModuleContext['logger']): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    // Окно ответа могло закрыться — сообщить пользователю больше нечем.
    log.error({ err: error }, 'не удалось доставить сообщение об ошибке');
  }
}
```

- [ ] **Step 5: Прогнать тесты**

Run: `npx vitest run tests/core/router.test.ts && npm run typecheck`
Expected: 6 тестов PASS.

- [ ] **Step 6: Коммит**

```bash
git add src/core/commands/router.ts tests/helpers/interaction.ts tests/core/router.test.ts
git commit -m "feat: роутер команд с авто-defer и границей ошибок"
```

---

### Task 10: Модуль ping и регистрация команд

**Files:**
- Create: `src/modules/ping/index.ts`, `scripts/deploy-commands.ts`
- Test: `tests/modules/ping.test.ts`

**Interfaces:**
- Consumes: `BotModule`, `ModuleContext` (Task 7), `Registry` (Task 7), `Config` (Task 2).
- Produces: `pingModule: BotModule` — образец, по которому пишутся все последующие модули; скрипт `npm run deploy-commands`.

- [ ] **Step 1: Написать падающий тест**

Файл `tests/modules/ping.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ModuleContext } from '../../src/core/module.js';
import { pingModule } from '../../src/modules/ping/index.js';
import { fakeChatInputInteraction } from '../helpers/interaction.js';

describe('модуль ping', () => {
  it('объявляет одну команду /ping', () => {
    expect(pingModule.commands).toHaveLength(1);
    expect(pingModule.commands?.[0]?.builder.name).toBe('ping');
  });

  it('отвечает задержкой шлюза эфемерно', async () => {
    const { interaction, calls } = fakeChatInputInteraction('ping');
    Object.defineProperty(interaction, 'client', { value: { ws: { ping: 42 } } });

    await pingModule.commands?.[0]?.execute(interaction, {} as ModuleContext);

    const payload = calls.reply.mock.calls[0]?.[0] as { content: string; flags: number };
    expect(payload.content).toContain('42');
    expect(payload.flags).toBeDefined();
  });

  it('не требует defer — ответ мгновенный', () => {
    expect(pingModule.commands?.[0]?.defer).toBeUndefined();
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `npx vitest run tests/modules/ping.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `src/modules/ping/index.ts`**

```ts
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { BotModule } from '../../core/module.js';

/**
 * Эталонный модуль. Показывает минимальный полный набор: объявление команды
 * данными, эфемерный ответ через flags, отсутствие defer для мгновенных операций.
 */
export const pingModule: BotModule = {
  name: 'ping',
  commands: [
    {
      builder: new SlashCommandBuilder().setName('ping').setDescription('Проверить, что бот жив'),
      async execute(interaction) {
        const latency = Math.round(interaction.client.ws.ping);
        await interaction.reply({
          content: `Понг. Задержка шлюза: ${latency} мс.`,
          flags: MessageFlags.Ephemeral,
        });
      },
    },
  ],
};
```

- [ ] **Step 4: Прогнать тест**

Run: `npx vitest run tests/modules/ping.test.ts`
Expected: 3 теста PASS.

- [ ] **Step 5: Создать `scripts/deploy-commands.ts`**

Регистрация guild-scoped: применяется мгновенно, в отличие от глобальной с часовым кэшем.

```ts
import { REST, Routes } from 'discord.js';
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { buildRegistry } from '../src/core/registry.js';
import { pingModule } from '../src/modules/ping/index.js';

const config = loadConfig();
const logger = createLogger(config);
const registry = buildRegistry([pingModule]);

const body = [...registry.commands.values()].map((entry) => entry.command.builder.toJSON());
const rest = new REST().setToken(config.DISCORD_TOKEN);

try {
  await rest.put(Routes.applicationGuildCommands(config.DISCORD_APP_ID, config.DISCORD_GUILD_ID), { body });
  logger.info({ count: body.length }, 'команды зарегистрированы на сервере');
} catch (error) {
  logger.error({ err: error }, 'регистрация команд не удалась');
  process.exitCode = 1;
}
```

- [ ] **Step 6: Проверить типы**

Run: `npm run typecheck && npm run lint`
Expected: без ошибок.

- [ ] **Step 7: Коммит**

```bash
git add src/modules/ping tests/modules/ping.test.ts scripts/deploy-commands.ts
git commit -m "feat: эталонный модуль ping и guild-scoped регистрация команд"
```

---

### Task 11: HTTP-сервер с healthz и metrics

**Files:**
- Create: `src/core/http/server.ts`
- Test: `tests/integration/http/server.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 2), `Logger` (Task 3), `Database` (Task 4), `Cache` (Task 5), `Metrics` (Task 8).
- Produces: `createHttpServer(deps: { config, logger, metrics, checks: HealthChecks }): FastifyInstance` где `interface HealthChecks { database(): Promise<void>; cache(): Promise<void> }`. Экземпляр Fastify используется этапом 1 для OAuth-колбэков и этапом 6 для дашборда.

- [ ] **Step 1: Написать падающие тесты**

Файл `tests/integration/http/server.test.ts`. Fastify тестируется через `inject` — без реального сокета.

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../../src/core/config.js';
import { createHttpServer } from '../../../src/core/http/server.js';
import { createLogger } from '../../../src/core/logger.js';
import { createMetrics } from '../../../src/core/metrics.js';

const config = { LOG_LEVEL: 'fatal', NODE_ENV: 'test', HTTP_PORT: 3000 } as Config;

function serverWith(checks: { database: () => Promise<void>; cache: () => Promise<void> }) {
  return createHttpServer({
    config,
    logger: createLogger(config),
    metrics: createMetrics(),
    checks,
  });
}

const ok = async () => {};

describe('HTTP-сервер', () => {
  it('возвращает 200 на /healthz, когда зависимости живы', async () => {
    const server = serverWith({ database: ok, cache: ok });
    const response = await server.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', database: 'ok', cache: 'ok' });
    await server.close();
  });

  it('возвращает 503 и называет упавшую зависимость', async () => {
    const server = serverWith({
      database: async () => {
        throw new Error('соединение закрыто');
      },
      cache: ok,
    });
    const response = await server.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'error', database: 'error', cache: 'ok' });
    await server.close();
  });

  it('отдаёт метрики в формате Prometheus', async () => {
    const server = serverWith({ database: ok, cache: ok });
    const response = await server.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('bot_command_duration_seconds');
    await server.close();
  });

  it('не роняет процесс, если проверка здоровья зависла дольше секунды', async () => {
    const server = serverWith({
      database: () => new Promise((resolve) => setTimeout(resolve, 5_000)),
      cache: ok,
    });
    const response = await server.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ database: 'timeout' });
    await server.close();
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `npm run test:int -- tests/integration/http/server.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `src/core/http/server.ts`**

Таймаут на проверке обязателен: без него зависший Postgres превращает `/healthz` в зависший запрос, и оркестратор не понимает, живой контейнер или нет.

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';

export interface HealthChecks {
  database(): Promise<void>;
  cache(): Promise<void>;
}

export interface HttpServerDeps {
  config: Config;
  logger: Logger;
  metrics: Metrics;
  checks: HealthChecks;
}

const CHECK_TIMEOUT_MS = 1_000;

type CheckResult = 'ok' | 'error' | 'timeout';

async function runCheck(check: () => Promise<void>): Promise<CheckResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), CHECK_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([check().then((): CheckResult => 'ok'), timeout]);
    return result;
  } catch {
    return 'error';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createHttpServer(deps: HttpServerDeps): FastifyInstance {
  const server = Fastify({ logger: false });

  server.get('/healthz', async (_request, reply) => {
    const [database, cache] = await Promise.all([runCheck(deps.checks.database), runCheck(deps.checks.cache)]);
    const healthy = database === 'ok' && cache === 'ok';

    if (!healthy) {
      deps.logger.warn({ database, cache }, 'проверка здоровья не пройдена');
    }

    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'error',
      database,
      cache,
    });
  });

  server.get('/metrics', async (_request, reply) => {
    const body = await deps.metrics.render();
    return reply.header('content-type', deps.metrics.registry.contentType).send(body);
  });

  return server;
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `npm run test:int -- tests/integration/http/server.test.ts && npm run typecheck`
Expected: 4 теста PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/core/http tests/integration/http/server.test.ts
git commit -m "feat: HTTP-сервер с healthz по таймауту и эндпоинтом метрик"
```

---

### Task 12: Планировщик cron-джоб

**Files:**
- Create: `src/core/scheduler.ts`
- Test: `tests/core/scheduler.test.ts`

**Interfaces:**
- Consumes: `Registry` (Task 7), `ModuleContext` (Task 7), `Logger` (Task 3).
- Produces: `createScheduler(deps: { registry, ctx }): Scheduler` где `interface Scheduler { start(): void; stop(): void; runOnce(jobName: string): Promise<void> }`.

- [ ] **Step 1: Написать падающие тесты**

Файл `tests/core/scheduler.test.ts`. Расписание в тестах не ждём — проверяем `runOnce`, изоляцию ошибок и корректность выражения cron.

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import type { ModuleContext } from '../../src/core/module.js';
import { buildRegistry } from '../../src/core/registry.js';
import { createScheduler } from '../../src/core/scheduler.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);
const ctx = { logger } as unknown as ModuleContext;

describe('createScheduler', () => {
  it('выполняет джобу по имени через runOnce', async () => {
    const run = vi.fn(async () => {});
    const registry = buildRegistry([{ name: 'm', jobs: [{ name: 'sync', cron: '*/30 * * * *', run }] }]);
    const scheduler = createScheduler({ registry, ctx });

    await scheduler.runOnce('sync');

    expect(run).toHaveBeenCalledOnce();
  });

  it('падает на неизвестном имени джобы', async () => {
    const registry = buildRegistry([{ name: 'm' }]);
    const scheduler = createScheduler({ registry, ctx });

    await expect(scheduler.runOnce('нет-такой')).rejects.toThrow(/нет-такой/);
  });

  it('не пробрасывает ошибку джобы наружу', async () => {
    const registry = buildRegistry([
      {
        name: 'm',
        jobs: [
          {
            name: 'broken',
            cron: '*/30 * * * *',
            run: async () => {
              throw new Error('джоба сломалась');
            },
          },
        ],
      },
    ]);
    const scheduler = createScheduler({ registry, ctx });

    await expect(scheduler.runOnce('broken')).resolves.toBeUndefined();
  });

  it('отвергает некорректное выражение cron при старте', () => {
    const registry = buildRegistry([{ name: 'm', jobs: [{ name: 'bad', cron: 'вообще-не-cron', run: async () => {} }] }]);
    const scheduler = createScheduler({ registry, ctx });

    expect(() => scheduler.start()).toThrow(/bad/);
  });

  it('останавливает все джобы по stop', () => {
    const registry = buildRegistry([{ name: 'm', jobs: [{ name: 'sync', cron: '*/30 * * * *', run: async () => {} }] }]);
    const scheduler = createScheduler({ registry, ctx });

    scheduler.start();
    expect(() => scheduler.stop()).not.toThrow();
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `npx vitest run tests/core/scheduler.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `src/core/scheduler.ts`**

`protect: true` в croner — защита от наложения: если предыдущий запуск ещё идёт, следующий пропускается. Без него медленная синхронизация рангов запустится параллельно сама с собой и удвоит расход лимита API.

```ts
import { Cron } from 'croner';
import type { ModuleContext, ScheduledJob } from './module.js';
import type { Registry } from './registry.js';

export interface Scheduler {
  start(): void;
  stop(): void;
  runOnce(jobName: string): Promise<void>;
}

export interface SchedulerDeps {
  registry: Registry;
  ctx: ModuleContext;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const crons: Cron[] = [];

  async function execute(job: ScheduledJob, moduleName: string): Promise<void> {
    const log = deps.ctx.logger.child({ job: job.name, module: moduleName });
    const startedAt = Date.now();
    try {
      await job.run(deps.ctx);
      log.info({ durationMs: Date.now() - startedAt }, 'джоба выполнена');
    } catch (error) {
      // Упавшая джоба не должна ронять процесс: следующий запуск попробует снова.
      log.error({ err: error }, 'джоба упала');
    }
  }

  return {
    start(): void {
      for (const { job, moduleName } of deps.registry.jobs) {
        try {
          crons.push(new Cron(job.cron, { protect: true, name: job.name }, () => execute(job, moduleName)));
        } catch (error) {
          throw new Error(`Некорректное расписание у джобы «${job.name}»: ${(error as Error).message}`);
        }
      }
      deps.ctx.logger.info({ count: crons.length }, 'планировщик запущен');
    },

    stop(): void {
      for (const cron of crons) cron.stop();
      crons.length = 0;
    },

    async runOnce(jobName: string): Promise<void> {
      const entry = deps.registry.jobs.find(({ job }) => job.name === jobName);
      if (!entry) {
        throw new Error(`Джоба «${jobName}» не зарегистрирована.`);
      }
      await execute(entry.job, entry.moduleName);
    },
  };
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `npx vitest run tests/core/scheduler.test.ts && npm run typecheck`
Expected: 5 тестов PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/core/scheduler.ts tests/core/scheduler.test.ts
git commit -m "feat: планировщик cron-джоб с защитой от наложения запусков"
```

---

### Task 13: Bootstrap и graceful shutdown

**Files:**
- Create: `src/core/client.ts`, `src/core/shutdown.ts`, `src/index.ts`
- Test: `tests/core/shutdown.test.ts`

**Interfaces:**
- Consumes: всё из Task 2–12.
- Produces: `createDiscordClient(): Client` с интентами `Guilds` и `GuildMembers`; `createShutdown(deps: { logger }): Shutdown` где `interface Shutdown { track<T>(work: Promise<T>): Promise<T>; onSignal(handler: () => Promise<void>): void; drain(timeoutMs: number): Promise<void> }`; запускаемый `src/index.ts`.

- [ ] **Step 1: Написать падающие тесты**

Файл `tests/core/shutdown.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import { createShutdown } from '../../src/core/shutdown.js';

const logger = createLogger({ LOG_LEVEL: 'fatal', NODE_ENV: 'test' } as Config);

describe('createShutdown', () => {
  it('дожидается отслеживаемой работы', async () => {
    const shutdown = createShutdown({ logger });
    let finished = false;

    void shutdown.track(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          finished = true;
          resolve();
        }, 30),
      ),
    );

    await shutdown.drain(1_000);
    expect(finished).toBe(true);
  });

  it('возвращает результат отслеживаемой работы', async () => {
    const shutdown = createShutdown({ logger });
    await expect(shutdown.track(Promise.resolve(7))).resolves.toBe(7);
  });

  it('перестаёт ждать по истечении таймаута', async () => {
    const shutdown = createShutdown({ logger });
    void shutdown.track(new Promise<void>((resolve) => setTimeout(resolve, 5_000)));

    const startedAt = Date.now();
    await shutdown.drain(50);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('не ломается на упавшей отслеживаемой работе', async () => {
    const shutdown = createShutdown({ logger });
    void shutdown.track(Promise.reject(new Error('работа упала'))).catch(() => {});

    await expect(shutdown.drain(100)).resolves.toBeUndefined();
  });

  it('вызывает зарегистрированные обработчики сигнала по порядку', async () => {
    const shutdown = createShutdown({ logger });
    const order: string[] = [];
    shutdown.onSignal(async () => {
      order.push('first');
    });
    shutdown.onSignal(async () => {
      order.push('second');
    });

    await shutdown.drain(100);

    expect(order).toEqual(['first', 'second']);
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `npx vitest run tests/core/shutdown.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализовать `src/core/shutdown.ts`**

```ts
import type { Logger } from './logger.js';

export interface Shutdown {
  /** Помечает работу как незавершённую: drain её дождётся. */
  track<T>(work: Promise<T>): Promise<T>;
  /** Регистрирует шаг остановки. Шаги выполняются в порядке регистрации. */
  onSignal(handler: () => Promise<void>): void;
  drain(timeoutMs: number): Promise<void>;
}

export function createShutdown(deps: { logger: Logger }): Shutdown {
  const inFlight = new Set<Promise<unknown>>();
  const handlers: Array<() => Promise<void>> = [];

  return {
    track<T>(work: Promise<T>): Promise<T> {
      inFlight.add(work);
      void work.catch(() => undefined).finally(() => inFlight.delete(work));
      return work;
    },

    onSignal(handler: () => Promise<void>): void {
      handlers.push(handler);
    },

    async drain(timeoutMs: number): Promise<void> {
      if (inFlight.size > 0) {
        deps.logger.info({ count: inFlight.size }, 'дожидаемся незавершённой работы');
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            deps.logger.warn('таймаут ожидания — останавливаемся принудительно');
            resolve();
          }, timeoutMs);
        });
        await Promise.race([Promise.allSettled([...inFlight]).then(() => undefined), deadline]);
        if (timer) clearTimeout(timer);
      }

      for (const handler of handlers) {
        try {
          await handler();
        } catch (error) {
          deps.logger.error({ err: error }, 'шаг остановки упал');
        }
      }
    },
  };
}
```

- [ ] **Step 4: Реализовать `src/core/client.ts`**

```ts
import { Client, GatewayIntentBits } from 'discord.js';

/**
 * Интенты по принципу минимальных привилегий.
 * MessageContent появится с модерацией, GuildVoiceStates — с LFG.
 */
export function createDiscordClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });
}
```

- [ ] **Step 5: Реализовать `src/index.ts`**

```ts
import { sql } from 'drizzle-orm';
import { Events } from 'discord.js';
import { createCache } from './core/cache.js';
import { createDiscordClient } from './core/client.js';
import { createRouter } from './core/commands/router.js';
import { loadConfig } from './core/config.js';
import { createDatabase } from './core/db/client.js';
import { EventBus } from './core/events/bus.js';
import { createHttpServer } from './core/http/server.js';
import { createLogger } from './core/logger.js';
import { createMetrics } from './core/metrics.js';
import type { BotModule, ModuleContext } from './core/module.js';
import { buildRegistry } from './core/registry.js';
import { createScheduler } from './core/scheduler.js';
import { createShutdown } from './core/shutdown.js';
import { pingModule } from './modules/ping/index.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const config = loadConfig();
const logger = createLogger(config);
const shutdown = createShutdown({ logger });

const { db, close: closeDatabase } = createDatabase(config);
const cache = createCache(config, logger);
const bus = new EventBus(logger);
const metrics = createMetrics();
const client = createDiscordClient();

const modules: BotModule[] = [pingModule];
const registry = buildRegistry(modules);

const ctx: ModuleContext = { client, db, cache, logger, bus, config };
const router = createRouter({ registry, ctx, metrics });
const scheduler = createScheduler({ registry, ctx });

const http = createHttpServer({
  config,
  logger,
  metrics,
  checks: {
    database: async () => {
      await db.execute(sql`select 1`);
    },
    cache: async () => {
      await cache.swr('healthz', { ttlMs: 5_000, staleMs: 10_000, load: async () => 'ok' });
    },
  },
});

client.on(Events.InteractionCreate, (interaction) => {
  void shutdown.track(router(interaction));
});

for (const module of modules) {
  for (const handler of module.events ?? []) {
    const listener = (...args: unknown[]) =>
      void shutdown.track(
        // Типы аргументов гарантированы сигнатурой EventHandler на этапе объявления.
        handler.handle(ctx, ...(args as never)),
      );
    if (handler.once) client.once(handler.event, listener);
    else client.on(handler.event, listener);
  }
  await module.setup?.(ctx);
}

shutdown.onSignal(async () => {
  scheduler.stop();
});
shutdown.onSignal(async () => {
  await http.close();
});
shutdown.onSignal(async () => {
  await client.destroy();
});
shutdown.onSignal(async () => {
  for (const module of modules) await module.teardown?.();
});
shutdown.onSignal(async () => {
  await cache.close();
});
shutdown.onSignal(async () => {
  await closeDatabase();
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'получен сигнал остановки');
    void shutdown.drain(SHUTDOWN_TIMEOUT_MS).then(() => process.exit(0));
  });
}

await http.listen({ port: config.HTTP_PORT, host: '0.0.0.0' });
logger.info({ port: config.HTTP_PORT }, 'HTTP-сервер слушает');

client.once(Events.ClientReady, (ready) => {
  logger.info({ tag: ready.user.tag, modules: modules.map((m) => m.name) }, 'бот подключён');
  scheduler.start();
  void bus.emit('core.ready', { at: new Date() });
});

await client.login(config.DISCORD_TOKEN);
```

- [ ] **Step 6: Прогнать всё**

Run: `npx vitest run tests/core/shutdown.test.ts && npm test && npm run typecheck && npm run lint`
Expected: 5 новых тестов PASS, весь unit-набор зелёный, типы и линт чистые.

- [ ] **Step 7: Коммит**

```bash
git add src/core/client.ts src/core/shutdown.ts src/index.ts tests/core/shutdown.test.ts
git commit -m "feat: bootstrap бота и graceful shutdown по SIGTERM"
```

---

### Task 14: Docker, Compose, Caddy и CI

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `Caddyfile`, `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Consumes: скрипты `build`, `start`, `db:migrate`, `typecheck`, `lint`, `test` из Task 1; эндпоинт `/healthz` из Task 11.
- Produces: воспроизводимый деплой и зелёный CI. Ничего в коде не потребляет.

- [ ] **Step 1: Создать `Dockerfile`**

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY scripts ./scripts
RUN npx tsc -p tsconfig.json

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src/core/db/migrations ./src/core/db/migrations
USER node
CMD ["node", "dist/src/index.js"]
```

- [ ] **Step 2: Создать `.dockerignore`**

```
node_modules
dist
.git
.env
.env.*
tests
coverage
docs
```

- [ ] **Step 3: Создать `docker-compose.yml`**

Миграции — отдельный сервис с `restart: "no"`: он применяет их и завершается, а бот стартует только после его успешного выхода.

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: bot
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?требуется POSTGRES_PASSWORD}
      POSTGRES_DB: disbot
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U bot -d disbot']
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: ['redis-server', '--appendonly', 'yes']
    volumes:
      - redisdata:/data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped

  migrate:
    build: .
    command: ['node', 'dist/scripts/migrate.js']
    env_file: .env
    depends_on:
      postgres:
        condition: service_healthy
    restart: 'no'

  bot:
    build: .
    env_file: .env
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    healthcheck:
      test: ['CMD-SHELL', 'wget -qO- http://localhost:3000/healthz || exit 1']
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    restart: unless-stopped

  caddy:
    image: caddy:2-alpine
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddydata:/data
      - caddyconfig:/config
    depends_on:
      - bot
    restart: unless-stopped

volumes:
  pgdata:
  redisdata:
  caddydata:
  caddyconfig:
```

- [ ] **Step 4: Создать `Caddyfile`**

`/metrics` закрыт от внешнего мира: он раскрывает внутренние счётчики и не должен быть публичным.

```caddyfile
{$BOT_DOMAIN} {
	encode gzip

	@metrics path /metrics
	respond @metrics 404

	reverse_proxy bot:3000
}
```

- [ ] **Step 5: Создать `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: ['**']
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test

  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm
      - run: npm ci
      - run: npm run test:int
```

- [ ] **Step 6: Создать `README.md`**

```markdown
# Dis-bot

Discord-бот игрового сообщества. Модульный монолит на TypeScript.

Дизайн: [docs/superpowers/specs/2026-07-27-discord-gaming-bot-design.md](docs/superpowers/specs/2026-07-27-discord-gaming-bot-design.md)

## Запуск локально

1. `cp .env.example .env` и заполнить `DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_GUILD_ID`.
2. `podman compose up -d postgres redis`
3. `npm install`
4. `npm run db:migrate`
5. `npm run deploy-commands` — регистрирует slash-команды на сервере из `DISCORD_GUILD_ID`.
6. `npm run dev`

## Проверки

| Команда | Что делает |
|---|---|
| `npm test` | unit-тесты |
| `npm run test:int` | интеграционные тесты, требуют запущенную podman-машину |
| `npm run typecheck` | проверка типов без сборки |
| `npm run lint` | eslint |

## Деплой

`podman compose up -d --build`. Домен задаётся переменной `BOT_DOMAIN`, TLS Caddy получает сам.

Бэкап базы обязателен: потеря Postgres означает безвозвратную потерю уровней и экономики.
```

- [ ] **Step 7: Проверить сборку образа и полный прогон**

Run: `podman build -t dis-bot:test . && npm test && npm run typecheck && npm run lint`
Expected: образ собирается, все проверки зелёные.

- [ ] **Step 8: Коммит**

```bash
git add Dockerfile .dockerignore docker-compose.yml Caddyfile .github/workflows/ci.yml README.md
git commit -m "chore: docker-деплой, Caddy с закрытым /metrics и CI"
```

---

## Критерии приёмки этапа 0

Проверяются вручную после Task 14. Соответствуют разделу 10 спеки.

- [ ] Бот подключается к серверу, `/ping` отвечает с латентностью.
- [ ] `podman compose up -d postgres redis && npm run db:migrate && npm run dev` поднимает окружение.
- [ ] Миграции применяются на чистой базе (`podman compose down -v`, затем заново).
- [ ] Запуск с пустым `DISCORD_TOKEN` роняет процесс с сообщением, перечисляющим проблему.
- [ ] `curl localhost:3000/healthz` отдаёт 200; после `podman compose stop postgres` — 503 с `"database":"error"`.
- [ ] `curl localhost:3000/metrics` содержит `bot_command_duration_seconds` после вызова `/ping`.
- [ ] `npm test`, `npm run test:int`, `npm run typecheck`, `npm run lint` — все зелёные.
- [ ] `podman compose restart bot` — бот возвращается в сеть без ручных действий.
- [ ] `podman compose kill -s SIGTERM bot` в момент выполнения команды: в логах видно «дожидаемся незавершённой работы», процесс выходит с кодом 0.
- [ ] Запрос `https://<домен>/metrics` снаружи возвращает 404.
