import type {
  AiDraft,
  AuditLogEntry,
  ExtractedFact,
  MediaItem,
  ModerationQueueItem,
  NewsEvent,
  ProcessingError,
  ProcessingJob,
  Publication,
  Source,
  SourcePost,
  Transcript,
  User,
} from '@nnm/shared';

/**
 * Преобразование строк БД в доменные объекты.
 *
 * Мапперы написаны явно, а не автоматическим переименованием полей:
 * так видно, какие поля отдаются наружу, и приватные колонки (хэш пароля,
 * секрет 2FA, сырой ответ модели) физически не могут «протечь» в API
 * из-за того, что кто-то добавил колонку в таблицу.
 */

type Row = Record<string, unknown>;

const str = (value: unknown): string => (value === null || value === undefined ? '' : String(value));
const nullableStr = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
const nullableNum = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
const bool = (value: unknown): boolean => value === true;
const nullableBool = (value: unknown): boolean | null =>
  value === null || value === undefined ? null : value === true;

/** jsonb приходит уже разобранным; строка возможна лишь при ручных запросах. */
const json = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
};

const arr = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

export function mapUser(row: Row): User {
  return {
    id: str(row.id),
    email: str(row.email),
    displayName: str(row.display_name),
    role: str(row.role) as User['role'],
    isActive: bool(row.is_active),
    twoFactorEnabled: bool(row.two_factor_enabled),
    lastLoginAt: nullableStr(row.last_login_at),
    createdAt: str(row.created_at),
  };
}

