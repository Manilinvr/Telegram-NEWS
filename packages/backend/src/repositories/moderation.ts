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
      `SELECT mq.*,
              e.title          AS event_title,
              e.category_slug  AS category_slug,
              c.title          AS category_title,
              COALESCE(src.titles, '{}') AS source_titles
         FROM moderation_queue mq
         LEFT JOIN events e     ON e.id = mq.event_id
         LEFT JOIN categories c ON c.slug = e.category_slug
         LEFT JOIN LATERAL (
           SELECT array_agg(DISTINCT s.title) AS titles
             FROM event_sources es
             JOIN source_posts sp ON sp.id = es.source_post_id
             JOIN sources s       ON s.id = sp.source_id
            WHERE es.event_id = mq.event_id
         ) src ON true
        WHERE ($1::text[] IS NULL OR mq.status = ANY($1))
        ORDER BY
          CASE mq.priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
          mq.created_at
        LIMIT $2`,
      [options.status ?? null, options.limit ?? 100],
    );
    return rows.map(mapModeration);
  }

  /**
   * Закрыть материалы, не рассмотренные за сутки.
   *
   * Очередь копит всё подряд, и к утру в ней сотни вчерашних новостей,
   * среди которых не видно сегодняшних. Нерассмотренное за прошедшие
   * сутки закрывается — но НЕ удаляется: запись переходит в «Отклонённые»
   * с понятной причиной, откуда её можно вернуть в работу и опубликовать.
   *
   * Граница — полночь по Москве, а не «сутки назад»: город живёт по
   * московскому времени, и лента должна начинаться с начала дня.
   */
  async expireStale(): Promise<number> {
    const result = await this.db.query(
      `UPDATE moderation_queue
          SET status           = 'REJECTED',
              rejection_reason = $1,
              updated_at       = now()
        WHERE status IN ('PENDING', 'IN_REVIEW')
          AND created_at <
              (date_trunc('day', now() AT TIME ZONE 'Europe/Moscow')) AT TIME ZONE 'Europe/Moscow'`,
      ['Автоочистка: материал не рассмотрен до конца суток'],
    );
    return result.rowCount ?? 0;
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
