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
