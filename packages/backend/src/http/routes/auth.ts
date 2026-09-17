import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import { clearAuthCookies, setAuthCookies } from '../plugins/auth.js';
import { AuditRepository } from '../../repositories/audit.js';
import type { Database } from '../../db/pool.js';

const loginSchema = z.object({
  email: z.string().email('Некорректный адрес электронной почты').max(320),
  password: z.string().min(1, 'Введите пароль').max(200),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(12, 'Пароль должен содержать не менее 12 символов').max(200),
});

export default async function authRoutes(
  app: FastifyInstance,
  options: { config: AppConfig; db: Database },
) {
  const { config, db } = options;
  const audit = new AuditRepository(db);

  /**
   * Вход в систему.
   *
   * Лимит попыток здесь отдельный и более жёсткий, чем общий: вход —
   * единственная точка, где перебор имеет смысл.
   */
  app.post(
    '/login',
    {
      config: {
        rateLimit: {
          max: config.AUTH_RATE_LIMIT_MAX,
          timeWindow: 60_000,
        },
      },
    },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Некорректные данные.',
        });
      }

      const ctx = {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      };

      // Дополнительная защита: много неудач с одного адреса — отказ
      // ещё до проверки пароля, независимо от учётной записи.
      const recentFailures = await audit.countRecentFailuresByIp(request.ip, 15);
      if (recentFailures >= config.AUTH_MAX_FAILED_ATTEMPTS * 4) {
        return reply.code(429).send({
          error: 'TOO_MANY_ATTEMPTS',
          message: 'Слишком много неудачных попыток входа с этого адреса. Повторите позже.',
        });
      }

      const result = await app.auth.login(parsed.data.email, parsed.data.password, ctx);

      if (!result.ok) {
        const status = result.code === 'ACCOUNT_LOCKED' ? 423 : 401;
        return reply.code(status).send({
          error: result.code,
          message: result.message,
          ...(result.retryAfterSeconds ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
        });
      }

      setAuthCookies(reply, config, {
        sessionToken: result.sessionToken,
        csrfToken: result.csrfToken,
      });

      return {
        user: result.user,
        csrfToken: result.csrfToken,
        expiresAt: result.expiresAt,
        mustChangePassword: result.mustChangePassword,
      };
    },
  );

  app.post('/logout', async (request, reply) => {
    if (request.sessionToken) {
      await app.auth.logout(request.sessionToken, request.user?.id ?? null, {
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
    }
    clearAuthCookies(reply, config);
    return { ok: true };
  });

  /** Текущий пользователь — используется фронтендом при загрузке. */
  app.get('/me', async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Сессия не найдена.' });
    }
    return { user: request.user };
  });

  app.post('/change-password', { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: parsed.error.issues[0]?.message ?? 'Некорректные данные.',
      });
    }

    const result = await app.auth.changePassword(
      request.user!.id,
      parsed.data.currentPassword,
      parsed.data.newPassword,
      { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null },
    );

    if (!result.ok) {
      return reply.code(400).send({ error: 'PASSWORD_CHANGE_FAILED', message: result.message });
    }

    // Все сессии отозваны, включая текущую: нужно войти заново.
    clearAuthCookies(reply, config);
    return { ok: true, message: 'Пароль изменён. Войдите заново.' };
  });
}
