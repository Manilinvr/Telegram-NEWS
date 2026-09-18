import type {
  ConfirmationStatus,
  Importance,
  JobStatus,
  MediaType,
  ModerationStatus,
  PipelineStage,
  ProcessingStatus,
  SourceHealth,
  SourceType,
  TranscriptStatus,
} from './statuses.js';

/** ISO-8601 строка. На границе API все даты передаются строками. */
export type IsoDateTime = string;

export type UUID = string;

// ---------------------------------------------------------------------------
// Источники
// ---------------------------------------------------------------------------

export interface Source {
  id: UUID;
  type: SourceType;
  /** Отображаемое название («ТГ Новороссийск»). */
  title: string;
  /** @username канала или screen_name сообщества VK. */
  username: string | null;
  /** Числовой/строковый ID на платформе (chat_id, owner_id). */
  externalId: string | null;
  url: string;
  isActive: boolean;
  health: SourceHealth;
  /** Интервал опроса в секундах. */
  pollIntervalSeconds: number;
  lastSyncAt: IsoDateTime | null;
  lastSuccessfulSyncAt: IsoDateTime | null;
  /** Время самой свежей публикации, полученной из источника. */
  lastPostAt: IsoDateTime | null;
  postsFetched: number;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: IsoDateTime | null;
  /** Технические настройки подключения (не содержат секретов). */
  config: SourceConfig;
  notes: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface SourceConfig {
  /** Максимум публикаций за один опрос. */
  fetchLimit?: number;
  /** Игнорировать публикации старше N часов при первом импорте. */
  backfillHours?: number;
  /** Пропускать репосты/пересылки. */
  skipForwards?: boolean;
  /** Скачивать медиа этого источника. */
  downloadMedia?: boolean;
  /** Минимальная длина текста, чтобы публикация считалась содержательной. */
  minTextLength?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Сырые публикации
// ---------------------------------------------------------------------------

export interface SourcePost {
  id: UUID;
  sourceId: UUID;
  /** ID публикации на платформе (message_id / post id). */
  externalId: string;
  url: string | null;
  /** Время публикации в источнике. */
  postedAt: IsoDateTime;
  /** Время, когда система получила публикацию. */
  fetchedAt: IsoDateTime;
  /** Полный исходный текст — НИКОГДА не перезаписывается после AI-обработки. */
  rawText: string;
  /** Нормализованный текст (без эмодзи-шума, ссылок и т. п.) для анализа. */
  normalizedText: string | null;
  /** Признак пересылки/репоста. */
  isForward: boolean;
  forwardFrom: string | null;
  status: ProcessingStatus;
  /** Ссылка на событие, в которое вошла публикация. */
  eventId: UUID | null;
  /** Технические метаданные платформы (views, reactions, raw payload). */
  metadata: Record<string, unknown>;
  /** Признак наличия нецензурной лексики в ИСХОДНОМ тексте (для аудита). */
  rawHasProfanity: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface MediaItem {
  id: UUID;
  sourcePostId: UUID;
  type: MediaType;
  /** Ключ в объектном хранилище. Прямой публичный доступ запрещён. */
  storageKey: string | null;
  /** Оригинальный URL на платформе (может истечь). */
  originalUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  /** Подпись к медиа из исходной публикации. */
  caption: string | null;
  /** Ключ превью в хранилище. */
  thumbnailKey: string | null;
  /** Есть ли в медиа звуковая дорожка (определяется ffprobe). */
  hasAudio: boolean | null;
  downloadStatus: ProcessingStatus;
  downloadError: string | null;
  checksum: string | null;
  createdAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// События
// ---------------------------------------------------------------------------

export interface NewsEvent {
  id: UUID;
  title: string;
  summary: string;
  categorySlug: string;
  importance: Importance;
  status: ProcessingStatus;
  confirmationStatus: ConfirmationStatus;
  /** Уверенность системы в корректности объединения и извлечённых фактов. */
  confidence: number;
  /** Предполагаемое время самого происшествия (не публикации). */
  occurredAt: IsoDateTime | null;
  /** Время первой публикации об этом событии. */
  firstReportedAt: IsoDateTime;
  lastReportedAt: IsoDateTime;
  locationText: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Число независимых источников (а не число перепечаток). */
  independentSourceCount: number;
  sourcePostCount: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ExtractedFact {
  id: UUID;
  eventId: UUID;
  /** Формулировка факта. */
  text: string;
  /** Подтверждён ли факт независимыми источниками. */
  isConfirmed: boolean;
  /** Является ли утверждение предположением, а не фактом. */
  isAssumption: boolean;
  /** Публикация, из которой извлечён факт (происхождение каждого факта, ТЗ). */
  sourcePostId: UUID | null;
  /** Атрибуция: «по словам очевидца», «как сообщает источник». */
  attribution: string | null;
  confidence: number;
  createdAt: IsoDateTime;
}

export interface Transcript {
  id: UUID;
  mediaId: UUID;
  status: TranscriptStatus;
  /** Полный текст — доступен только в админке, не обязан попадать в пост. */
  fullText: string | null;
  language: string | null;
  /** Сегменты с таймкодами и говорящими. */
  segments: TranscriptSegment[];
  /** Отмеченные неразборчивые фрагменты. */
  unclearSegmentCount: number;
  provider: string | null;
  durationSeconds: number | null;
  error: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface TranscriptSegment {
  /** Начало сегмента в секундах. */
  start: number;
  end: number;
  text: string;
  /** Метка говорящего, если удалось разделить («SPEAKER_1»). */
  speaker: string | null;
  /** Уверенность распознавания 0..1. */
  confidence: number | null;
  /** true — фрагмент неразборчив; слова НЕ додумываются. */
  unclear: boolean;
}

// ---------------------------------------------------------------------------
// AI-черновик и модерация
// ---------------------------------------------------------------------------

export interface AiDraft {
  id: UUID;
  eventId: UUID;
  /** Версия черновика — история правок сохраняется. */
  version: number;
  title: string;
  /** Текст в формате, готовом для Telegram. */
  body: string;
  /** Итоговый текст Telegram-поста целиком (заголовок + тело + служебное). */
  telegramText: string;
  categorySlug: string;
  importance: Importance;
  locationText: string | null;
  /** Цитаты очевидцев, отобранные из транскрипции. */
  witnessQuotes: string[];
  /** Явно отмеченные неподтверждённые сведения. */
  uncertainties: string[];
  /** Утверждения с атрибуцией к источнику. */
  sourceClaims: SourceClaim[];
  confidence: number;
  /** Результат обязательной проверки лексики. */
  profanityChecked: boolean;
  profanityPassed: boolean;
  profanityReport: ProfanityReport | null;
  /** Кем создан черновик: AI или ручная правка модератора. */
  /**
   * Чем сделан черновик: моделью, набором правил (модель была
   * недоступна) или человеком. Правила и человек различаются намеренно:
   * первое имеет смысл пересобрать моделью, второе — неприкосновенно.
   */
  createdBy: 'AI' | 'HUMAN' | 'RULES';
  model: string | null;
  isCurrent: boolean;
  createdAt: IsoDateTime;
}

export interface SourceClaim {
  claim: string;
  sourceTitle: string;
  sourceUrl: string | null;
  attribution: string | null;
}

export interface ModerationQueueItem {
  id: UUID;
  eventId: UUID;
  draftId: UUID | null;
  status: ModerationStatus;
  priority: Importance;
  assignedTo: UUID | null;
  /** Причина блокировки (например, обнаружена запрещённая лексика). */
  blockedReason: string | null;
  reviewedBy: UUID | null;
  reviewedAt: IsoDateTime | null;
  rejectionReason: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /**
   * Сведения о самом событии — чтобы список очереди можно было читать.
   * Раньше строка показывала только «Событие 8fdc81d7», и выбрать
   * материал для проверки, не открыв его, было невозможно.
   */
  eventTitle?: string | null;
  categorySlug?: string | null;
  categoryTitle?: string | null;
  sourceTitles?: string[];
}

export interface Publication {
  id: UUID;
  eventId: UUID;
  draftId: UUID;
  channel: string;
  /** ID сообщения в Telegram — сохраняется после успешной отправки. */
  telegramMessageId: string | null;
  publishedText: string;
  mediaIds: UUID[];
  /** Пользователь, подтвердивший публикацию. */
  publishedBy: UUID;
  publishedAt: IsoDateTime;
  /** Был ли это сухой прогон (без реальной отправки). */
  dryRun: boolean;
  error: string | null;
  createdAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// ProfanityGuard (ТЗ §30)
// ---------------------------------------------------------------------------

export interface ProfanityMatch {
  /** Что именно совпало в нормализованном тексте. */
  matched: string;
  /** Исходный фрагмент до нормализации. */
  original: string;
  /** Корень/правило, по которому сработало обнаружение. */
  rule: string;
  /** Категория: мат — жёсткая блокировка, остальное — предупреждение. */
  severity: 'BLOCK' | 'WARN';
  /** Позиция в нормализованном тексте. */
  start: number;
  end: number;
  /** Где найдено: заголовок, тело, цитата и т. д. */
  field?: string;
}

export interface ProfanityReport {
  allowed: boolean;
  matches: ProfanityMatch[];
  reason: string;
  normalizedText: string;
  /** Версия словаря/правил — для воспроизводимости аудита. */
  rulesVersion: string;
  checkedAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Пользователи, задачи, логи
// ---------------------------------------------------------------------------

export interface User {
  id: UUID;
  email: string;
  displayName: string;
  role: 'OWNER' | 'ADMIN' | 'VIEWER';
  isActive: boolean;
  twoFactorEnabled: boolean;
  lastLoginAt: IsoDateTime | null;
  createdAt: IsoDateTime;
}

export interface ProcessingJob {
  id: UUID;
  type: string;
  status: JobStatus;
  stage: PipelineStage | null;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  runAt: IsoDateTime;
  startedAt: IsoDateTime | null;
  finishedAt: IsoDateTime | null;
  lastError: string | null;
  createdAt: IsoDateTime;
}

export interface ProcessingError {
  id: UUID;
  stage: PipelineStage;
  entityType: string;
  entityId: UUID | null;
  sourceId: UUID | null;
  message: string;
  details: Record<string, unknown>;
  isResolved: boolean;
  createdAt: IsoDateTime;
}

export interface AuditLogEntry {
  id: UUID;
  userId: UUID | null;
  action: string;
  entityType: string | null;
  entityId: UUID | null;
  ipAddress: string | null;
  userAgent: string | null;
  details: Record<string, unknown>;
  createdAt: IsoDateTime;
}
