import type {
  AnalyticsBundle,
  CategoryDistributionItem,
  DashboardSummary,
  MapMarker,
  ModerationQueuePreview,
  SourceActivityItem,
  SourceHealth,
  TimeseriesPoint,
} from '@nnm/shared';
import type { Database } from '../../db/pool.js';
import type { StorageDriver } from '../storage/driver.js';
import { FeedQueryService } from '../feed/query.js';
import { feedFilterSchema } from '@nnm/shared';

/**
 * Аналитика дашборда (ТЗ §15).
 *
 * Показатели считаются в СУБД одним запросом на блок, а не выборкой строк
 * с последующим подсчётом в приложении: на нескольких тысячах публикаций
 * разница уже заметна, а дашборд обновляется постоянно.
 */
export class AnalyticsService {
  private readonly feed: FeedQueryService;

  constructor(
    private readonly db: Database,
    storage: StorageDriver,
  ) {
    this.feed = new FeedQueryService(db, storage);
  }

  async summary(): Promise<DashboardSummary> {
    const [sources, posts, events, moderation, publications, errors, jobs] = await Promise.all([
      this.db.one(
        `SELECT
           count(*)::int AS total,
           count(*) FILTER (WHERE is_active)::int AS active,
           count(*) FILTER (WHERE health = 'FAILING')::int AS failing,
           count(*) FILTER (WHERE health = 'HEALTHY')::int AS healthy,
           count(*) FILTER (WHERE health = 'DEGRADED')::int AS degraded,
           count(*) FILTER (WHERE health = 'DISABLED')::int AS disabled,
           count(*) FILTER (WHERE health = 'UNKNOWN')::int AS unknown
         FROM sources`,
      ),
      this.db.one(
        `SELECT
           count(*) FILTER (WHERE posted_at > now() - interval '24 hours')::int AS last24h,
           count(*) FILTER (WHERE posted_at > now() - interval '48 hours'
                              AND posted_at <= now() - interval '24 hours')::int AS prev24h,
           count(*)::int AS total
         FROM source_posts`,
      ),
      this.db.one(
        `SELECT
           count(*) FILTER (WHERE first_reported_at > now() - interval '24 hours')::int AS last24h,
           count(*) FILTER (WHERE first_reported_at > now() - interval '48 hours'
                              AND first_reported_at <= now() - interval '24 hours')::int AS prev24h,
           count(*)::int AS total
         FROM events WHERE merged_into_event_id IS NULL`,
      ),
      this.db.one(
        `SELECT
           count(*) FILTER (WHERE status IN ('PENDING','IN_REVIEW'))::int AS pending,
           count(*) FILTER (WHERE status = 'BLOCKED')::int AS blocked
         FROM moderation_queue`,
      ),
      this.db.one(
        `SELECT
           count(*) FILTER (WHERE published_at > now() - interval '24 hours' AND error IS NULL)::int AS last24h,
           count(*) FILTER (WHERE error IS NULL)::int AS total
         FROM publications`,
      ),
      this.db.one(
        `SELECT
           count(*) FILTER (WHERE NOT is_resolved)::int AS unresolved,
           count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last24h
         FROM processing_errors`,
      ),
      this.db.one(
        `SELECT
           count(*) FILTER (WHERE status = 'QUEUED')::int AS queued,
           count(*) FILTER (WHERE status = 'RUNNING')::int AS running,
           count(*) FILTER (WHERE status IN ('FAILED','DEAD'))::int AS failed
         FROM processing_jobs`,
      ),
    ]);

    return {
      sources: {
        total: Number(sources.total),
        active: Number(sources.active),
        failing: Number(sources.failing),
        byHealth: {
          HEALTHY: Number(sources.healthy),
          DEGRADED: Number(sources.degraded),
          FAILING: Number(sources.failing),
          DISABLED: Number(sources.disabled),
          UNKNOWN: Number(sources.unknown),
        } as Record<SourceHealth, number>,
      },
      posts: {
        last24h: Number(posts.last24h),
        deltaVsPrev24h: Number(posts.last24h) - Number(posts.prev24h),
        total: Number(posts.total),
      },
      events: {
        last24h: Number(events.last24h),
        deltaVsPrev24h: Number(events.last24h) - Number(events.prev24h),
        total: Number(events.total),
      },
      moderation: { pending: Number(moderation.pending), blocked: Number(moderation.blocked) },
      publications: { last24h: Number(publications.last24h), total: Number(publications.total) },
      errors: { unresolved: Number(errors.unresolved), last24h: Number(errors.last24h) },
      jobs: {
        queued: Number(jobs.queued),
        running: Number(jobs.running),
        failed: Number(jobs.failed),
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Активность по времени.
   *
   * Ряд строится по сетке интервалов через generate_series: иначе на
   * графике исчезали бы часы без публикаций, и динамика выглядела бы
   * искажённой.
   */
  async timeseries(period: '24h' | '7d' | '30d' = '24h'): Promise<TimeseriesPoint[]> {
    const config = {
      '24h': { interval: '1 hour', span: '24 hours' },
      '7d': { interval: '6 hours', span: '7 days' },
      '30d': { interval: '1 day', span: '30 days' },
    }[period];

    const rows = await this.db.many(
      `WITH buckets AS (
         SELECT generate_series(
           date_trunc('hour', now() - $1::interval),
           date_trunc('hour', now()),
           $2::interval
         ) AS bucket
       )
       SELECT
         b.bucket,
         (SELECT count(*) FROM source_posts p
           WHERE p.posted_at >= b.bucket AND p.posted_at < b.bucket + $2::interval)::int AS posts,
         (SELECT count(*) FROM events e
           WHERE e.merged_into_event_id IS NULL
             AND e.first_reported_at >= b.bucket
             AND e.first_reported_at < b.bucket + $2::interval)::int AS events
       FROM buckets b
       ORDER BY b.bucket`,
      [config.span, config.interval],
    );

    return rows.map((row) => ({
      bucket: String(row.bucket),
      posts: Number(row.posts),
      events: Number(row.events),
    }));
  }

  async categoryDistribution(hours = 24): Promise<CategoryDistributionItem[]> {
    const rows = await this.db.many(
      `SELECT c.slug, c.title, c.color, count(e.id)::int AS count
         FROM categories c
         LEFT JOIN events e
           ON e.category_slug = c.slug
          AND e.merged_into_event_id IS NULL
          AND e.first_reported_at > now() - make_interval(hours => $1::int)
        WHERE c.is_active
        GROUP BY c.slug, c.title, c.color, c.sort_order
        HAVING count(e.id) > 0
        ORDER BY count DESC, c.sort_order`,
      [hours],
    );

    const total = rows.reduce((sum, row) => sum + Number(row.count), 0);
    return rows.map((row) => ({
      slug: String(row.slug),
      title: String(row.title),
      color: String(row.color),
      count: Number(row.count),
      share: total === 0 ? 0 : Math.round((Number(row.count) / total) * 1000) / 1000,
    }));
  }

  async topSources(limit = 8, hours = 24): Promise<SourceActivityItem[]> {
    const rows = await this.db.many(
      `SELECT s.id, s.title, s.type, s.health, s.last_post_at,
              count(p.id)::int AS post_count
         FROM sources s
         LEFT JOIN source_posts p
           ON p.source_id = s.id
          AND p.posted_at > now() - make_interval(hours => $2::int)
        GROUP BY s.id, s.title, s.type, s.health, s.last_post_at
        ORDER BY post_count DESC, s.title
        LIMIT $1`,
      [limit, hours],
    );

    return rows.map((row) => ({
      sourceId: String(row.id),
      title: String(row.title),
      type: String(row.type),
      health: String(row.health) as SourceHealth,
      postCount: Number(row.post_count),
      lastPostAt: row.last_post_at ? String(row.last_post_at) : null,
    }));
  }

  async moderationPreview(limit = 5): Promise<ModerationQueuePreview[]> {
    const rows = await this.db.many(
      `SELECT mq.id, mq.event_id, mq.status, mq.blocked_reason, mq.created_at,
              e.title, e.category_slug, mq.priority
         FROM moderation_queue mq
         JOIN events e ON e.id = mq.event_id
        WHERE mq.status IN ('PENDING','IN_REVIEW','BLOCKED')
        ORDER BY
          CASE mq.priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
          mq.created_at
        LIMIT $1`,
      [limit],
    );

    return rows.map((row) => ({
      id: String(row.id),
      eventId: String(row.event_id),
      title: String(row.title),
      categorySlug: row.category_slug ? String(row.category_slug) : 'other',
      importance: String(row.priority) as ModerationQueuePreview['importance'],
      status: String(row.status),
      blockedReason: row.blocked_reason ? String(row.blocked_reason) : null,
      createdAt: String(row.created_at),
    }));
  }

  /** Точки событий для карты. */
  async mapMarkers(hours = 24, limit = 200): Promise<MapMarker[]> {
    const rows = await this.db.many(
      `SELECT id, title, category_slug, importance, latitude, longitude, occurred_at, location_text
         FROM events
        WHERE merged_into_event_id IS NULL
          AND latitude IS NOT NULL AND longitude IS NOT NULL
          AND first_reported_at > now() - make_interval(hours => $1::int)
        ORDER BY first_reported_at DESC
        LIMIT $2`,
      [hours, limit],
    );

    return rows.map((row) => ({
      eventId: String(row.id),
      title: String(row.title),
      categorySlug: row.category_slug ? String(row.category_slug) : 'other',
      importance: String(row.importance) as MapMarker['importance'],
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      occurredAt: row.occurred_at ? String(row.occurred_at) : null,
      locationText: row.location_text ? String(row.location_text) : null,
    }));
  }

  /** Всё, что нужно главному экрану, — одним запросом с фронтенда. */
  async bundle(period: '24h' | '7d' | '30d' = '24h'): Promise<AnalyticsBundle> {
    const hours = period === '24h' ? 24 : period === '7d' ? 24 * 7 : 24 * 30;

    const [summary, timeseries, categories, topSources, recent, moderationQueue] = await Promise.all([
      this.summary(),
      this.timeseries(period),
      this.categoryDistribution(hours),
      this.topSources(8, hours),
      this.feed.list(feedFilterSchema.parse({ kind: 'events', limit: 8, sort: 'newest' })),
      this.moderationPreview(5),
    ]);

    return {
      summary,
      timeseries,
      categories,
      topSources,
      recentEvents: recent.items,
      moderationQueue,
    };
  }
}
