import type { Importance, ModerationQueueItem, ModerationStatus } from '@nnm/shared';
import type { Database } from '../db/pool.js';
import { mapModeration } from './mappers.js';

export class ModerationRepository {
  constructor(private readonly db: Database) {}

  /**
   * Поставить событие в очередь модерации или обновить существующую запись.
   *
   * Повторная генерация черновика не создаёт вторую запись: у события
   * всегда ровно один элемент очереди.
   */
  async enqueue(input: {
    eventId: string;
    draftId: string | null;
    priority: Importance;
    status?: ModerationStatus;
    blockedReason?: string | null;
  }): Promise<ModerationQueueItem> {
    const row = await this.db.one(
      `INSERT INTO moderation_queue (event_id, draft_id, priority, status, blocked_reason)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (event_id) DO UPDATE SET
         draft_id       = EXCLUDED.draft_id,
         priority       = EXCLUDED.priority,
         blocked_reason = EXCLUDED.blocked_reason,
         -- Уже рассмотренные материалы не возвращаются в PENDING молча:
         -- новый черновик снова требует решения человека.
         status         = EXCLUDED.status
       RETURNING *`,
      [
        input.eventId,
        input.draftId,
        input.priority,
        input.status ?? 'PENDING',
        input.blockedReason ?? null,
      ],
    );
    return mapModeration(row);
  }

  async findByEvent(eventId: string): Promise<ModerationQueueItem | null> {
    const row = await this.db.maybeOne('SELECT * FROM moderation_queue WHERE event_id = $1', [
      eventId,
    ]);
    return row ? mapModeration(row) : null;
  }

  async list(options: { status?: ModerationStatus[]; limit?: number } = {}): Promise<
    ModerationQueueItem[]
  > {
    const rows = await this.db.many(
      `SELECT * FROM moderation_queue
        WHERE ($1::text[] IS NULL OR status = ANY($1))
        ORDER BY
          CASE priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
          created_at
        LIMIT $2`,
      [options.status ?? null, options.limit ?? 100],
    );
    return rows.map(mapModeration);
  }

  async setStatus(
    eventId: string,
    status: ModerationStatus,
    input: {
      reviewedBy?: string | null;
      rejectionReason?: string | null;
      blockedReason?: string | null;
    } = {},
  ): Promise<ModerationQueueItem | null> {
    const row = await this.db.maybeOne(
      `UPDATE moderation_queue SET
         status           = $2,
         reviewed_by      = COALESCE($3, reviewed_by),
         reviewed_at      = CASE WHEN $2 IN ('APPROVED','REJECTED','PUBLISHED')
                                 THEN now() ELSE reviewed_at END,
         rejection_reason = $4,
         blocked_reason   = $5
       WHERE event_id = $1
       RETURNING *`,
      [
        eventId,
        status,
        input.reviewedBy ?? null,
        input.rejectionReason ?? null,
        input.blockedReason ?? null,
      ],
    );
    return row ? mapModeration(row) : null;
  }

  async counts(): Promise<{ pending: number; blocked: number }> {
    const row = await this.db.one(
      `SELECT
         count(*) FILTER (WHERE status IN ('PENDING','IN_REVIEW'))::int AS pending,
         count(*) FILTER (WHERE status = 'BLOCKED')::int AS blocked
       FROM moderation_queue`,
    );
    return { pending: Number(row.pending), blocked: Number(row.blocked) };
  }
}
