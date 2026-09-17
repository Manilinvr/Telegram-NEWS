import { PERIOD_HOURS, type FeedFilter, type FeedItem } from '@nnm/shared';
import type { Database } from '../../db/pool.js';
import type { StorageDriver } from '../storage/driver.js';

/**
 * Лента и фильтрация (ТЗ §6, §16).
 *
 * Все фильтры комбинируются в ОДИН SQL-запрос с параметрами. Значения
 * никогда не склеиваются в текст запроса: любое пользовательское значение
 * передаётся отдельным параметром, что исключает инъекции по построению,
 * а не за счёт экранирования.
 */

interface QueryBuilder {
  conditions: string[];
  params: unknown[];
}

function addParam(builder: QueryBuilder, value: unknown): string {
  builder.params.push(value);
  return `$${builder.params.length}`;
}

export class FeedQueryService {
  constructor(
    private readonly db: Database,
    private readonly storage: StorageDriver,
  ) {}

  /**
   * Лента событий и публикаций.
   *
   * События и публикации объединяются в один поток: пользователь мыслит
   * новостями, а не внутренними сущностями системы. Переключатель `kind`
   * позволяет посмотреть только одно из двух.
   */
  async list(filter: FeedFilter): Promise<{ items: FeedItem[]; total: number }> {
    const parts: string[] = [];
    const builder: QueryBuilder = { conditions: [], params: [] };

    const timeRange = resolveTimeRange(filter);

    if (filter.kind !== 'posts') {
      parts.push(this.buildEventsQuery(filter, builder, timeRange));
    }
    if (filter.kind !== 'events') {
      parts.push(this.buildPostsQuery(filter, builder, timeRange));
    }

    if (parts.length === 0) return { items: [], total: 0 };

    const union = parts.join('\nUNION ALL\n');
    const order = buildOrderBy(filter.sort);

    const limitParam = addParam(builder, filter.limit);
    const offsetParam = addParam(builder, filter.offset ?? 0);

    const rows = await this.db.many(
      `WITH combined AS (${union})
       SELECT *, count(*) OVER () AS total_count
         FROM combined
        ORDER BY ${order}
        LIMIT ${limitParam} OFFSET ${offsetParam}`,
      builder.params,
    );

    const items = await Promise.all(rows.map((row) => this.toFeedItem(row)));
    const total = rows[0] ? Number(rows[0].total_count) : 0;

    return { items, total };
  }

