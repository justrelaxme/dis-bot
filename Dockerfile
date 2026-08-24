# Многоэтапная сборка: стадия build компилирует TypeScript, stage runtime
# содержит только продовые зависимости и скомпилированный код.
#
# Приложение живёт в /opt/app, а не в /app, и это не вкусовщина. Платформы, которые
# «поддерживают ваш Dockerfile», нередко всё равно монтируют склонированный репозиторий
# поверх /app — то есть поверх собранного кода. Тогда контейнер видит исходники без
# node_modules и без dist (он в .gitignore) и падает с MODULE_NOT_FOUND на точке входа,
# хотя образ собрался правильно. /opt/app под такое монтирование не попадает.
FROM node:24-alpine AS build
WORKDIR /opt/app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY scripts ./scripts
RUN npx tsc -p tsconfig.json

FROM node:24-alpine AS runtime
WORKDIR /opt/app
ENV NODE_ENV=production
# Абсолютный путь к миграциям: рабочий каталог процесса задаёт платформа, и относительный
# путь искал бы миграции там, куда она нас поставит.
ENV MIGRATIONS_DIR=/opt/app/src/core/db/migrations
# pg_dump для бэкапа базы. Без него джоба обслуживания пишет в лог ошибку и работает
# дальше — но образ без бэкапа означает потерю уровней и летописи при первом же сбое диска.
RUN apk add --no-cache postgresql17-client
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /opt/app/dist ./dist
COPY src/core/db/migrations ./src/core/db/migrations
# Корневые сертификаты облачных Postgres: с ними соединение можно проверять целиком
# (sslmode=verify-full), а не только шифровать. Подробности и путь — в certs/README.md.
COPY certs ./certs
USER node
# Абсолютный путь к точке входа: если платформа запустит нас из другого каталога,
# относительный путь не найдётся. Перед запуском печатаем, где мы и что видим, — это
# три строки в логе, которые отвечают на вопрос «а собранный код вообще на месте»
# без доступа к контейнеру.
CMD ["sh", "-c", "echo \"старт: cwd=$(pwd) точка входа=$(test -f /opt/app/dist/src/index.js && echo есть || echo НЕТ)\"; exec node /opt/app/dist/src/index.js"]
