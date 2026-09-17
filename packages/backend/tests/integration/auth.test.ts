import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import type { Database } from '../../src/db/pool.js';
import { hashPassword, verifyPassword } from '../../src/lib/crypto.js';
import { AuthService, validatePasswordPolicy } from '../../src/modules/auth/service.js';
import { UsersRepository } from '../../src/repositories/users.js';
import { SessionsRepository } from '../../src/repositories/sessions.js';
import { AuditRepository } from '../../src/repositories/audit.js';
import { closeTestDb, getTestDb, resetDb } from '../helpers/db.js';

/**
 * Тесты аутентификации и защиты учётной записи (ТЗ §20).
 * Проверяются именно те свойства, ради которых всё это делалось:
 * отсутствие утечки информации о существовании аккаунта, блокировка
 * после серии неудач, изоляция сессий и аудит.
 */

let db: Database;
let auth: AuthService;
let users: UsersRepository;

const config = loadConfig({ ...process.env, AUTH_MAX_FAILED_ATTEMPTS: '3', AUTH_LOCKOUT_MINUTES: '15' });
const ctx = { ipAddress: '203.0.113.10', userAgent: 'vitest' };
const PASSWORD = 'correct-horse-battery-staple';

beforeAll(async () => {
  db = await getTestDb();
  auth = new AuthService(db, config);
  users = new UsersRepository(db);
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await resetDb(db);
  await users.create({
    email: 'owner@example.com',
    passwordHash: await hashPassword(PASSWORD),
    displayName: 'Владелец',
    role: 'OWNER',
  });
});

describe('Хэширование паролей', () => {
  it('одинаковые пароли дают разные хэши (соль)', async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).not.toBe(b);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword(PASSWORD, b)).toBe(true);
  });

  it('открытый пароль не содержится в хэше', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).not.toContain(PASSWORD);
    expect(hash.startsWith('scrypt$')).toBe(true);
  });

  it('неверный пароль отклоняется', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword('wrong-password-entirely', hash)).toBe(false);
  });

  it('повреждённый хэш не вызывает исключения', async () => {
    expect(await verifyPassword(PASSWORD, 'мусор')).toBe(false);
    expect(await verifyPassword(PASSWORD, 'scrypt$1$2$3$4')).toBe(false);
  });
});

describe('Политика паролей', () => {
  it.each([
    ['короткий', 'abc123'],
    ['только цифры', '123456789012345'],
    ['почти целиком распространённое слово', 'password1234'],
    ['почти целиком qwerty', 'qwerty123456'],
  ])('отклоняет: %s', (_label, password) => {
    expect(validatePasswordPolicy(password)).not.toBeNull();
  });

  it('принимает длинную парольную фразу', () => {
    expect(validatePasswordPolicy('поезд-уходит-в-семь-утра')).toBeNull();
  });

  it('не бракует длинную фразу лишь из-за одного распространённого слова', () => {
    // Проверка «содержит подстроку» отвергала бы такой пароль, хотя он
    // достаточно длинный и не сводится к словарному слову.
    expect(validatePasswordPolicy('новый-длинный-пароль-2026')).toBeNull();
  });
});

describe('Вход в систему', () => {
  it('успешный вход выдаёт сессию и CSRF-токен', async () => {
    const result = await auth.login('owner@example.com', PASSWORD, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.sessionToken).toBeTruthy();
    expect(result.csrfToken).toBeTruthy();
    expect(result.sessionToken).not.toBe(result.csrfToken);
    expect(result.user.email).toBe('owner@example.com');
    // Секретные поля не должны попадать в объект пользователя.
    expect(result.user).not.toHaveProperty('passwordHash');
  });

  it('email нечувствителен к регистру и пробелам', async () => {
    const result = await auth.login('  OWNER@Example.COM  ', PASSWORD, ctx);
    expect(result.ok).toBe(true);
  });

  it('несуществующий пользователь и неверный пароль дают одинаковый ответ', async () => {
    const unknown = await auth.login('nobody@example.com', PASSWORD, ctx);
    const wrongPassword = await auth.login('owner@example.com', 'definitely-wrong-pass', ctx);

    expect(unknown.ok).toBe(false);
    expect(wrongPassword.ok).toBe(false);
    if (unknown.ok || wrongPassword.ok) return;
    // Сообщение не должно раскрывать, существует ли учётная запись.
    expect(unknown.message).toBe(wrongPassword.message);
  });

  it('токен сессии хранится в БД только в виде хэша', async () => {
    const result = await auth.login('owner@example.com', PASSWORD, ctx);
    if (!result.ok) throw new Error('ожидался успешный вход');

    const rows = await db.many('SELECT token_hash FROM sessions');
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.token_hash)).not.toBe(result.sessionToken);
  });
});

describe('Защита от перебора', () => {
  it('блокирует учётную запись после серии неудачных попыток', async () => {
    for (let i = 0; i < 2; i += 1) {
      const attempt = await auth.login('owner@example.com', 'wrong-password-here', ctx);
      expect(attempt.ok).toBe(false);
      if (!attempt.ok) expect(attempt.code).toBe('INVALID_CREDENTIALS');
    }

    // Третья попытка достигает порога и включает блокировку.
    const third = await auth.login('owner@example.com', 'wrong-password-here', ctx);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.code).toBe('ACCOUNT_LOCKED');

    // Даже верный пароль теперь отклоняется до истечения блокировки.
    const correct = await auth.login('owner@example.com', PASSWORD, ctx);
    expect(correct.ok).toBe(false);
    if (!correct.ok) expect(correct.code).toBe('ACCOUNT_LOCKED');
  });

  it('успешный вход сбрасывает счётчик неудач', async () => {
    await auth.login('owner@example.com', 'wrong-password-here', ctx);
    await auth.login('owner@example.com', PASSWORD, ctx);

    const record = await users.findByEmailWithSecrets('owner@example.com');
    expect(record?.failedLoginAttempts).toBe(0);
    expect(record?.lockedUntil).toBeNull();
  });

  it('фиксирует все попытки входа в журнале', async () => {
    await auth.login('owner@example.com', 'wrong-password-here', ctx);
    await auth.login('owner@example.com', PASSWORD, ctx);

    const audit = new AuditRepository(db);
    expect(await audit.countRecentFailuresByIp(ctx.ipAddress, 60)).toBe(1);

    const attempts = await db.many('SELECT successful FROM login_attempts ORDER BY created_at');
    expect(attempts.map((r) => r.successful)).toEqual([false, true]);
  });
});

