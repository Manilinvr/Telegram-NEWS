import type { User } from '@nnm/shared';
import type { Database } from '../db/pool.js';
import { mapUser } from './mappers.js';

/** Внутреннее представление пользователя — включает поля, не отдаваемые в API. */
export interface UserRecord extends User {
  passwordHash: string;
  failedLoginAttempts: number;
  lockedUntil: string | null;
  mustChangePassword: boolean;
  twoFactorSecret: string | null;
}

const SAFE_COLUMNS = `id, email, display_name, role, is_active, two_factor_enabled,
                      last_login_at, created_at`;

export class UsersRepository {
  constructor(private readonly db: Database) {}

  /**
   * Найти пользователя по email вместе с секретными полями.
   * Используется ТОЛЬКО процедурой входа — наружу такой объект не отдаётся.
   */
  async findByEmailWithSecrets(email: string): Promise<UserRecord | null> {
    const row = await this.db.maybeOne(
      `SELECT * FROM users WHERE email_normalized = lower(btrim($1))`,
      [email],
    );
    if (!row) return null;
    return {
      ...mapUser(row),
      passwordHash: String(row.password_hash),
      failedLoginAttempts: Number(row.failed_login_attempts ?? 0),
      lockedUntil: row.locked_until ? String(row.locked_until) : null,
      mustChangePassword: row.must_change_password === true,
      twoFactorSecret: row.two_factor_secret ? String(row.two_factor_secret) : null,
    };
  }

  async findById(id: string): Promise<User | null> {
    const row = await this.db.maybeOne(`SELECT ${SAFE_COLUMNS} FROM users WHERE id = $1`, [id]);
    return row ? mapUser(row) : null;
  }

  async list(): Promise<User[]> {
    const rows = await this.db.many(`SELECT ${SAFE_COLUMNS} FROM users ORDER BY created_at`);
    return rows.map(mapUser);
  }

  async create(input: {
    email: string;
    passwordHash: string;
    displayName: string;
    role: User['role'];
    mustChangePassword?: boolean;
  }): Promise<User> {
    const row = await this.db.one(
      `INSERT INTO users (email, password_hash, display_name, role, must_change_password, password_changed_at)
       VALUES ($1, $2, $3, $4, $5, now())
       RETURNING ${SAFE_COLUMNS}`,
      [
        input.email,
        input.passwordHash,
        input.displayName,
        input.role,
        input.mustChangePassword ?? false,
      ],
    );
    return mapUser(row);
  }

  /** Зафиксировать неудачную попытку входа и при необходимости заблокировать. */
  async registerFailedLogin(
    userId: string,
    maxAttempts: number,
    lockoutMinutes: number,
  ): Promise<{ attempts: number; lockedUntil: string | null }> {
    const row = await this.db.one(
      `UPDATE users
          SET failed_login_attempts = failed_login_attempts + 1,
              -- Блокировка включается ровно на пороге: после неё счётчик
              -- продолжает расти, но время блокировки не продлевается
              -- бесконечно от каждой новой попытки.
              locked_until = CASE
                WHEN failed_login_attempts + 1 >= $2
                THEN now() + make_interval(mins => $3::int)
                ELSE locked_until
              END
        WHERE id = $1
        RETURNING failed_login_attempts, locked_until`,
      [userId, maxAttempts, lockoutMinutes],
    );
    return {
      attempts: Number(row.failed_login_attempts),
      lockedUntil: row.locked_until ? String(row.locked_until) : null,
    };
  }

  /** Сбросить счётчик после успешного входа. */
  async registerSuccessfulLogin(userId: string, ip: string | null): Promise<void> {
    await this.db.query(
      `UPDATE users
          SET failed_login_attempts = 0,
              locked_until = NULL,
              last_login_at = now(),
              last_login_ip = $2
        WHERE id = $1`,
      [userId, ip],
    );
  }

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    await this.db.query(
      `UPDATE users
          SET password_hash = $2,
              must_change_password = false,
              password_changed_at = now(),
              failed_login_attempts = 0,
              locked_until = NULL
        WHERE id = $1`,
      [userId, passwordHash],
    );
  }

  async setTwoFactor(userId: string, secret: string | null, recovery: string[]): Promise<void> {
    await this.db.query(
      `UPDATE users
          SET two_factor_secret = $2,
              two_factor_enabled = $2 IS NOT NULL,
              two_factor_recovery = $3
        WHERE id = $1`,
      [userId, secret, recovery],
    );
  }

  async setActive(userId: string, isActive: boolean): Promise<void> {
    await this.db.query('UPDATE users SET is_active = $2 WHERE id = $1', [userId, isActive]);
  }

  async countOwners(): Promise<number> {
    const row = await this.db.one(`SELECT count(*)::int AS count FROM users WHERE role = 'OWNER'`);
    return Number(row.count);
  }
}
