import type { User } from '@nnm/shared';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db/pool.js';
import {
  fakePasswordVerification,
  generateToken,
  hashPassword,
  safeEqual,
  hashToken,
  verifyPassword,
} from '../../lib/crypto.js';
import { AUDIT_ACTIONS, AuditRepository } from '../../repositories/audit.js';
import { SessionsRepository, type SessionRecord } from '../../repositories/sessions.js';
import { UsersRepository } from '../../repositories/users.js';
import { logger } from '../../lib/logger.js';

/**
 * Сервис аутентификации (ТЗ §20).
 *
 * Общие принципы:
 *  - причина отказа наружу не детализируется: «неверный email или пароль»
 *    возвращается и при отсутствии пользователя, и при неверном пароле,
 *    чтобы нельзя было перечислить существующие учётные записи;
 *  - при отсутствии пользователя всё равно выполняется фиктивная проверка
 *    пароля — иначе учётную запись выдало бы время ответа;
 *  - все попытки входа, удачные и неудачные, попадают в журнал.
 */

export interface AuthContext {
  ipAddress: string | null;
  userAgent: string | null;
}

export interface LoginSuccess {
  ok: true;
  user: User;
  sessionToken: string;
  csrfToken: string;
  expiresAt: string;
  mustChangePassword: boolean;
}

export interface LoginFailure {
  ok: false;
  /** Код для логов и тестов; наружу отдаётся обобщённое сообщение. */
  code: 'INVALID_CREDENTIALS' | 'ACCOUNT_LOCKED' | 'ACCOUNT_DISABLED';
  message: string;
  retryAfterSeconds?: number;
}

export type LoginResult = LoginSuccess | LoginFailure;

/** Единое сообщение для всех случаев неуспешной аутентификации. */
const GENERIC_FAILURE = 'Неверный email или пароль.';

export class AuthService {
  private readonly users: UsersRepository;
  private readonly sessions: SessionsRepository;
  private readonly audit: AuditRepository;

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {
    this.users = new UsersRepository(db);
    this.sessions = new SessionsRepository(db);
    this.audit = new AuditRepository(db);
  }

  async login(email: string, password: string, ctx: AuthContext): Promise<LoginResult> {
    const user = await this.users.findByEmailWithSecrets(email);

    if (!user) {
      // Тратим сопоставимое время, чтобы отсутствие учётной записи
      // не определялось по скорости ответа.
      await fakePasswordVerification(password);
      await this.audit.recordLoginAttempt({
        email,
        ipAddress: ctx.ipAddress,
        successful: false,
        reason: 'user_not_found',
      });
      return { ok: false, code: 'INVALID_CREDENTIALS', message: GENERIC_FAILURE };
    }

    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      const retryAfterSeconds = Math.ceil(
        (new Date(user.lockedUntil).getTime() - Date.now()) / 1000,
      );
      await fakePasswordVerification(password);
      await this.audit.recordLoginAttempt({
        email,
        ipAddress: ctx.ipAddress,
        successful: false,
        reason: 'locked',
      });
      return {
        ok: false,
        code: 'ACCOUNT_LOCKED',
        message: `Учётная запись временно заблокирована после серии неудачных попыток. Повторите через ${Math.ceil(retryAfterSeconds / 60)} мин.`,
        retryAfterSeconds,
      };
    }

    if (!user.isActive) {
      await fakePasswordVerification(password);
      await this.audit.recordLoginAttempt({
        email,
        ipAddress: ctx.ipAddress,
        successful: false,
        reason: 'disabled',
      });
      return { ok: false, code: 'ACCOUNT_DISABLED', message: GENERIC_FAILURE };
    }

    const passwordValid = await verifyPassword(password, user.passwordHash);

    if (!passwordValid) {
      const { attempts, lockedUntil } = await this.users.registerFailedLogin(
        user.id,
        this.config.AUTH_MAX_FAILED_ATTEMPTS,
        this.config.AUTH_LOCKOUT_MINUTES,
      );
      await this.audit.recordLoginAttempt({
        email,
        ipAddress: ctx.ipAddress,
        successful: false,
        reason: 'bad_password',
      });
      await this.audit.log({
        userId: user.id,
        action: lockedUntil ? AUDIT_ACTIONS.ACCOUNT_LOCKED : AUDIT_ACTIONS.LOGIN_FAILED,
        entityType: 'user',
        entityId: user.id,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        details: { attempts },
      });

      if (lockedUntil && new Date(lockedUntil) > new Date()) {
        logger.warn({ userId: user.id, attempts }, 'Учётная запись заблокирована после серии неудачных попыток');
        return {
          ok: false,
          code: 'ACCOUNT_LOCKED',
          message: `Учётная запись временно заблокирована после ${attempts} неудачных попыток.`,
          retryAfterSeconds: this.config.AUTH_LOCKOUT_MINUTES * 60,
        };
      }

      return { ok: false, code: 'INVALID_CREDENTIALS', message: GENERIC_FAILURE };
    }

