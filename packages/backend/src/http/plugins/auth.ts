import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SESSION_COOKIE_NAME, type User } from '@nnm/shared';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db/pool.js';
import { AuthService } from '../../modules/auth/service.js';
import type { SessionRecord } from '../../repositories/sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
    session?: SessionRecord;
    sessionToken?: string;
  }
  interface FastifyInstance {
    auth: AuthService;
    /** Требует аутентификации; иначе отвечает 401. */
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Требует роли; иначе отвечает 403. */
    requireRole: (
      roles: Array<User['role']>,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Аутентификация и защита от CSRF (ТЗ §20, §22).
 *
 * Проверка выполняется на сервере для КАЖДОГО защищённого действия, а не
 * только при входе: интерфейс может быть каким угодно, доверять ему нельзя.
 */
export default fp(async function authPlugin(
  app: FastifyInstance,
  options: { config: AppConfig; db: Database },
) {
  const { config, db } = options;
  const auth = new AuthService(db, config);
  app.decorate('auth', auth);

  /** Разбор сессии выполняется для всех запросов, но ничего не требует. */
  app.addHook('preHandler', async (request) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (!token) return;

    const result = await auth.authenticate(token);
    if (!result) return;

    request.user = result.user;
    request.session = result.session;
    request.sessionToken = token;
  });

  /**
   * Проверка CSRF для изменяющих запросов.
   *
   * Сессия живёт в cookie, поэтому браузер отправит её и при запросе
   * с чужого сайта. Токен из заголовка чужой сайт прочитать не может —
   * это и отсекает подделку запроса.
   */
  app.addHook('preHandler', async (request, reply) => {
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    // Вход выполняется без сессии: защищён отдельным лимитом попыток.
    if (request.url.startsWith('/api/auth/login')) return;
    if (!request.session) return;

    const header = request.headers[CSRF_HEADER_NAME];
    const token = Array.isArray(header) ? header[0] : header;

    if (!auth.verifyCsrf(request.session, token)) {
      return reply.code(403).send({
        error: 'CSRF_FAILED',
        message: 'Проверка CSRF-токена не пройдена. Обновите страницу и повторите действие.',
      });
    }
  });

  app.decorate('requireAuth', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Требуется вход в систему.' });
    }
  });

  app.decorate(
    'requireRole',
    (roles: Array<User['role']>) => async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Требуется вход в систему.' });
      }
      if (!roles.includes(request.user.role)) {
        return reply.code(403).send({ error: 'FORBIDDEN', message: 'Недостаточно прав.' });
      }
    },
  );
});

/** Установить cookie сессии и CSRF-токена. */
export function setAuthCookies(
  reply: FastifyReply,
  config: AppConfig,
  tokens: { sessionToken: string; csrfToken: string },
): void {
  const base = {
    path: '/',
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SAMESITE,
    ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}),
    maxAge: config.SESSION_TTL_MINUTES * 60,
  } as const;

  // Cookie сессии недоступна скриптам: даже при XSS токен не прочитать.
  reply.setCookie(SESSION_COOKIE_NAME, tokens.sessionToken, { ...base, httpOnly: true });
  // CSRF-токен, наоборот, должен читаться фронтендом, чтобы попасть в заголовок.
  reply.setCookie(CSRF_COOKIE_NAME, tokens.csrfToken, { ...base, httpOnly: false });
}

export function clearAuthCookies(reply: FastifyReply, config: AppConfig): void {
  const base = {
    path: '/',
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SAMESITE,
    ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}),
  } as const;
  reply.clearCookie(SESSION_COOKIE_NAME, { ...base, httpOnly: true });
  reply.clearCookie(CSRF_COOKIE_NAME, { ...base, httpOnly: false });
}
