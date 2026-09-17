import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/env.js';
import type { Database } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { configureMediaSigning, createStorageDriver } from '../modules/storage/driver.js';
import authPlugin from './plugins/auth.js';
import securityPlugin from './plugins/security.js';
import analyticsRoutes from './routes/analytics.js';
import authRoutes from './routes/auth.js';
import diagnosticsRoutes from './routes/diagnostics.js';
import feedRoutes from './routes/feed.js';
import liveRoutes from './routes/live.js';
import mediaRoutes from './routes/media.js';
import moderationRoutes from './routes/moderation.js';
import settingsRoutes from './routes/settings.js';
import sourceRoutes from './routes/sources.js';

/**
 * Сборка HTTP-приложения.
 *
 * Функция возвращает готовый экземпляр, не запуская прослушивание порта:
 * так же приложение поднимается в тестах, поэтому тесты проверяют ровно ту
 * конфигурацию, которая работает в продакшене, включая плагины
 * безопасности и проверку CSRF.
 */
export async function buildServer(config: AppConfig, db: Database): Promise<FastifyInstance> {
  const app = Fastify({
    // Экземпляр pino приводится к типу логгера Fastify: иначе весь
    // FastifyInstance параметризуется конкретным типом pino и перестаёт
    // быть совместимым с обычным FastifyInstance в сигнатурах.
    loggerInstance: logger as unknown as FastifyBaseLogger,
    // Доверять заголовкам прокси можно только за доверенным прокси:
    // иначе клиент подменит свой IP и обойдёт лимит частоты запросов.
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => randomUUID(),
  });

  const storage = createStorageDriver(config);
  // Подпись локальных ссылок на медиа привязана к секрету сессии:
  // отдельный секрет не нужен, а компрометация одного означает
  // компрометацию обоих в любом случае.
  configureMediaSigning(config.SESSION_SECRET ?? 'development-only-media-secret');

  await app.register(securityPlugin, { config });
  await app.register(authPlugin, { config, db });

  // Единая обработка ошибок: наружу не уходят детали внутреннего сбоя.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;

    if (status >= 500) {
      request.log.error({ err: error, url: request.url }, 'Необработанная ошибка запроса');
      return reply.code(status).send({
        error: 'INTERNAL_ERROR',
        message: 'Внутренняя ошибка сервера. Подробности записаны в журнал.',
        requestId: request.id,
      });
    }

    // Плагины могут задавать собственный код ошибки в поле `error`
    // (так делает ограничитель частоты запросов). Приоритет отдаётся ему,
    // иначе клиент получил бы обезличенный REQUEST_ERROR и не смог бы
    // отличить превышение лимита от ошибки валидации.
    const withCode = error as FastifyError & { error?: string };
    return reply.code(status).send({
      error: withCode.error ?? error.code ?? 'REQUEST_ERROR',
      message: error.message,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: 'NOT_FOUND', message: `Маршрут ${request.url} не найден.` });
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth', config, db });
      await api.register(feedRoutes, { db, storage });
      await api.register(moderationRoutes, { db, config, storage });
      await api.register(sourceRoutes, { db, config });
      await api.register(analyticsRoutes, { db, storage });
      await api.register(settingsRoutes, { db, config });
      await api.register(diagnosticsRoutes, { db, config });
      await api.register(mediaRoutes, { storage, config });
      await api.register(liveRoutes);
    },
    { prefix: '/api' },
  );

  return app;
}
