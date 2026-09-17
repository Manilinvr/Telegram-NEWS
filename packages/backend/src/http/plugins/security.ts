import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import type { AppConfig } from '../../config/env.js';

/**
 * Базовая защита HTTP (ТЗ §20).
 *
 * Здесь собраны меры, которые должны действовать на КАЖДЫЙ запрос, вне
 * зависимости от маршрута: заголовки безопасности, ограничение источников,
 * лимит частоты и разбор cookie.
 */
export default fp(async function securityPlugin(
  app: FastifyInstance,
  options: { config: AppConfig },
) {
  const { config } = options;

  await app.register(cookie, {
    // Секрет нужен только для подписанных cookie; сессия и так хранит
    // лишь случайный идентификатор, а его хэш лежит в БД.
    secret: config.SESSION_SECRET ?? 'development-only-cookie-secret',
    parseOptions: {},
  });

  await app.register(helmet, {
    // Панель отдаётся отдельным приложением, поэтому CSP настраивается
    // под неё: инлайновые стили нужны, произвольные скрипты — нет.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.isProduction
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
      : false,
    referrerPolicy: { policy: 'same-origin' },
  });

  await app.register(cors, {
    // Список источников закрытый: панель приватная, публичного доступа нет.
    origin: [config.PUBLIC_WEB_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token'],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MINUTES * 60_000,
    // Поток событий держит соединение открытым и под лимит не попадает.
    allowList: (request) => request.url.startsWith('/api/live'),
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (_request, context) => ({
      // statusCode обязателен: общий обработчик ошибок определяет код
      // ответа по этому полю, и без него превышение лимита уходило бы
      // клиенту как 500 «внутренняя ошибка» вместо 429 с временем
      // повторной попытки.
      statusCode: 429,
      error: 'RATE_LIMITED',
      message: `Слишком много запросов. Повторите через ${Math.ceil(context.ttl / 1000)} с.`,
    }),
  });

  // Дополнительные заголовки, которых нет в helmet по умолчанию.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('permissions-policy', 'geolocation=(), microphone=(), camera=()');
    return payload;
  });
});