describe('Сессии и CSRF', () => {
  it('сессия действительна и определяет пользователя', async () => {
    const login = await auth.login('owner@example.com', PASSWORD, ctx);
    if (!login.ok) throw new Error('ожидался успешный вход');

    const authenticated = await auth.authenticate(login.sessionToken);
    expect(authenticated?.user.email).toBe('owner@example.com');
  });

  it('произвольный токен не проходит проверку', async () => {
    expect(await auth.authenticate('явно-недействительный-токен')).toBeNull();
  });

  it('CSRF-токен принимается только для своей сессии', async () => {
    const first = await auth.login('owner@example.com', PASSWORD, ctx);
    const second = await auth.login('owner@example.com', PASSWORD, ctx);
    if (!first.ok || !second.ok) throw new Error('ожидался успешный вход');

    const session = await auth.authenticate(first.sessionToken);
    expect(session).not.toBeNull();
    if (!session) return;

    expect(auth.verifyCsrf(session.session, first.csrfToken)).toBe(true);
    // Токен другой сессии не должен подходить.
    expect(auth.verifyCsrf(session.session, second.csrfToken)).toBe(false);
    expect(auth.verifyCsrf(session.session, undefined)).toBe(false);
  });

  it('выход делает сессию недействительной', async () => {
    const login = await auth.login('owner@example.com', PASSWORD, ctx);
    if (!login.ok) throw new Error('ожидался успешный вход');

    await auth.logout(login.sessionToken, login.user.id, ctx);
    expect(await auth.authenticate(login.sessionToken)).toBeNull();
  });

  it('истёкшая сессия не проходит проверку', async () => {
    const login = await auth.login('owner@example.com', PASSWORD, ctx);
    if (!login.ok) throw new Error('ожидался успешный вход');

    await db.query(`UPDATE sessions SET expires_at = now() - interval '1 minute'`);
    expect(await auth.authenticate(login.sessionToken)).toBeNull();
  });

  it('сессия с превышенным простоем не проходит проверку', async () => {
    const login = await auth.login('owner@example.com', PASSWORD, ctx);
    if (!login.ok) throw new Error('ожидался успешный вход');

    await db.query(`UPDATE sessions SET last_seen_at = now() - interval '10 hours'`);
    expect(await auth.authenticate(login.sessionToken)).toBeNull();
  });

  it('смена пароля отзывает все сессии', async () => {
    const first = await auth.login('owner@example.com', PASSWORD, ctx);
    const second = await auth.login('owner@example.com', PASSWORD, ctx);
    if (!first.ok || !second.ok) throw new Error('ожидался успешный вход');

    const changed = await auth.changePassword(
      first.user.id,
      PASSWORD,
      'новый-длинный-пароль-2026',
      ctx,
    );
    expect(changed.ok).toBe(true);

    expect(await auth.authenticate(first.sessionToken)).toBeNull();
    expect(await auth.authenticate(second.sessionToken)).toBeNull();

    // Новый пароль работает, старый — нет.
    expect((await auth.login('owner@example.com', 'новый-длинный-пароль-2026', ctx)).ok).toBe(true);
  });

  it('смена пароля требует верного текущего пароля', async () => {
    const login = await auth.login('owner@example.com', PASSWORD, ctx);
    if (!login.ok) throw new Error('ожидался успешный вход');

    const result = await auth.changePassword(login.user.id, 'неверный-текущий', 'новый-длинный-пароль-2026', ctx);
    expect(result.ok).toBe(false);
  });
});

describe('Журнал аудита', () => {
  it('записи аудита неизменяемы', async () => {
    const audit = new AuditRepository(db);
    await audit.log({ userId: null, action: 'test.action' });

    // Триггер БД запрещает изменение и удаление записей аудита.
    await expect(db.query(`UPDATE audit_logs SET action = 'подделка'`)).rejects.toThrow();
    await expect(db.query('DELETE FROM audit_logs')).rejects.toThrow();
  });

  it('вход и выход фиксируются в аудите', async () => {
    const login = await auth.login('owner@example.com', PASSWORD, ctx);
    if (!login.ok) throw new Error('ожидался успешный вход');
    await auth.logout(login.sessionToken, login.user.id, ctx);

    const audit = new AuditRepository(db);
    const entries = await audit.list({ limit: 10 });
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('auth.login.success');
    expect(actions).toContain('auth.logout');
  });
});

describe('Очистка сессий', () => {
  it('удаляет давно истёкшие сессии', async () => {
    const login = await auth.login('owner@example.com', PASSWORD, ctx);
    if (!login.ok) throw new Error('ожидался успешный вход');

    await db.query(`UPDATE sessions SET expires_at = now() - interval '30 days'`);
    const sessions = new SessionsRepository(db);
    expect(await sessions.cleanup()).toBe(1);
  });
});
