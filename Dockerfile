# Многоэтапная сборка: стадия build компилирует TypeScript, stage runtime
# содержит только продовые зависимости и скомпилированный код.
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
# pg_dump для бэкапа базы. Без него джоба обслуживания пишет в лог ошибку и работает
# дальше — но образ без бэкапа означает потерю уровней и летописи при первом же сбое диска.
RUN apk add --no-cache postgresql17-client
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src/core/db/migrations ./src/core/db/migrations
USER node
# Одна точка входа, а не отдельный entrypoint: миграции бот применяет сам при старте
# (MIGRATE_ON_START), и именно dist/src/index.js ищут автоопределители платформ.
CMD ["node", "dist/src/index.js"]