  private buildEventsQuery(
    filter: FeedFilter,
    builder: QueryBuilder,
    timeRange: { from: string | null; to: string | null },
  ): string {
    const where: string[] = ['e.merged_into_event_id IS NULL'];

    if (timeRange.from) {
      where.push(`COALESCE(e.occurred_at, e.first_reported_at) >= ${addParam(builder, timeRange.from)}::timestamptz`);
    }
    if (timeRange.to) {
      where.push(`COALESCE(e.occurred_at, e.first_reported_at) <= ${addParam(builder, timeRange.to)}::timestamptz`);
    }
    if (filter.categories?.length) {
      where.push(`e.category_slug = ANY(${addParam(builder, filter.categories)}::text[])`);
    }
    if (filter.importance?.length) {
      where.push(`e.importance = ANY(${addParam(builder, filter.importance)}::text[])`);
    }
    if (filter.status?.length) {
      where.push(`e.status = ANY(${addParam(builder, filter.status)}::text[])`);
    }
    if (filter.confirmationStatus?.length) {
      where.push(`e.confirmation_status = ANY(${addParam(builder, filter.confirmationStatus)}::text[])`);
    }
    if (filter.confidenceMin !== undefined) {
      where.push(`e.confidence >= ${addParam(builder, filter.confidenceMin)}`);
    }
    if (filter.confidenceMax !== undefined) {
      where.push(`e.confidence <= ${addParam(builder, filter.confidenceMax)}`);
    }
    if (filter.moderationStatus?.length) {
      where.push(`mq.status = ANY(${addParam(builder, filter.moderationStatus)}::text[])`);
    }
    if (filter.sources?.length) {
      where.push(
        `EXISTS (SELECT 1 FROM event_sources es2 WHERE es2.event_id = e.id
                  AND es2.source_id = ANY(${addParam(builder, filter.sources)}::uuid[]))`,
      );
    }
    if (filter.sourceTypes?.length) {
      where.push(
        `EXISTS (SELECT 1 FROM event_sources es3 JOIN sources s3 ON s3.id = es3.source_id
                  WHERE es3.event_id = e.id AND s3.type = ANY(${addParam(builder, filter.sourceTypes)}::text[]))`,
      );
    }

    // Наличие вложений и артефактов обработки.
    if (filter.hasPhoto === true) where.push(`stats.photo_count > 0`);
    if (filter.hasPhoto === false) where.push(`COALESCE(stats.photo_count, 0) = 0`);
    if (filter.hasVideo === true) where.push(`stats.video_count > 0`);
    if (filter.hasVideo === false) where.push(`COALESCE(stats.video_count, 0) = 0`);
    if (filter.hasTranscript === true) where.push(`stats.transcript_count > 0`);
    if (filter.hasTranscript === false) where.push(`COALESCE(stats.transcript_count, 0) = 0`);
    if (filter.hasDraft === true) where.push(`d.id IS NOT NULL`);
    if (filter.hasDraft === false) where.push(`d.id IS NULL`);
    if (filter.isPublished === true) where.push(`pub.id IS NOT NULL`);
    if (filter.isPublished === false) where.push(`pub.id IS NULL`);

    if (filter.q) {
      where.push(this.buildEventSearchCondition(filter, builder));
    }

    return `
      SELECT
        'event'::text                AS kind,
        e.id                         AS id,
        e.title                      AS title,
        e.summary                    AS excerpt,
        e.category_slug              AS category_slug,
        e.importance                 AS importance,
        e.status                     AS status,
        COALESCE(e.occurred_at, e.first_reported_at) AS timestamp,
        COALESCE(src.titles, '')     AS source_title,
        NULL::text                   AS source_type,
        e.independent_source_count   AS source_count,
        e.location_text              AS location_text,
        e.confidence                 AS confidence,
        COALESCE(stats.photo_count, 0) > 0      AS has_photo,
        COALESCE(stats.video_count, 0) > 0      AS has_video,
        COALESCE(stats.transcript_count, 0) > 0 AS has_transcript,
        d.id IS NOT NULL             AS has_draft,
        pub.id IS NOT NULL           AS is_published,
        stats.thumbnail_key          AS thumbnail_key,
        e.id                         AS event_id
      FROM events e
      LEFT JOIN moderation_queue mq ON mq.event_id = e.id
      LEFT JOIN ai_drafts d ON d.event_id = e.id AND d.is_current
      LEFT JOIN LATERAL (
        -- Опубликованным считается только то, что действительно ушло в
        -- канал. Сухой прогон (dry_run) проходит весь путь, но ничего не
        -- отправляет, и раньше помечался как «Опубликовано» — из-за чего
        -- в разделе «Опубликованные» висели новости, которых в канале нет.
        SELECT p.id FROM publications p
         WHERE p.event_id = e.id AND p.error IS NULL AND NOT p.dry_run LIMIT 1
      ) pub ON true
      LEFT JOIN LATERAL (
        SELECT
          count(*) FILTER (WHERE m.type = 'PHOTO')::int AS photo_count,
          count(*) FILTER (WHERE m.type = 'VIDEO')::int AS video_count,
          count(t.id)::int AS transcript_count,
          (array_agg(COALESCE(m.thumbnail_key, m.storage_key)
             ORDER BY m.type = 'PHOTO' DESC, m.position)
             FILTER (WHERE m.storage_key IS NOT NULL))[1] AS thumbnail_key
        FROM event_sources es
        JOIN media m ON m.source_post_id = es.source_post_id
        LEFT JOIN transcripts t ON t.media_id = m.id AND t.status = 'COMPLETED'
        WHERE es.event_id = e.id
      ) stats ON true
      LEFT JOIN LATERAL (
        SELECT string_agg(DISTINCT s.title, ', ') AS titles
        FROM event_sources es JOIN sources s ON s.id = es.source_id
        WHERE es.event_id = e.id
      ) src ON true
      WHERE ${where.join('\n        AND ')}
    `;
  }

