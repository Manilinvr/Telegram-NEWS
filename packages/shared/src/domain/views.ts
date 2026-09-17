import type {
  AiDraft,
  ExtractedFact,
  IsoDateTime,
  MediaItem,
  ModerationQueueItem,
  NewsEvent,
  Publication,
  Source,
  SourcePost,
  Transcript,
  UUID,
} from './types.js';
import type { Importance, ProcessingStatus, SourceHealth } from './statuses.js';

/**
 * Составные представления для API.
 *
 * Фронтенд получает уже собранные объекты — принцип «минимум кликов до
 * понимания новости» (ТЗ §27) требует, чтобы карточка открывалась одним
 * запросом, без каскада дозагрузок.
 */

/** Элемент ленты — компактное представление для LIVE FEED (ТЗ §16). */
export interface FeedItem {
  kind: 'event' | 'post';
  id: UUID;
  title: string;
  excerpt: string;
  categorySlug: string;
  importance: Importance;
  status: ProcessingStatus;
  /** Время публикации/происшествия. */
  timestamp: IsoDateTime;
  /** Название источника (для post) либо «N источников» (для event). */
  sourceTitle: string;
  sourceType: string | null;
  sourceCount: number;
  locationText: string | null;
  confidence: number | null;
  hasPhoto: boolean;
  hasVideo: boolean;
  hasTranscript: boolean;
  hasDraft: boolean;
  isPublished: boolean;
  /** Превью первого изображения (presigned URL, короткоживущий). */
  thumbnailUrl: string | null;
  /** Событие, к которому относится публикация. */
  eventId: UUID | null;
}

/** Публикация вместе с медиа и источником. */
export interface SourcePostDetail extends SourcePost {
  source: Pick<Source, 'id' | 'title' | 'type' | 'url' | 'username'>;
  media: MediaItemView[];
  transcripts: Transcript[];
}

/** Медиа с временной ссылкой на файл. */
export interface MediaItemView extends MediaItem {
  /** Presigned URL, действует ограниченное время. Хранилище не публично. */
  url: string | null;
  thumbnailUrl: string | null;
  hasTranscript: boolean;
}

/** Полная карточка события (ТЗ §10). */
export interface EventDetail extends NewsEvent {
  category: { slug: string; title: string; color: string; emoji: string } | null;
  facts: ExtractedFact[];
  posts: SourcePostDetail[];
  media: MediaItemView[];
  transcripts: Transcript[];
  /** Текущий черновик. */
  draft: AiDraft | null;
  /** История версий черновика. */
  draftHistory: Array<Pick<AiDraft, 'id' | 'version' | 'createdBy' | 'createdAt' | 'title'>>;
  moderation: ModerationQueueItem | null;
  publications: Publication[];
  /** Связанные / потенциально дублирующие события. */
  relatedEvents: RelatedEvent[];
  /** История прохождения по pipeline. */
  processingHistory: ProcessingHistoryEntry[];
  /** Источники события с оригинальными ссылками (происхождение фактов). */
  sources: EventSourceRef[];
}

export interface EventSourceRef {
  sourceId: UUID;
  sourceTitle: string;
  sourceType: string;
  sourcePostId: UUID;
  originalUrl: string | null;
  postedAt: IsoDateTime;
  /** Считается ли источник независимым (не перепечатка). */
  isIndependent: boolean;
  /** Оценка сходства с первой публикацией события. */
  similarity: number | null;
}

export interface RelatedEvent {
  id: UUID;
  title: string;
  occurredAt: IsoDateTime | null;
  similarity: number;
  /** `duplicate` — вероятный дубль, `related` — связанное событие. */
  relation: 'duplicate' | 'related';
}

export interface ProcessingHistoryEntry {
  stage: string;
  status: string;
  message: string | null;
  durationMs: number | null;
  createdAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Аналитика (ТЗ §15)
// ---------------------------------------------------------------------------

export interface DashboardSummary {
  sources: {
    total: number;
    active: number;
    failing: number;
    byHealth: Record<SourceHealth, number>;
  };
  posts: {
    last24h: number;
    deltaVsPrev24h: number;
    total: number;
  };
  events: {
    last24h: number;
    deltaVsPrev24h: number;
    total: number;
  };
  moderation: {
    pending: number;
    blocked: number;
  };
  publications: {
    last24h: number;
    total: number;
  };
  errors: {
    unresolved: number;
    last24h: number;
  };
  jobs: {
    queued: number;
    running: number;
    failed: number;
  };
  generatedAt: IsoDateTime;
}

/** Точка временного ряда для графиков. */
export interface TimeseriesPoint {
  bucket: IsoDateTime;
  posts: number;
  events: number;
}

export interface CategoryDistributionItem {
  slug: string;
  title: string;
  color: string;
  count: number;
  share: number;
}

export interface SourceActivityItem {
  sourceId: UUID;
  title: string;
  type: string;
  health: SourceHealth;
  postCount: number;
  lastPostAt: IsoDateTime | null;
}

export interface AnalyticsBundle {
  summary: DashboardSummary;
  timeseries: TimeseriesPoint[];
  categories: CategoryDistributionItem[];
  topSources: SourceActivityItem[];
  recentEvents: FeedItem[];
  moderationQueue: ModerationQueuePreview[];
}

export interface ModerationQueuePreview {
  id: UUID;
  eventId: UUID;
  title: string;
  categorySlug: string;
  importance: Importance;
  status: string;
  blockedReason: string | null;
  createdAt: IsoDateTime;
}

/** Точка на карте событий. */
export interface MapMarker {
  eventId: UUID;
  title: string;
  categorySlug: string;
  importance: Importance;
  latitude: number;
  longitude: number;
  occurredAt: IsoDateTime | null;
  locationText: string | null;
}

// ---------------------------------------------------------------------------
// Live-поток (SSE)
// ---------------------------------------------------------------------------

export type LiveEventType =
  | 'post.created'
  | 'event.created'
  | 'event.updated'
  | 'draft.created'
  | 'moderation.updated'
  | 'publication.created'
  | 'source.health'
  | 'job.failed'
  | 'stats.updated'
  | 'heartbeat';

export interface LiveMessage<T = unknown> {
  type: LiveEventType;
  payload: T;
  at: IsoDateTime;
}
