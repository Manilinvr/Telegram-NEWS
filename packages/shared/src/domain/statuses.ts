/**
 * Единая система статусов (ТЗ §28).
 *
 * Статусы обработки и модерации намеренно разделены: публикация может быть
 * успешно обработана (PROCESSED), но ещё не пройти модерацию, и наоборот —
 * отклонена модератором при полностью успешной обработке.
 */

/** Статус прохождения публикации/события через pipeline обработки. */
export const PROCESSING_STATUS = {
  NEW: 'NEW',
  PROCESSING: 'PROCESSING',
  PROCESSED: 'PROCESSED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  APPROVED: 'APPROVED',
  PUBLISHED: 'PUBLISHED',
  REJECTED: 'REJECTED',
  ERROR: 'ERROR',
} as const;

export type ProcessingStatus = (typeof PROCESSING_STATUS)[keyof typeof PROCESSING_STATUS];

export const PROCESSING_STATUSES = Object.values(PROCESSING_STATUS);

/**
 * Статус подтверждённости события.
 *
 * ВАЖНО (ТЗ §28): уровень подтверждения НЕ выводится только из количества
 * перепечаток. Несколько источников, скопировавших один и тот же текст, — это
 * по-прежнему один первоисточник. Учитывается независимость источников,
 * наличие собственных медиа и совпадение фактов, а не число копий.
 */
export const CONFIRMATION_STATUS = {
  UNCONFIRMED: 'UNCONFIRMED',
  PARTIALLY_CONFIRMED: 'PARTIALLY_CONFIRMED',
  CONFIRMED: 'CONFIRMED',
} as const;

export type ConfirmationStatus = (typeof CONFIRMATION_STATUS)[keyof typeof CONFIRMATION_STATUS];

export const CONFIRMATION_STATUSES = Object.values(CONFIRMATION_STATUS);

/** Статус элемента очереди модерации. */
export const MODERATION_STATUS = {
  PENDING: 'PENDING',
  IN_REVIEW: 'IN_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  PUBLISHED: 'PUBLISHED',
  BLOCKED: 'BLOCKED',
} as const;

export type ModerationStatus = (typeof MODERATION_STATUS)[keyof typeof MODERATION_STATUS];

export const MODERATION_STATUSES = Object.values(MODERATION_STATUS);

/** Уровень важности события. */
export const IMPORTANCE = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;

export type Importance = (typeof IMPORTANCE)[keyof typeof IMPORTANCE];

export const IMPORTANCE_LEVELS = Object.values(IMPORTANCE);

/** Порядок важности для сортировки (больше — важнее). */
export const IMPORTANCE_WEIGHT: Record<Importance, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/** Статус транскрипции. Отсутствие транскрипции не блокирует событие (ТЗ §24). */
export const TRANSCRIPT_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  UNAVAILABLE: 'UNAVAILABLE',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
} as const;

export type TranscriptStatus = (typeof TRANSCRIPT_STATUS)[keyof typeof TRANSCRIPT_STATUS];

/** Статус фоновой задачи в очереди. */
export const JOB_STATUS = {
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  DEAD: 'DEAD',
  CANCELLED: 'CANCELLED',
} as const;

export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

/** Состояние здоровья источника. */
export const SOURCE_HEALTH = {
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  FAILING: 'FAILING',
  DISABLED: 'DISABLED',
  UNKNOWN: 'UNKNOWN',
} as const;

export type SourceHealth = (typeof SOURCE_HEALTH)[keyof typeof SOURCE_HEALTH];

/** Тип источника. */
export const SOURCE_TYPE = {
  TELEGRAM: 'TELEGRAM',
  VK: 'VK',
} as const;

export type SourceType = (typeof SOURCE_TYPE)[keyof typeof SOURCE_TYPE];

/** Тип медиа-вложения. */
export const MEDIA_TYPE = {
  PHOTO: 'PHOTO',
  VIDEO: 'VIDEO',
  AUDIO: 'AUDIO',
  DOCUMENT: 'DOCUMENT',
  ANIMATION: 'ANIMATION',
} as const;

export type MediaType = (typeof MEDIA_TYPE)[keyof typeof MEDIA_TYPE];

/** Этапы pipeline (ТЗ §17) — используются в логах и диагностике. */
export const PIPELINE_STAGE = {
  INGESTION: 'INGESTION',
  NORMALIZATION: 'NORMALIZATION',
  MEDIA_PROCESSING: 'MEDIA_PROCESSING',
  TRANSCRIPTION: 'TRANSCRIPTION',
  FACT_EXTRACTION: 'FACT_EXTRACTION',
  CLASSIFICATION: 'CLASSIFICATION',
  DEDUPLICATION: 'DEDUPLICATION',
  EVENT_BUILD: 'EVENT_BUILD',
  AI_DRAFT: 'AI_DRAFT',
  PROFANITY_VALIDATION: 'PROFANITY_VALIDATION',
  MODERATION: 'MODERATION',
  FINAL_VALIDATION: 'FINAL_VALIDATION',
  TELEGRAM_PUBLISH: 'TELEGRAM_PUBLISH',
} as const;

export type PipelineStage = (typeof PIPELINE_STAGE)[keyof typeof PIPELINE_STAGE];

export const PIPELINE_STAGES = Object.values(PIPELINE_STAGE);
