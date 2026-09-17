import { PIPELINE_STAGE, TELEGRAM_TEXT_LIMIT, type Publication, type User } from '@nnm/shared';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db/pool.js';
import { childLogger } from '../../lib/logger.js';
import { AUDIT_ACTIONS, AuditRepository } from '../../repositories/audit.js';
import { DraftsRepository } from '../../repositories/drafts.js';
import { EventsRepository } from '../../repositories/events.js';
import { ModerationRepository } from '../../repositories/moderation.js';
import { OpsRepository } from '../../repositories/ops.js';
import { PublicationsRepository } from '../../repositories/publications.js';
import { ProfanityGuard } from '../profanity/index.js';
import type { StorageDriver } from '../storage/driver.js';
import { TelegramPublisher, type PublishMedia } from './telegram-publisher.js';

const log = childLogger({ module: 'publishing' });

export interface PublishRequest {
  eventId: string;
  user: User;
  ipAddress: string | null;
  userAgent: string | null;
  /** Подтверждение владельца — обязательно (ТЗ §13). */
  confirmed: boolean;
}

export interface PublishOutcome {
  ok: boolean;
  publication?: Publication;
  /** Код отказа — используется фронтендом для точной подсказки. */
  code?:
    | 'NOT_FOUND'
    | 'NOT_CONFIRMED'
    | 'NOT_APPROVED'
    | 'NO_DRAFT'
    | 'EMPTY_TEXT'
    | 'TEXT_TOO_LONG'
    | 'PROFANITY_BLOCKED'
    | 'MISSING_SOURCES'
    | 'NOT_CONFIGURED'
    | 'FORBIDDEN'
    | 'SEND_FAILED';
  message?: string;
  /** Отчёт финальной проверки лексики — показывается модератору. */
  profanityReport?: unknown;
}

/**
 * Публикация материала (ТЗ §13, §31).
 *
 * Перед отправкой выполняется фиксированная последовательность проверок.
 * Порядок важен: сначала дешёвые и безусловные (права, подтверждение,
 * статус модерации), затем содержательные, и только в самом конце —
 * обращение к Telegram. Ни одну из проверок нельзя пропустить флагом:
 * они выполняются здесь, а не в интерфейсе.
 *
 * Автопубликация предусмотрена архитектурно, но в MVP выключена: без
 * подтверждения человека метод возвращает отказ, и никакой настройкой
 * это не обходится, пока AUTO_PUBLISH_ENABLED не включён ЯВНО.
 */