export function mapSource(row: Row): Source {
  return {
    id: str(row.id),
    type: str(row.type) as Source['type'],
    title: str(row.title),
    username: nullableStr(row.username),
    externalId: nullableStr(row.external_id),
    url: str(row.url),
    isActive: bool(row.is_active),
    health: str(row.health) as Source['health'],
    pollIntervalSeconds: num(row.poll_interval_seconds),
    lastSyncAt: nullableStr(row.last_sync_at),
    lastSuccessfulSyncAt: nullableStr(row.last_successful_sync_at),
    lastPostAt: nullableStr(row.last_post_at),
    postsFetched: num(row.posts_fetched),
    consecutiveFailures: num(row.consecutive_failures),
    lastError: nullableStr(row.last_error),
    lastErrorAt: nullableStr(row.last_error_at),
    config: json(row.config, {}),
    notes: nullableStr(row.notes),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function mapSourcePost(row: Row): SourcePost {
  return {
    id: str(row.id),
    sourceId: str(row.source_id),
    externalId: str(row.external_id),
    url: nullableStr(row.url),
    postedAt: str(row.posted_at),
    fetchedAt: str(row.fetched_at),
    rawText: str(row.raw_text),
    normalizedText: nullableStr(row.normalized_text),
    isForward: bool(row.is_forward),
    forwardFrom: nullableStr(row.forward_from),
    status: str(row.status) as SourcePost['status'],
    eventId: nullableStr(row.event_id),
    metadata: json(row.metadata, {}),
    rawHasProfanity: bool(row.raw_has_profanity),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function mapMedia(row: Row): MediaItem {
  return {
    id: str(row.id),
    sourcePostId: str(row.source_post_id),
    type: str(row.type) as MediaItem['type'],
    storageKey: nullableStr(row.storage_key),
    originalUrl: nullableStr(row.original_url),
    mimeType: nullableStr(row.mime_type),
    sizeBytes: nullableNum(row.size_bytes),
    width: nullableNum(row.width),
    height: nullableNum(row.height),
    durationSeconds: nullableNum(row.duration_seconds),
    caption: nullableStr(row.caption),
    thumbnailKey: nullableStr(row.thumbnail_key),
    hasAudio: nullableBool(row.has_audio),
    downloadStatus: str(row.download_status) as MediaItem['downloadStatus'],
    downloadError: nullableStr(row.download_error),
    checksum: nullableStr(row.checksum),
    createdAt: str(row.created_at),
  };
}

export function mapEvent(row: Row): NewsEvent {
  return {
    id: str(row.id),
    title: str(row.title),
    summary: str(row.summary),
    categorySlug: str(row.category_slug),
    importance: str(row.importance) as NewsEvent['importance'],
    status: str(row.status) as NewsEvent['status'],
    confirmationStatus: str(row.confirmation_status) as NewsEvent['confirmationStatus'],
    confidence: num(row.confidence),
    occurredAt: nullableStr(row.occurred_at),
    firstReportedAt: str(row.first_reported_at),
    lastReportedAt: str(row.last_reported_at),
    locationText: nullableStr(row.location_text),
    latitude: nullableNum(row.latitude),
    longitude: nullableNum(row.longitude),
    independentSourceCount: num(row.independent_source_count),
    sourcePostCount: num(row.source_post_count),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function mapFact(row: Row): ExtractedFact {
  return {
    id: str(row.id),
    eventId: str(row.event_id),
    text: str(row.text),
    isConfirmed: bool(row.is_confirmed),
    isAssumption: bool(row.is_assumption),
    sourcePostId: nullableStr(row.source_post_id),
    attribution: nullableStr(row.attribution),
    confidence: num(row.confidence),
    createdAt: str(row.created_at),
  };
}

export function mapTranscript(row: Row): Transcript {
  return {
    id: str(row.id),
    mediaId: str(row.media_id),
    status: str(row.status) as Transcript['status'],
    fullText: nullableStr(row.full_text),
    language: nullableStr(row.language),
    segments: json(row.segments, []),
    unclearSegmentCount: num(row.unclear_segment_count),
    provider: nullableStr(row.provider),
    durationSeconds: nullableNum(row.duration_seconds),
    error: nullableStr(row.error),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function mapDraft(row: Row): AiDraft {
  return {
    id: str(row.id),
    eventId: str(row.event_id),
    version: num(row.version),
    title: str(row.title),
    body: str(row.body),
    telegramText: str(row.telegram_text),
    categorySlug: str(row.category_slug),
    importance: str(row.importance) as AiDraft['importance'],
    locationText: nullableStr(row.location_text),
    witnessQuotes: json(row.witness_quotes, []),
    uncertainties: json(row.uncertainties, []),
    sourceClaims: json(row.source_claims, []),
    confidence: num(row.confidence),
    profanityChecked: bool(row.profanity_checked),
    profanityPassed: bool(row.profanity_passed),
    profanityReport: json(row.profanity_report, null),
    createdBy: str(row.created_by) as AiDraft['createdBy'],
    model: nullableStr(row.model),
    isCurrent: bool(row.is_current),
    createdAt: str(row.created_at),
  };
}

export function mapModeration(row: Row): ModerationQueueItem {
  return {
    id: str(row.id),
    eventId: str(row.event_id),
    draftId: nullableStr(row.draft_id),
    status: str(row.status) as ModerationQueueItem['status'],
    priority: str(row.priority) as ModerationQueueItem['priority'],
    assignedTo: nullableStr(row.assigned_to),
    blockedReason: nullableStr(row.blocked_reason),
    reviewedBy: nullableStr(row.reviewed_by),
    reviewedAt: nullableStr(row.reviewed_at),
    rejectionReason: nullableStr(row.rejection_reason),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    // Поля события присутствуют только в списке очереди: одиночная
    // запись читается без соединений.
    ...(row.event_title !== undefined ? { eventTitle: nullableStr(row.event_title) } : {}),
    ...(row.category_slug !== undefined ? { categorySlug: nullableStr(row.category_slug) } : {}),
    ...(row.category_title !== undefined ? { categoryTitle: nullableStr(row.category_title) } : {}),
    ...(Array.isArray(row.source_titles)
      ? { sourceTitles: (row.source_titles as unknown[]).map((v) => String(v)) }
      : {}),
  };
}

export function mapPublication(row: Row): Publication {
  return {
    id: str(row.id),
    eventId: str(row.event_id),
    draftId: str(row.draft_id),
    channel: str(row.channel),
    telegramMessageId: nullableStr(row.telegram_message_id),
    publishedText: str(row.published_text),
    mediaIds: arr(row.media_ids),
    publishedBy: str(row.published_by),
    publishedAt: str(row.published_at),
    dryRun: bool(row.dry_run),
    error: nullableStr(row.error),
    createdAt: str(row.created_at),
  };
}

export function mapJob(row: Row): ProcessingJob {
  return {
    id: str(row.id),
    type: str(row.type),
    status: str(row.status) as ProcessingJob['status'],
    stage: nullableStr(row.stage) as ProcessingJob['stage'],
    payload: json(row.payload, {}),
    attempts: num(row.attempts),
    maxAttempts: num(row.max_attempts),
    runAt: str(row.run_at),
    startedAt: nullableStr(row.started_at),
    finishedAt: nullableStr(row.finished_at),
    lastError: nullableStr(row.last_error),
    createdAt: str(row.created_at),
  };
}

export function mapProcessingError(row: Row): ProcessingError {
  return {
    id: str(row.id),
    stage: str(row.stage) as ProcessingError['stage'],
    entityType: str(row.entity_type),
    entityId: nullableStr(row.entity_id),
    sourceId: nullableStr(row.source_id),
    message: str(row.message),
    details: json(row.details, {}),
    isResolved: bool(row.is_resolved),
    createdAt: str(row.created_at),
  };
}

export function mapAuditLog(row: Row): AuditLogEntry {
  return {
    id: str(row.id),
    userId: nullableStr(row.user_id),
    action: str(row.action),
    entityType: nullableStr(row.entity_type),
    entityId: nullableStr(row.entity_id),
    ipAddress: nullableStr(row.ip_address),
    userAgent: nullableStr(row.user_agent),
    details: json(row.details, {}),
    createdAt: str(row.created_at),
  };
}
