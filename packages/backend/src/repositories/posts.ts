import type { Importance, MediaItem, ProcessingStatus, SourcePost } from '@nnm/shared';
import type { Database } from '../db/pool.js';
import { mapMedia, mapSourcePost } from './mappers.js';

export interface NewSourcePost {
  sourceId: string;
  externalId: string;
  url: string | null;
  postedAt: string;
  rawText: string;
  normalizedText?: string | null;
  isForward?: boolean;
  forwardFrom?: string | null;
  rawHasProfanity?: boolean;
  metadata?: Record<string, unknown>;
}

export interface NewMedia {
  type: MediaItem['type'];
  originalUrl: string | null;
  mimeType?: string | null;
  caption?: string | null;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  sizeBytes?: number | null;
  position?: number;
}

export class PostsRepository {
  constructor(private readonly db: Database) {}

  /**
   * Сохранить публикацию вместе с медиа.
   *
   * Идемпотентно: повторный опрос источника не создаёт дубль. Возвращает
   * null, если публикация уже была сохранена ранее, — это позволяет
   * воркеру не ставить лишние задачи в очередь.
   */
  async insertIfNew(post: NewSourcePost, media: NewMedia[] = []): Promise<SourcePost | null> {
    return this.db.transaction(async (tx) => {
      const row = await tx.maybeOne(
        `INSERT INTO source_posts
           (source_id, external_id, url, posted_at, raw_text, normalized_text,
            is_forward, forward_from, raw_has_profanity, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (source_id, external_id) DO NOTHING
         RETURNING *`,
        [
          post.sourceId,
          post.externalId,
          post.url,
          post.postedAt,
          post.rawText,
          post.normalizedText ?? null,
          post.isForward ?? false,
          post.forwardFrom ?? null,
          post.rawHasProfanity ?? false,
          JSON.stringify(post.metadata ?? {}),
        ],
      );

      if (!row) return null;

      const saved = mapSourcePost(row);

      for (const [index, item] of media.entries()) {
        await tx.query(
          `INSERT INTO media
             (source_post_id, type, original_url, mime_type, caption, width, height,
              duration_seconds, size_bytes, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            saved.id,
            item.type,
            item.originalUrl,
            item.mimeType ?? null,
            item.caption ?? null,
            item.width ?? null,
            item.height ?? null,
            item.durationSeconds ?? null,
            item.sizeBytes ?? null,
            item.position ?? index,
          ],
        );
      }

      return saved;
    });
  }

  async findById(id: string): Promise<SourcePost | null> {
    const row = await this.db.maybeOne('SELECT * FROM source_posts WHERE id = $1', [id]);
    return row ? mapSourcePost(row) : null;
  }

  async findByIds(ids: string[]): Promise<SourcePost[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.many(
      'SELECT * FROM source_posts WHERE id = ANY($1::uuid[]) ORDER BY posted_at',
      [ids],
    );
    return rows.map(mapSourcePost);
  }

  async mediaForPosts(postIds: string[]): Promise<MediaItem[]> {
    if (postIds.length === 0) return [];
    const rows = await this.db.many(
      `SELECT * FROM media WHERE source_post_id = ANY($1::uuid[]) ORDER BY source_post_id, position`,
      [postIds],
    );
    return rows.map(mapMedia);
  }

  async setStatus(id: string, status: ProcessingStatus): Promise<void> {
    await this.db.query('UPDATE source_posts SET status = $2 WHERE id = $1', [id, status]);
  }

  /** Сохранить результат предварительной классификации публикации. */
  async setClassification(
    id: string,
    input: {
      categorySlug: string | null;
      importance: Importance | null;
      entities: string[];
      normalizedText: string | null;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE source_posts SET
         category_slug   = $2,
         importance      = $3,
         entities        = $4,
         normalized_text = COALESCE($5, normalized_text)
       WHERE id = $1`,
      [id, input.categorySlug, input.importance, input.entities, input.normalizedText],
    );
  }

  async attachToEvent(postId: string, eventId: string): Promise<void> {
    await this.db.query('UPDATE source_posts SET event_id = $2 WHERE id = $1', [postId, eventId]);
  }

  /** Публикации, ожидающие обработки. */
  async findPending(limit = 50): Promise<SourcePost[]> {
    const rows = await this.db.many(
      `SELECT * FROM source_posts WHERE status = 'NEW' ORDER BY posted_at LIMIT $1`,
      [limit],
    );
    return rows.map(mapSourcePost);
  }

  /**
   * Кандидаты на объединение: публикации в заданном временно́м окне,
   * уже прошедшие обработку.
   *
   * Окно ограничивает выборку до десятков-сотен записей, поэтому
   * досчёт близости в приложении остаётся дешёвым даже без pgvector.
   */
  async findDedupCandidates(input: {
    postedAt: string;
    windowHours: number;
    excludePostId: string;
    limit?: number;
  }): Promise<Array<SourcePost & { eventId: string | null }>> {
    const rows = await this.db.many(
      `SELECT p.* FROM source_posts p
        WHERE p.id <> $1
          AND p.posted_at BETWEEN $2::timestamptz - make_interval(hours => $3::int)
                              AND $2::timestamptz + make_interval(hours => $3::int)
          AND p.status IN ('PROCESSED','PROCESSING','NEEDS_REVIEW','APPROVED','PUBLISHED')
        ORDER BY abs(extract(epoch FROM (p.posted_at - $2::timestamptz)))
        LIMIT $4`,
      [input.excludePostId, input.postedAt, input.windowHours, input.limit ?? 200],
    );
    return rows.map((row) => ({ ...mapSourcePost(row), eventId: row.event_id ? String(row.event_id) : null }));
  }

  async countAll(): Promise<number> {
    const row = await this.db.one('SELECT count(*)::int AS count FROM source_posts');
    return Number(row.count);
  }
}
