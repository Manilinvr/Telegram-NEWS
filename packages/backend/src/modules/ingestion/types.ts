import type { MediaType, Source, SourceType } from '@nnm/shared';

/**
 * Контракт адаптера источника (ТЗ §18).
 *
 * Адаптер знает только, как получить публикации конкретной платформы, и
 * возвращает их в едином виде. Он НЕ пишет в БД, не решает, дубль это или
 * нет, и не занимается AI — это позволяет добавить новую платформу, не
 * трогая остальной pipeline, и тестировать сбор без базы.
 */

export interface FetchedMedia {
  type: MediaType;
  /** Прямой URL файла на платформе. Может быть временным. */
  url: string | null;
  /** Идентификатор файла на платформе — для повторного получения ссылки. */
  externalFileId?: string | null;
  mimeType?: string | null;
  caption?: string | null;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  sizeBytes?: number | null;
}

export interface FetchedPost {
  /** ID публикации на платформе. Должен быть стабильным. */
  externalId: string;
  url: string | null;
  postedAt: Date;
  text: string;
  isForward: boolean;
  forwardFrom: string | null;
  media: FetchedMedia[];
  /** Технические метаданные платформы — сохраняются как есть. */
  metadata: Record<string, unknown>;
}

export interface FetchResult {
  posts: FetchedPost[];
  /** Новый курсор инкрементальной загрузки. */
  lastExternalId: string | null;
  /**
   * Диагностическое сообщение, когда выборка получена частично.
   * Частичный результат — не ошибка: он сохраняется, а сбой фиксируется.
   */
  warning?: string;
}

export interface FetchOptions {
  /** Курсор: публикации до него уже сохранены. */
  sinceExternalId: string | null;
  /** Не забирать публикации старше этого момента. */
  notBefore: Date | null;
  limit: number;
}

export interface SourceAdapter {
  readonly type: SourceType;
  /** Человекочитаемое имя режима работы — попадает в диагностику. */
  readonly mode: string;
  /** Доступен ли адаптер при текущей конфигурации. */
  isConfigured(): boolean;
  /** Причина недоступности — показывается в интерфейсе настроек. */
  unavailableReason(): string | null;
  fetch(source: Source, options: FetchOptions): Promise<FetchResult>;
  /** Проверить доступность источника при его добавлении. */
  verify(source: Pick<Source, 'type' | 'username' | 'externalId' | 'url'>): Promise<
    { ok: true; title?: string; externalId?: string } | { ok: false; reason: string }
  >;
}

/** Ошибка адаптера, не являющаяся программным дефектом. */
export class SourceFetchError extends Error {
  constructor(
    message: string,
    readonly retriable: boolean = true,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SourceFetchError';
  }
}