  /**
   * Условие полнотекстового поиска для события.
   *
   * Поиск охватывает заголовок события, исходные тексты публикаций,
   * извлечённые факты, транскрипции и название источника (ТЗ §6).
   */
  private buildEventSearchCondition(filter: FeedFilter, builder: QueryBuilder): string {
    const q = addParam(builder, filter.q);
    const fields = filter.searchFields?.length
      ? filter.searchFields
      : (['title', 'rawText', 'facts', 'transcript', 'source'] as const);

    const clauses: string[] = [];
    if (fields.includes('title')) {
      clauses.push(`e.search_vector @@ plainto_tsquery('ru_unaccent'::regconfig, ${q})`);
      clauses.push(`e.title ILIKE '%' || ${q} || '%'`);
    }
    if (fields.includes('rawText')) {
      clauses.push(
        `EXISTS (SELECT 1 FROM event_sources es_s JOIN source_posts p_s ON p_s.id = es_s.source_post_id
                  WHERE es_s.event_id = e.id
                    AND p_s.search_vector @@ plainto_tsquery('ru_unaccent'::regconfig, ${q}))`,
      );
    }
    if (fields.includes('facts')) {
      clauses.push(
        `EXISTS (SELECT 1 FROM extracted_facts f_s WHERE f_s.event_id = e.id
                  AND f_s.search_vector @@ plainto_tsquery('ru_unaccent'::regconfig, ${q}))`,
      );
    }
    if (fields.includes('transcript')) {
      clauses.push(
        `EXISTS (SELECT 1 FROM event_sources es_t JOIN media m_t ON m_t.source_post_id = es_t.source_post_id
                   JOIN transcripts t_s ON t_s.media_id = m_t.id
                  WHERE es_t.event_id = e.id
                    AND t_s.search_vector @@ plainto_tsquery('ru_unaccent'::regconfig, ${q}))`,
      );
    }
    if (fields.includes('source')) {
      clauses.push(
        `EXISTS (SELECT 1 FROM event_sources es_n JOIN sources s_n ON s_n.id = es_n.source_id
                  WHERE es_n.event_id = e.id AND s_n.title ILIKE '%' || ${q} || '%')`,
      );
    }

    return `(${clauses.join(' OR ')})`;
  }

