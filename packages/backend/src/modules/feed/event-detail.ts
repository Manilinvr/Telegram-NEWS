import type { EventDetail, MediaItemView, SourcePostDetail } from '@nnm/shared';
import type { Database } from '../../db/pool.js';
import { mapDraft, mapMedia, mapSourcePost, mapTranscript } from '../../repositories/mappers.js';
import { DraftsRepository } from '../../repositories/drafts.js';
import { EventsRepository } from '../../repositories/events.js';
import { ModerationRepository } from '../../repositories/moderation.js';
import { OpsRepository } from '../../repositories/ops.js';
import { PublicationsRepository } from '../../repositories/publications.js';
import type { StorageDriver } from '../storage/driver.js';

/**
 * Сборка карточки события (ТЗ §10, §27).
 *
 * Карточка отдаётся ОДНИМ запросом со всем содержимым: происхождение
 * фактов, оригинальные ссылки, медиа, транскрипции, черновик, история
 * обработки. Принцип «минимум кликов до понимания новости» не работает,
 * если открытие карточки порождает каскад дозагрузок.
 */
export class EventDetailService {
  private readonly events: EventsRepository;
  private readonly drafts: DraftsRepository;
  private readonly moderation: ModerationRepository;
  private readonly publications: PublicationsRepository;
  private readonly ops: OpsRepository;

  constructor(
    private readonly db: Database,
    private readonly storage: StorageDriver,
  ) {
    this.events = new EventsRepository(db);
    this.drafts = new DraftsRepository(db);
    this.moderation = new ModerationRepository(db);
    this.publications = new PublicationsRepository(db);
    this.ops = new OpsRepository(db);
  }

  async get(eventId: string): Promise<EventDetail | null> {
    const event = await this.events.findById(eventId);
    if (!event) return null;

    const [category, facts, sources, draftHistory, moderation, publications, related, history] =
      await Promise.all([
        this.db.maybeOne(
          'SELECT slug, title, color, emoji FROM categories WHERE slug = $1',
          [event.categorySlug],
        ),
        this.events.factsFor(eventId),
        this.events.sourcesFor(eventId),
        this.drafts.history(eventId),
        this.moderation.findByEvent(eventId),
        this.publications.listForEvent(eventId),
        this.events.findRelated(eventId),
        this.ops.historyFor('event', eventId),
      ]);

    const postRows = await this.db.many(
      `SELECT p.*, s.id AS s_id, s.title AS s_title, s.type AS s_type, s.url AS s_url,
              s.username AS s_username
         FROM event_sources es
         JOIN source_posts p ON p.id = es.source_post_id
         JOIN sources s ON s.id = es.source_id
        WHERE es.event_id = $1
        ORDER BY p.posted_at`,
      [eventId],
    );

    const postIds = postRows.map((row) => String(row.id));
    const mediaRows = postIds.length
      ? await this.db.many(
          `SELECT m.*, t.id AS transcript_id
             FROM media m
             LEFT JOIN transcripts t ON t.media_id = m.id AND t.status = 'COMPLETED'
            WHERE m.source_post_id = ANY($1::uuid[])
            ORDER BY m.source_post_id, m.position`,
          [postIds],
        )
      : [];

    const transcriptRows = postIds.length
      ? await this.db.many(
          `SELECT t.* FROM transcripts t
             JOIN media m ON m.id = t.media_id
            WHERE m.source_post_id = ANY($1::uuid[])
            ORDER BY t.created_at`,
          [postIds],
        )
      : [];

    const mediaViews = await Promise.all(mediaRows.map((row) => this.toMediaView(row)));
    const mediaByPost = new Map<string, MediaItemView[]>();
    for (const view of mediaViews) {
      mediaByPost.set(view.sourcePostId, [...(mediaByPost.get(view.sourcePostId) ?? []), view]);
    }

    const transcripts = transcriptRows.map(mapTranscript);
    const transcriptsByMedia = new Set(transcripts.map((t) => t.mediaId));

    const posts: SourcePostDetail[] = postRows.map((row) => {
      const post = mapSourcePost(row);
      const postMedia = mediaByPost.get(post.id) ?? [];
      return {
        ...post,
        source: {
          id: String(row.s_id),
          title: String(row.s_title),
          type: String(row.s_type) as SourcePostDetail['source']['type'],
          url: String(row.s_url),
          username: row.s_username ? String(row.s_username) : null,
        },
        media: postMedia,
        transcripts: transcripts.filter((t) => postMedia.some((m) => m.id === t.mediaId)),
      };
    });

    const currentDraft = draftHistory.find((draft) => draft.isCurrent) ?? null;

    return {
      ...event,
      category: category
        ? {
            slug: String(category.slug),
            title: String(category.title),
            color: String(category.color),
            emoji: String(category.emoji),
          }
        : null,
      facts,
      posts,
      media: mediaViews.map((view) => ({
        ...view,
        hasTranscript: transcriptsByMedia.has(view.id),
      })),
      transcripts,
      draft: currentDraft,
      draftHistory: draftHistory.map((draft) => ({
        id: draft.id,
        version: draft.version,
        createdBy: draft.createdBy,
        createdAt: draft.createdAt,
        title: draft.title,
      })),
      moderation,
      publications,
      relatedEvents: related,
      processingHistory: history,
      sources,
    };
  }

  private async toMediaView(row: Record<string, unknown>): Promise<MediaItemView> {
    const media = mapMedia(row);
    return {
      ...media,
      // Ссылки короткоживущие: бакет приватный, прямой доступ закрыт.
      url: media.storageKey ? await this.storage.signedUrl(media.storageKey, 900) : media.originalUrl,
      thumbnailUrl: media.thumbnailKey
        ? await this.storage.signedUrl(media.thumbnailKey, 900)
        : null,
      hasTranscript: Boolean(row.transcript_id),
    };
  }

  /** Отдельная публикация со всем содержимым — для инспектора ленты. */
  async getPost(postId: string): Promise<SourcePostDetail | null> {
    const row = await this.db.maybeOne(
      `SELECT p.*, s.id AS s_id, s.title AS s_title, s.type AS s_type, s.url AS s_url,
              s.username AS s_username
         FROM source_posts p JOIN sources s ON s.id = p.source_id
        WHERE p.id = $1`,
      [postId],
    );
    if (!row) return null;

    const mediaRows = await this.db.many(
      `SELECT m.*, t.id AS transcript_id
         FROM media m
         LEFT JOIN transcripts t ON t.media_id = m.id AND t.status = 'COMPLETED'
        WHERE m.source_post_id = $1 ORDER BY m.position`,
      [postId],
    );
    const transcriptRows = await this.db.many(
      `SELECT t.* FROM transcripts t JOIN media m ON m.id = t.media_id
        WHERE m.source_post_id = $1`,
      [postId],
    );

    const media = await Promise.all(mediaRows.map((item) => this.toMediaView(item)));

    return {
      ...mapSourcePost(row),
      source: {
        id: String(row.s_id),
        title: String(row.s_title),
        type: String(row.s_type) as SourcePostDetail['source']['type'],
        url: String(row.s_url),
        username: row.s_username ? String(row.s_username) : null,
      },
      media,
      transcripts: transcriptRows.map(mapTranscript),
    };
  }
}
