import type {
  ConfirmationStatus,
  ExtractedFact,
  Importance,
  NewsEvent,
  ProcessingStatus,
  RelatedEvent,
} from '@nnm/shared';
import type { Database } from '../db/pool.js';
import { mapEvent, mapFact } from './mappers.js';

export interface NewEventInput {
  title: string;
  summary: string;
  categorySlug: string | null;
  importance: Importance;
  occurredAt: string | null;
  firstReportedAt: string;
  lastReportedAt: string;
  locationText: string | null;
  latitude: number | null;
  longitude: number | null;
  confidence: number;
}

export interface AttachPostInput {
  eventId: string;
  sourcePostId: string;
  sourceId: string;
  isPrimary?: boolean;
  isIndependent?: boolean;
  similarity?: number | null;
  matchSignals?: Record<string, unknown>;
  attachedBy?: 'SYSTEM' | 'AI' | 'HUMAN';
}

export class EventsRepository {
  constructor(private readonly db: Database) {}

  async create(input: NewEventInput): Promise<NewsEvent> {
    const row = await this.db.one(
      `INSERT INTO events
         (title, summary, category_slug, importance, occurred_at, first_reported_at,
          last_reported_at, location_text, latitude, longitude, confidence, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PROCESSING')
       RETURNING *`,
      [
        input.title,
        input.summary,
        input.categorySlug,
        input.importance,
        input.occurredAt,
        input.firstReportedAt,
        input.lastReportedAt,
        input.locationText,
        input.latitude,
        input.longitude,
        input.confidence,
      ],
    );
    return mapEvent(row);
  }

  async findById(id: string): Promise<NewsEvent | null> {
    const row = await this.db.maybeOne('SELECT * FROM events WHERE id = $1', [id]);
    return row ? mapEvent(row) : null;
  }

  async update(id: string, patch: Partial<NewEventInput> & { status?: ProcessingStatus }): Promise<NewsEvent | null> {
    const row = await this.db.maybeOne(
      `UPDATE events SET
         title            = COALESCE($2, title),
         summary          = COALESCE($3, summary),
         category_slug    = COALESCE($4, category_slug),
         importance       = COALESCE($5, importance),
         occurred_at      = COALESCE($6, occurred_at),
         location_text    = COALESCE($7, location_text),
         latitude         = COALESCE($8, latitude),
         longitude        = COALESCE($9, longitude),
         confidence       = COALESCE($10, confidence),
         status           = COALESCE($11, status)
       WHERE id = $1
       RETURNING *`,
      [
        id,
        patch.title ?? null,
        patch.summary ?? null,
        patch.categorySlug ?? null,
        patch.importance ?? null,
        patch.occurredAt ?? null,
        patch.locationText ?? null,
        patch.latitude ?? null,
        patch.longitude ?? null,
        patch.confidence ?? null,
        patch.status ?? null,
      ],
    );
    return row ? mapEvent(row) : null;
  }

  async setStatus(id: string, status: ProcessingStatus): Promise<void> {
    await this.db.query('UPDATE events SET status = $2 WHERE id = $1', [id, status]);
  }

