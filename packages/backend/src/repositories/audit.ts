import type { AuditLogEntry } from '@nnm/shared';
import type { Database } from '../db/pool.js';
import { mapAuditLog } from './mappers.js';

/** Действия, фиксируемые в журнале аудита (ТЗ §20). */
export const AUDIT_ACTIONS = {
  LOGIN_SUCCESS: 'auth.login.success',
  LOGIN_FAILED: 'auth.login.failed',
  LOGOUT: 'auth.logout',
  PASSWORD_CHANGED: 'auth.password.changed',
  ACCOUNT_LOCKED: 'auth.account.locked',
  SOURCE_CREATED: 'source.created',
  SOURCE_UPDATED: 'source.updated',
  SOURCE_DELETED: 'source.deleted',
  CATEGORY_CREATED: 'category.created',
  CATEGORY_UPDATED: 'category.updated',
  SETTINGS_UPDATED: 'settings.updated',
  DRAFT_EDITED: 'draft.edited',
  DRAFT_REGENERATED: 'draft.regenerated',
  MODERATION_APPROVED: 'moderation.approved',
  MODERATION_REJECTED: 'moderation.rejected',
  MODERATION_RESTORED: 'moderation.restored',
  PUBLISH_ATTEMPT: 'publish.attempt',
  PUBLISH_SUCCESS: 'publish.success',
  PUBLISH_BLOCKED: 'publish.blocked',
  PUBLISH_FAILED: 'publish.failed',
  EVENT_MERGED: 'event.merged',
  EVENT_SPLIT: 'event.split',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export class AuditRepository {
  constructor(private readonly db: Database) {}

  /**
   * Записать действие в журнал.
   *
   * Журнал неизменяем на уровне БД (триггер запрещает UPDATE/DELETE),
   * поэтому запись здесь — окончательная.
   */
  async log(input: {
    userId: string | null;
    action: string;
    entityType?: string | null;
    entityId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    details?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, ip_address, user_agent, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.userId,
        input.action,
        input.entityType ?? null,
        input.entityId ?? null,
        input.ipAddress ?? null,
        input.userAgent ?? null,
        JSON.stringify(input.details ?? {}),
      ],
    );
  }

  async list(options: {
    limit?: number;
    offset?: number;
    action?: string;
    userId?: string;
  } = {}): Promise<AuditLogEntry[]> {
    const rows = await this.db.many(
      `SELECT * FROM audit_logs
        WHERE ($1::text IS NULL OR action = $1)
          AND ($2::uuid IS NULL OR user_id = $2)
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4`,
      [options.action ?? null, options.userId ?? null, options.limit ?? 100, options.offset ?? 0],
    );
    return rows.map(mapAuditLog);
  }

  async recordLoginAttempt(input: {
    email: string | null;
    ipAddress: string | null;
    successful: boolean;
    reason?: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO login_attempts (email, ip_address, successful, reason)
       VALUES ($1, $2, $3, $4)`,
      [input.email, input.ipAddress, input.successful, input.reason ?? null],
    );
  }

  /** Число неудачных попыток входа с одного IP за последние N минут. */
  async countRecentFailuresByIp(ip: string, minutes: number): Promise<number> {
    const row = await this.db.one(
      `SELECT count(*)::int AS count
         FROM login_attempts
        WHERE ip_address = $1
          AND NOT successful
          AND created_at > now() - make_interval(mins => $2::int)`,
      [ip, minutes],
    );
    return Number(row.count);
  }
}
