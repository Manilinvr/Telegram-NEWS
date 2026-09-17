import { access } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { AppConfig } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Отдача собранного интерфейса тем же процессом, что и API.
 *
 * Для личной системы это заметно проще раздельного размещения: один
 * адрес, одна переменная окружения, нет CORS и нет расхождения доменов
 * между cookie сессии и запросами. Раздельное размещение остаётся
 * возможным — достаточно не собирать фронтенд или указать пустой путь.
 *
 * Обработчик несуществующих маршрутов здесь НЕ задаётся: Fastify
 * допускает только один такой обработчик на префикс, и он устанавливается
 * в одном месте — при сборке приложения.
 */
export async function registerStaticFrontend(
  app: FastifyInstance,
  config: AppConfig,
): Promise<boolean> {
  const root = path.resolve(config.rootDir, config.FRONTEND_DIST_PATH);

  try {
    await access(path.join(root, 'index.html'));
  } catch {
    logger.info(
      { root },
      'Сборка интерфейса не найдена — процесс отдаёт только API. ' +
        'Соберите фронтенд (npm run build) или укажите FRONTEND_DIST_PATH.',
    );
    return false;
  }

  await app.register(fastifyStatic, {
    root,
    // Префикса нет: интерфейс живёт в корне, API — под /api.
    prefix: '/',
    index: ['index.html'],
    // Файлы сборки содержат хэш в имени, поэтому кэшируются надолго;
    // index.html не кэшируется, иначе после обновления пользователь
    // продолжит загружать старые ссылки на ресурсы.
    maxAge: '1y',
    setHeaders: (reply, filePath) => {
      if (filePath.endsWith('index.html')) {
        reply.setHeader('cache-control', 'no-cache, must-revalidate');
      }
    },
  });

  logger.info({ root }, 'Интерфейс отдаётся этим же процессом');
  return true;
}