export class PublishingService {
  private readonly events: EventsRepository;
  private readonly drafts: DraftsRepository;
  private readonly moderation: ModerationRepository;
  private readonly publications: PublicationsRepository;
  private readonly audit: AuditRepository;
  private readonly ops: OpsRepository;
  private readonly profanity: ProfanityGuard;
  private readonly publisher: TelegramPublisher;

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly storage: StorageDriver,
    publisher?: TelegramPublisher,
    profanity?: ProfanityGuard,
  ) {
    this.events = new EventsRepository(db);
    this.drafts = new DraftsRepository(db);
    this.moderation = new ModerationRepository(db);
    this.publications = new PublicationsRepository(db);
    this.audit = new AuditRepository(db);
    this.ops = new OpsRepository(db);
    this.profanity = profanity ?? new ProfanityGuard();
    this.publisher = publisher ?? new TelegramPublisher(config);
  }

  get publisherStatus() {
    return {
      configured: this.publisher.isConfigured(),
      reason: this.publisher.unavailableReason(),
      channel: this.publisher.channel,
      dryRun: this.publisher.isDryRun,
      autoPublishEnabled: this.config.AUTO_PUBLISH_ENABLED,
    };
  }

  async publish(request: PublishRequest): Promise<PublishOutcome> {
    const { eventId, user } = request;

    await this.audit.log({
      userId: user.id,
      action: AUDIT_ACTIONS.PUBLISH_ATTEMPT,
      entityType: 'event',
      entityId: eventId,
      ipAddress: request.ipAddress,
      userAgent: request.userAgent,
    });

    // --- 1. Права ---------------------------------------------------------
    if (user.role !== 'OWNER' && user.role !== 'ADMIN') {
      return this.deny(request, 'FORBIDDEN', 'Недостаточно прав для публикации.');
    }

    // --- 2. Подтверждение человека (ТЗ §13) -------------------------------
    if (!request.confirmed) {
      return this.deny(
        request,
        'NOT_CONFIRMED',
        'Публикация возможна только после явного подтверждения.',
      );
    }

    // --- 3. Событие и черновик -------------------------------------------
    const event = await this.events.findById(eventId);
    if (!event) return this.deny(request, 'NOT_FOUND', 'Событие не найдено.');

    const draft = await this.drafts.findCurrent(eventId);
    if (!draft) return this.deny(request, 'NO_DRAFT', 'У события нет готового черновика.');

    // --- 4. Статус модерации ---------------------------------------------
    const moderation = await this.moderation.findByEvent(eventId);
    if (!moderation || moderation.status !== 'APPROVED') {
      return this.deny(
        request,
        'NOT_APPROVED',
        `Материал не одобрен к публикации (текущий статус: ${moderation?.status ?? 'нет записи'}).`,
      );
    }

    // --- 5. Обязательные данные ------------------------------------------
    const text = draft.telegramText.trim();
    if (text.length === 0) {
      return this.deny(request, 'EMPTY_TEXT', 'Текст публикации пуст.');
    }
    if (text.length > TELEGRAM_TEXT_LIMIT) {
      return this.deny(
        request,
        'TEXT_TOO_LONG',
        `Текст длиннее допустимого (${text.length} из ${TELEGRAM_TEXT_LIMIT} символов).`,
      );
    }

    const sources = await this.events.sourcesFor(eventId);
    if (sources.length === 0) {
      // Публиковать материал без указания происхождения нельзя.
      return this.deny(request, 'MISSING_SOURCES', 'У события не указано ни одного источника.');
    }

    // --- 6. ФИНАЛЬНАЯ проверка лексики (ТЗ §12, §30) ----------------------
    // Выполняется всегда, даже если черновик уже проверялся: текст мог
    // быть отредактирован вручную после предыдущей проверки.
    const finalReport = this.profanity.validateBeforePublish({
      title: draft.title,
      body: draft.body,
      telegramPreview: text,
      quotes: draft.witnessQuotes,
    });

    if (!finalReport.allowed) {
      await this.moderation.setStatus(eventId, 'BLOCKED', {
        reviewedBy: user.id,
        blockedReason: finalReport.reason,
      });
      await this.ops.recordHistory({
        entityType: 'event',
        entityId: eventId,
        stage: PIPELINE_STAGE.FINAL_VALIDATION,
        status: 'BLOCKED',
        message: finalReport.reason,
      });
      await this.audit.log({
        userId: user.id,
        action: AUDIT_ACTIONS.PUBLISH_BLOCKED,
        entityType: 'event',
        entityId: eventId,
        ipAddress: request.ipAddress,
        userAgent: request.userAgent,
        details: { reason: finalReport.reason, matches: finalReport.matches.length },
      });

      log.warn({ eventId, reason: finalReport.reason }, 'Публикация заблокирована финальной проверкой');

      return {
        ok: false,
        code: 'PROFANITY_BLOCKED',
        message: finalReport.reason,
        profanityReport: finalReport,
      };
    }

    // --- 7. Настройки Telegram -------------------------------------------
    // Требуются только для реальной отправки. В режиме сухого прогона
    // материал проходит весь путь без подключённого бота — это позволяет
    // принять систему до получения токена.
    if (!this.publisher.isDryRun && !this.publisher.isConfigured()) {
      return this.deny(
        request,
        'NOT_CONFIGURED',
        this.publisher.unavailableReason() ?? 'Публикация в Telegram не настроена.',
      );
    }

    // --- 8. Отправка ------------------------------------------------------
    const media = await this.collectMedia(eventId);
    const result = await this.publisher.publish({ text, media: media.items });

    const publication = await this.publications.record({
      eventId,
      draftId: draft.id,
      channel: this.publisher.channel,
      telegramMessageId: result.messageId,
      publishedText: text,
      mediaIds: media.ids,
      publishedBy: user.id,
      dryRun: result.dryRun,
      finalCheckReport: finalReport,
      error: result.ok ? null : (result.error ?? 'Неизвестная ошибка отправки'),
    });

    if (!result.ok) {
      // Материал не потерян: он остаётся одобренным, а причина сбоя
      // показывается модератору (ТЗ §24).
      await this.ops.recordError({
        stage: PIPELINE_STAGE.TELEGRAM_PUBLISH,
        entityType: 'event',
        entityId: eventId,
        message: result.error ?? 'Ошибка отправки',
      });
      await this.audit.log({
        userId: user.id,
        action: AUDIT_ACTIONS.PUBLISH_FAILED,
        entityType: 'event',
        entityId: eventId,
        ipAddress: request.ipAddress,
        userAgent: request.userAgent,
        details: { error: result.error },
      });

      return {
        ok: false,
        code: 'SEND_FAILED',
        message: result.error ?? 'Не удалось отправить сообщение в Telegram.',
        publication,
      };
    }

    await this.moderation.setStatus(eventId, 'PUBLISHED', { reviewedBy: user.id });
    await this.events.setStatus(eventId, 'PUBLISHED');
    await this.ops.recordHistory({
      entityType: 'event',
      entityId: eventId,
      stage: PIPELINE_STAGE.TELEGRAM_PUBLISH,
      status: result.dryRun ? 'DRY_RUN' : 'OK',
      message: result.dryRun
        ? `Сухой прогон: сообщение не отправлено. ${result.warning ?? ''}`.trim()
        : `Опубликовано, message_id=${result.messageId}`,
    });
    await this.audit.log({
      userId: user.id,
      action: AUDIT_ACTIONS.PUBLISH_SUCCESS,
      entityType: 'event',
      entityId: eventId,
      ipAddress: request.ipAddress,
      userAgent: request.userAgent,
      details: {
        messageId: result.messageId,
        dryRun: result.dryRun,
        channel: this.publisher.channel,
      },
    });

    log.info({ eventId, messageId: result.messageId, dryRun: result.dryRun }, 'Материал опубликован');

    return { ok: true, publication, ...(result.warning ? { message: result.warning } : {}) };
  }

  /** Медиа события с временными ссылками для Telegram. */
  private async collectMedia(eventId: string): Promise<{ items: PublishMedia[]; ids: string[] }> {
    const rows = await this.db.many(
      `SELECT m.id, m.type, m.storage_key, m.caption
         FROM event_sources es
         JOIN media m ON m.source_post_id = es.source_post_id
        WHERE es.event_id = $1
          AND m.storage_key IS NOT NULL
          AND m.type IN ('PHOTO','VIDEO')
        ORDER BY es.is_primary DESC, m.position
        LIMIT 10`,
      [eventId],
    );

    const items: PublishMedia[] = [];
    const ids: string[] = [];

    for (const row of rows) {
      // Ссылка должна прожить дольше, чем занимает доставка в Telegram.
      const url = await this.storage.signedUrl(String(row.storage_key), 3600);
      items.push({
        url,
        type: String(row.type) as 'PHOTO' | 'VIDEO',
        caption: row.caption ? String(row.caption) : null,
      });
      ids.push(String(row.id));
    }

    return { items, ids };
  }

  private async deny(
    request: PublishRequest,
    code: NonNullable<PublishOutcome['code']>,
    message: string,
  ): Promise<PublishOutcome> {
    await this.audit.log({
      userId: request.user.id,
      action: AUDIT_ACTIONS.PUBLISH_BLOCKED,
      entityType: 'event',
      entityId: request.eventId,
      ipAddress: request.ipAddress,
      userAgent: request.userAgent,
      details: { code, message },
    });
    log.info({ eventId: request.eventId, code }, 'Публикация отклонена');
    return { ok: false, code, message };
  }
}
