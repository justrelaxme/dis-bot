# Dis-bot

Discord-бот игрового сообщества. Модульный монолит на TypeScript.

Дизайн: [docs/superpowers/specs/2026-07-27-discord-gaming-bot-design.md](docs/superpowers/specs/2026-07-27-discord-gaming-bot-design.md)

## Запуск локально

Нужно приложение Discord: [Developer Portal](https://discord.com/developers/applications) →
**New Application** → вкладка **Bot** → **Reset Token** и скопировать значение. На той же
вкладке включить привилегированный интент **Server Members Intent** — без него бот не
увидит участников и не сможет выдавать роли. Пригласить бота на сервер: вкладка
**OAuth2** → **URL Generator** → scopes `bot` и `applications.commands`, права
`Manage Roles` и `Send Messages` → открыть получившуюся ссылку.

ID сервера копируется правым кликом по серверу (нужен режим разработчика:
Настройки → Расширенные → Режим разработчика).

```bash
npm install
cp .env.example .env                      # заполнить DISCORD_TOKEN, DISCORD_APP_ID, DISCORD_GUILD_ID
npm run test:services:up                  # Postgres на 55432, Redis на 56379
podman exec disbot-test-pg createdb -U bot disbot_dev   # один раз: отдельная база для разработки
npm run db:migrate
npm run deploy-commands                   # регистрирует slash-команды на сервере из DISCORD_GUILD_ID
npm run dev
```

База для разработки отделена от `disbot_test` намеренно: `npm run test:int` чистит
таблицы в тестовой базе перед каждым файлом и снёс бы данные разработки.

Готовность проверяется так: `curl localhost:3000/healthz` отдаёт
`{"status":"ok","database":"ok","cache":"ok"}`, а `/ping` в Discord отвечает
задержкой шлюза. На этом этапе других команд у бота нет.

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

## Известное ограничение окружения разработки

На машине, где готовился этот этап, `podman build` работает напрямую, а
`podman compose` — нет: это тонкая обёртка, которой нужен внешний provider-бинарь
(`docker-compose` или `podman-compose`), а ни один из них не установлен. Поэтому
`docker-compose.yml` проверялся сборкой образа (`podman build`) и вручную по
критериям приёмки, а не запуском `podman compose up` локально. Файл рассчитан
на прод-VPS, где provider ожидается установленным — там `podman compose up -d`
должен работать как описано выше. Если после деплоя `podman compose` всё ещё
ругается на отсутствие provider, поставьте `podman-compose` (`pip install
podman-compose`) или `docker-compose` и повторите.