  private buildPostsQuery(
    filter: FeedFilter,
    builder: QueryBuilder,
    timeRange: { from: string | null; to: string | null },
  ): string {
    const where: string[] = ['TRUE'];

    if (timeRange.from) where.push(`p.posted_at >= ${addParam(builder, timeRange.from)}::timestamptz`);
    if (timeRange.to) where.push(`p.posted_at <= ${addParam(builder, timeRange.to)}::timestamptz`);
    if (filter.categories?.length) {
      where.push(`p.category_slug = ANY(${addParam(builder, filter.categories)}::text[])`);
    }
    if (filter.importance?.length) {
      where.push(`p.importance = ANY(${addParam(builder, filter.importance)}::text[])`);
    }
    if (filter.status?.length) {
      where.push(`p.status = ANY(${addParam(builder, filter.status)}::text[])`);
    }
    if (filter.sources?.length) {
      where.push(`p.source_id = ANY(${addParam(builder, filter.sources)}::uuid[])`);
    }
    if (filter.sourceTypes?.length) {
      where.push(`s.type = ANY(${addParam(builder, filter.sourceTypes)}::text[])`);
    }
    if (filter.hasPhoto === true) where.push(`pstats.photo_count > 0`);
    if (filter.hasPhoto === false) where.push(`COALESCE(pstats.photo_count, 0) = 0`);
    if (filter.hasVideo === true) where.push(`pstats.video_count > 0`);
    if (filter.hasVideo === false) where.push(`COALESCE(pstats.video_count, 0) = 0`);
    if (filter.hasTranscript === true) where.push(`pstats.transcript_count > 0`);
    if (filter.hasTranscript === false) where.push(`COALESCE(pstats.transcript_count, 0) = 0`);

    if (filter.q) {
      const q = addParam(builder, filter.q);
      where.push(
        `(p.search_vector @@ plainto_tsquery('ru_unaccent'::regconfig, ${q})
          OR s.title ILIKE '%' || ${q} || '%')`,
      );
    }

    return `
      SELECT
        'post'::text                 AS kind,
        p.id                         AS id,
        COALESCE(NULLIF(left(COALESCE(p.normalized_text, p.raw_text), 120), ''), 'Публикация без текста') AS title,
        left(COALESCE(p.normalized_text, p.raw_text), 400) AS excerpt,
        p.category_slug              AS category_slug,
        COALESCE(p.importance, 'LOW') AS importance,
        p.status                     AS status,
        p.posted_at                  AS timestamp,
        s.title                      AS source_title,
        s.type                       AS source_type,
        1                            AS source_count,
        NULL::text                   AS location_text,
        NULL::numeric                AS confidence,
        COALESCE(pstats.photo_count, 0) > 0      AS has_photo,
        COALESCE(pstats.video_count, 0) > 0      AS has_video,
        COALESCE(pstats.transcript_count, 0) > 0 AS has_transcript,
        FALSE                        AS has_draft,
        FALSE                        AS is_published,
        pstats.thumbnail_key         AS thumbnail_key,
        p.event_id                   AS event_id
      FROM source_posts p
      JOIN sources s ON s.id = p.source_id
      LEFT JOIN LATERAL (
        SELECT
          count(*) FILTER (WHERE m.type = 'PHOTO')::int AS photo_count,
          count(*) FILTER (WHERE m.type = 'VIDEO')::int AS video_count,
          count(t.id)::int AS transcript_count,
          (array_agg(COALESCE(m.thumbnail_key, m.storage_key) ORDER BY m.position)
             FILTER (WHERE m.storage_key IS NOT NULL))[1] AS thumbnail_key
        FROM media m
        LEFT JOIN transcripts t ON t.media_id = m.id AND t.status = 'COMPLETED'
        WHERE m.source_post_id = p.id
      ) pstats ON true
      WHERE ${where.join('\n        AND ')}
    `;
  }

  private async toFeedItem(row: Record<string, unknown>): Promise<FeedItem> {
    const thumbnailKey = row.thumbnail_key ? String(row.thumbnail_key) : null;
    return {
      kind: String(row.kind) as FeedItem['kind'],
      id: String(row.id),
      title: String(row.title),
      excerpt: String(row.excerpt ?? ''),
      categorySlug: row.category_slug ? String(row.category_slug) : 'other',
      importance: String(row.importance) as FeedItem['importance'],
      status: String(row.status) as FeedItem['status'],
      timestamp: String(row.timestamp),
      sourceTitle: String(row.source_title ?? ''),
      sourceType: row.source_type ? String(row.source_type) : null,
      sourceCount: Number(row.source_count ?? 1),
      locationText: row.location_text ? String(row.location_text) : null,
      confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
      hasPhoto: row.has_photo === true,
      hasVideo: row.has_video === true,
      hasTranscript: row.has_transcript === true,
      hasDraft: row.has_draft === true,
      isPublished: row.is_published === true,
      // Хранилище приватно: наружу уходит только короткоживущая ссылка.
      thumbnailUrl: thumbnailKey ? await this.storage.signedUrl(thumbnailKey, 900) : null,
      eventId: row.event_id ? String(row.event_id) : null,
    };
  }
}

/** Явные from/to имеют приоритет над пресетом периода. */
function resolveTimeRange(filter: FeedFilter): { from: string | null; to: string | null } {
  if (filter.from || filter.to) {
    return { from: filter.from ?? null, to: filter.to ?? null };
  }
  const hours = filter.period ? PERIOD_HOURS[filter.period] : null;
  if (hours === null || hours === undefined) return { from: null, to: null };
  return { from: new Date(Date.now() - hours * 3600_000).toISOString(), to: null };
}

function buildOrderBy(sort: FeedFilter['sort']): string {
  switch (sort) {
    case 'oldest':
      return 'timestamp ASC';
    case 'importance':
      return `CASE importance WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, timestamp DESC`;
    case 'confidence':
      return 'confidence DESC NULLS LAST, timestamp DESC';
    case 'sources':
      return 'source_count DESC, timestamp DESC';
    default:
      return 'timestamp DESC';
  }
}
