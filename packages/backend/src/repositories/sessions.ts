import type { Database } from '../db/pool.js';
import { hashToken } from '../lib/crypto.js';

export interface SessionRecord {
  id: string;
  userId: string;
  csrfTokenHash: string;
  expiresAt: string;
  lastSeenAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export class SessionsRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    userId: string;
    token: string;
    csrfToken: string;
    ttlMinutes: number;
    ipAddress: string | null;
    userAgent: string | null;
  }): Promise<SessionRecord> {
    const row = await this.db.one(
      `INSERT INTO sessions (user_id, token_hash, csrf_token_hash, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6::int))
       RETURNING id, user_id, csrf_token_hash, expires_at, last_seen_at, ip_address, user_agent`,
      [
        input.userId,
        hashToken(input.token),
        hashToken(input.csrfToken),
        input.ipAddress,
        input.userAgent,
        input.ttlMinutes,
      ],
    );
    return toRecord(row);
  }

  /**
   * Найти активную сессию по токену из cookie.
   *
   * Проверяются одновременно срок жизни, отзыв и таймаут простоя: сессия,
   * которой не пользовались дольше положенного, считается недействительной,
   * даже если её общий срок ещё не истёк.
   */
  async findActive(token: string, idleTimeoutMinutes: number): Promise<SessionRecord | null> {
    const row = await this.db.maybeOne(
      `SELECT id, user_id, csrf_token_hash, expires_at, last_seen_at, ip_address, user_agent
         FROM sessions
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND expires_at > now()
          AND last_seen_at > now() - make_interval(mins => $2::int)`,
      [hashToken(token), idleTimeoutMinutes],
    );
    return row ? toRecord(row) : null;
  }

  /** Продлить «скользящий» таймаут простоя. */
  async touch(sessionId: string): Promise<void> {
    await this.db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [sessionId]);
  }

  async revoke(token: string): Promise<void> {
    await this.db.query(
      'UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
      [hashToken(token)],
    );
  }

  /** Отозвать все сессии пользователя — например, при смене пароля. */
  async revokeAllForUser(userId: string): Promise<number> {
    const result = await this.db.query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
    return result.rowCount ?? 0;
  }

  /** Убрать из БД истёкшие и отозванные сессии. */
  async cleanup(): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM sessions
        WHERE expires_at < now() - interval '7 days'
           OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`,
    );
    return result.rowCount ?? 0;
  }
}

function toRecord(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    csrfTokenHash: String(row.csrf_token_hash),
    expiresAt: String(row.expires_at),
    lastSeenAt: String(row.last_seen_at),
    ipAddress: row.ip_address ? String(row.ip_address) : null,
    userAgent: row.user_agent ? String(row.user_agent) : null,
  };
}
