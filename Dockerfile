# Сборка системы мониторинга новостей.
#
# Образ запускает ОДИН процесс, который отдаёт и API, и веб-панель.
# Для личной установки этого достаточно: воркер включается переменной
# RUN_WORKER_IN_API=true. При росте нагрузки тот же образ запускается
# вторым сервисом с командой `node packages/backend/dist/worker.js`.

# --- Этап сборки -------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Сначала только манифесты: слой с зависимостями переиспользуется,
# пока не изменился состав пакетов.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/

RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages

RUN npm run build

# Убираем dev-зависимости из слоя, который поедет в финальный образ.
RUN npm prune --omit=dev

# --- Финальный образ ---------------------------------------------------
FROM node:22-alpine AS runtime

# ffmpeg нужен для длительности видео и извлечения аудио под транскрипцию.
# Без него система работает, но эти возможности недоступны.
RUN apk add --no-cache ffmpeg tini

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/backend/dist ./packages/backend/dist
COPY --from=build /app/packages/backend/package.json ./packages/backend/package.json
COPY --from=build /app/packages/frontend/dist ./packages/frontend/dist

# Каталог для медиа при STORAGE_DRIVER=local. Для постоянного хранения
# смонтируйте сюда том, иначе файлы исчезнут при пересоздании контейнера.
RUN mkdir -p /app/storage/media && chown -R node:node /app/storage

# Процесс не должен работать от root.
USER node

EXPOSE 4000

# tini корректно передаёт сигналы: без него SIGTERM не доходит до Node,
# и контейнер завершается принудительно, не дав доработать задачам.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/backend/dist/server.js"]