  /**
   * Привязать публикацию к событию и пересчитать агрегаты.
   *
   * Счётчик независимых источников считается по РАЗНЫМ источникам с
   * пометкой is_independent, а не по количеству публикаций: три
   * перепечатки одного текста не делают событие подтверждённым (ТЗ §28).
   */
  async attachPost(input: AttachPostInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO event_sources
           (event_id, source_post_id, source_id, is_primary, is_independent, similarity, match_signals, attached_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (event_id, source_post_id) DO UPDATE SET
           is_independent = EXCLUDED.is_independent,
           similarity     = EXCLUDED.similarity,
           match_signals  = EXCLUDED.match_signals`,
        [
          input.eventId,
          input.sourcePostId,
          input.sourceId,
          input.isPrimary ?? false,
          input.isIndependent ?? true,
          input.similarity ?? null,
          JSON.stringify(input.matchSignals ?? {}),
          input.attachedBy ?? 'SYSTEM',
        ],
      );

      await tx.query('UPDATE source_posts SET event_id = $2 WHERE id = $1', [
        input.sourcePostId,
        input.eventId,
      ]);

      await tx.query(
        `UPDATE events e SET
           source_post_count = agg.post_count,
           independent_source_count = agg.independent_sources,
           last_reported_at = GREATEST(e.last_reported_at, agg.last_posted),
           first_reported_at = LEAST(e.first_reported_at, agg.first_posted)
         FROM (
           SELECT
             count(*)::int AS post_count,
             count(DISTINCT es.source_id) FILTER (WHERE es.is_independent)::int AS independent_sources,
             max(p.posted_at) AS last_posted,
             min(p.posted_at) AS first_posted
           FROM event_sources es
           JOIN source_posts p ON p.id = es.source_post_id
           WHERE es.event_id = $1
         ) agg
         WHERE e.id = $1`,
        [input.eventId],
      );
    });
  }

  /**
   * Пересчитать статус подтверждённости.
   *
   * Правило намеренно не сводится к «чем больше публикаций, тем достовернее»:
   * учитываются только независимые источники, а наличие собственных медиа
   * усиливает подтверждение, поскольку фотографии с места сложнее
   * перепечатать, чем текст.
   */
  async recalculateConfirmation(eventId: string): Promise<ConfirmationStatus> {
    const row = await this.db.one(
      `SELECT
         count(DISTINCT es.source_id) FILTER (WHERE es.is_independent)::int AS independent_sources,
         count(DISTINCT m.checksum) FILTER (WHERE m.checksum IS NOT NULL)::int AS distinct_media
       FROM event_sources es
       LEFT JOIN media m ON m.source_post_id = es.source_post_id
       WHERE es.event_id = $1`,
      [eventId],
    );

    const independent = Number(row.independent_sources);
    const distinctMedia = Number(row.distinct_media);

    let status: ConfirmationStatus = 'UNCONFIRMED';
    if (independent >= 3 || (independent >= 2 && distinctMedia >= 2)) {
      status = 'CONFIRMED';
    } else if (independent === 2 || (independent === 1 && distinctMedia >= 1)) {
      status = 'PARTIALLY_CONFIRMED';
    }

    await this.db.query('UPDATE events SET confirmation_status = $2 WHERE id = $1', [
      eventId,
      status,
    ]);
    return status;
  }

  async replaceFacts(
    eventId: string,
    facts: Array<Omit<ExtractedFact, 'id' | 'eventId' | 'createdAt'>>,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('DELETE FROM extracted_facts WHERE event_id = $1', [eventId]);
      for (const [index, fact] of facts.entries()) {
        await tx.query(
          `INSERT INTO extracted_facts
             (event_id, text, is_confirmed, is_assumption, source_post_id, attribution, confidence, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            eventId,
            fact.text,
            fact.isConfirmed,
            fact.isAssumption,
            fact.sourcePostId,
            fact.attribution,
            fact.confidence,
            index,
          ],
        );
      }
    });
  }

  async factsFor(eventId: string): Promise<ExtractedFact[]> {
    const rows = await this.db.many(
      'SELECT * FROM extracted_facts WHERE event_id = $1 ORDER BY position',
      [eventId],
    );
    return rows.map(mapFact);
  }

  /** Публикации, входящие в событие, с информацией об источнике. */
  async sourcesFor(eventId: string): Promise<
    Array<{
      sourceId: string;
      sourceTitle: string;
      sourceType: string;
      sourcePostId: string;
      originalUrl: string | null;
      postedAt: string;
      isIndependent: boolean;
      similarity: number | null;
    }>
  > {
    const rows = await this.db.many(
      `SELECT s.id AS source_id, s.title AS source_title, s.type AS source_type,
              p.id AS source_post_id, p.url AS original_url, p.posted_at,
              es.is_independent, es.similarity
         FROM event_sources es
         JOIN source_posts p ON p.id = es.source_post_id
         JOIN sources s      ON s.id = es.source_id
        WHERE es.event_id = $1
        ORDER BY es.is_primary DESC, p.posted_at`,
      [eventId],
    );
    return rows.map((row) => ({
      sourceId: String(row.source_id),
      sourceTitle: String(row.source_title),
      sourceType: String(row.source_type),
      sourcePostId: String(row.source_post_id),
      originalUrl: row.original_url ? String(row.original_url) : null,
      postedAt: String(row.posted_at),
      isIndependent: row.is_independent === true,
      similarity: row.similarity === null ? null : Number(row.similarity),
    }));
  }

  /**
   * Связанные и потенциально дублирующие события.
   *
   * Используется полнотекстовое сходство заголовков в близком временно́м
   * окне: подсказка модератору, а не автоматическое слияние.
   */
  async findRelated(eventId: string, limit = 5): Promise<RelatedEvent[]> {
    const rows = await this.db.many(
      `WITH target AS (SELECT * FROM events WHERE id = $1)
       SELECT e.id, e.title, e.occurred_at, e.first_reported_at,
              similarity(e.title, t.title) AS sim
         FROM events e, target t
        WHERE e.id <> t.id
          AND e.merged_into_event_id IS NULL
          AND e.first_reported_at BETWEEN t.first_reported_at - interval '48 hours'
                                      AND t.first_reported_at + interval '48 hours'
          AND similarity(e.title, t.title) > 0.25
        ORDER BY sim DESC
        LIMIT $2`,
      [eventId, limit],
    );

    return rows.map((row) => {
      const similarity = Number(row.sim);
      return {
        id: String(row.id),
        title: String(row.title),
        occurredAt: row.occurred_at ? String(row.occurred_at) : null,
        similarity,
        // Высокое сходство — вероятный дубль, умеренное — связанный сюжет.
        relation: similarity > 0.55 ? ('duplicate' as const) : ('related' as const),
      };
    });
  }

  /** Пометить событие как слитое в другое. Записи не удаляются. */
  async markMerged(eventId: string, intoEventId: string): Promise<void> {
    await this.db.query(
      `UPDATE events SET merged_into_event_id = $2, status = 'PROCESSED' WHERE id = $1`,
      [eventId, intoEventId],
    );
  }

  async countAll(): Promise<number> {
    const row = await this.db.one(
      'SELECT count(*)::int AS count FROM events WHERE merged_into_event_id IS NULL',
    );
    return Number(row.count);
  }
}