    // --- успешный вход ---
    const sessionToken = generateToken(32);
    const csrfToken = generateToken(32);

    const session = await this.sessions.create({
      userId: user.id,
      token: sessionToken,
      csrfToken,
      ttlMinutes: this.config.SESSION_TTL_MINUTES,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    await this.users.registerSuccessfulLogin(user.id, ctx.ipAddress);
    await this.audit.recordLoginAttempt({ email, ipAddress: ctx.ipAddress, successful: true });
    await this.audit.log({
      userId: user.id,
      action: AUDIT_ACTIONS.LOGIN_SUCCESS,
      entityType: 'user',
      entityId: user.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    return {
      ok: true,
      user: stripSecrets(user),
      sessionToken,
      csrfToken,
      expiresAt: session.expiresAt,
      mustChangePassword: user.mustChangePassword,
    };
  }

  /** Проверить сессию по токену из cookie и продлить таймаут простоя. */
  async authenticate(
    sessionToken: string,
  ): Promise<{ user: User; session: SessionRecord } | null> {
    const session = await this.sessions.findActive(
      sessionToken,
      this.config.SESSION_IDLE_TIMEOUT_MINUTES,
    );
    if (!session) return null;

    const user = await this.users.findById(session.userId);
    if (!user || !user.isActive) return null;

    await this.sessions.touch(session.id);
    return { user, session };
  }

  /**
   * Проверить CSRF-токен запроса.
   *
   * Токен привязан к конкретной сессии: значение из заголовка сравнивается
   * с хэшем, сохранённым при её создании. Сравнение — за постоянное время.
   */
  verifyCsrf(session: SessionRecord, token: string | undefined): boolean {
    if (!token) return false;
    return safeEqual(hashToken(token), session.csrfTokenHash);
  }

  async logout(sessionToken: string, userId: string | null, ctx: AuthContext): Promise<void> {
    await this.sessions.revoke(sessionToken);
    if (userId) {
      await this.audit.log({
        userId,
        action: AUDIT_ACTIONS.LOGOUT,
        entityType: 'user',
        entityId: userId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
    }
  }

  /**
   * Сменить пароль.
   *
   * После смены все остальные сессии пользователя отзываются: если пароль
   * меняют из-за подозрения на компрометацию, чужая сессия не должна
   * пережить это действие.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    ctx: AuthContext,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const user = await this.db.maybeOne('SELECT email FROM users WHERE id = $1', [userId]);
    if (!user) return { ok: false, message: 'Пользователь не найден.' };

    const record = await this.users.findByEmailWithSecrets(String(user.email));
    if (!record) return { ok: false, message: 'Пользователь не найден.' };

    const valid = await verifyPassword(currentPassword, record.passwordHash);
    if (!valid) {
      return { ok: false, message: 'Текущий пароль указан неверно.' };
    }

    const policyError = validatePasswordPolicy(newPassword);
    if (policyError) return { ok: false, message: policyError };

    await this.users.updatePassword(userId, await hashPassword(newPassword));
    await this.sessions.revokeAllForUser(userId);
    await this.audit.log({
      userId,
      action: AUDIT_ACTIONS.PASSWORD_CHANGED,
      entityType: 'user',
      entityId: userId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    return { ok: true };
  }
}

function stripSecrets(user: {
  id: string;
  email: string;
  displayName: string;
  role: User['role'];
  isActive: boolean;
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}): User {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    isActive: user.isActive,
    twoFactorEnabled: user.twoFactorEnabled,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

/**
 * Требования к паролю.
 *
 * Ставка сделана на длину, а не на обязательный набор спецсимволов:
 * длинная парольная фраза надёжнее и не провоцирует записывать пароль.
 */
export function validatePasswordPolicy(password: string): string | null {
  if (password.length < 12) {
    return 'Пароль должен содержать не менее 12 символов.';
  }
  if (password.length > 200) {
    return 'Пароль слишком длинный (максимум 200 символов).';
  }
  if (/^\d+$/.test(password)) {
    return 'Пароль не может состоять только из цифр.';
  }
  // Распространённая последовательность отклоняется только тогда, когда
  // она составляет основную часть пароля. Простая проверка «содержит»
  // забраковала бы нормальную длинную фразу вроде
  // «новый-длинный-пароль-2026», где такое слово — лишь один из элементов.
  const weak = ['password', 'пароль', '123456', 'qwerty', 'admin', 'letmein', 'йцукен'];
  const lowered = password.toLowerCase();
  const MIN_REMAINDER = 8;
  for (const word of weak) {
    if (lowered.includes(word) && password.length - word.length < MIN_REMAINDER) {
      return 'Пароль состоит в основном из распространённой последовательности.';
    }
  }
  return null;
}
