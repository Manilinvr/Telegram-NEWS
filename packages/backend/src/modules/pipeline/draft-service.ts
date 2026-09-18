import { PIPELINE_STAGE, type AiDraft, type Importance } from '@nnm/shared';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db/pool.js';
import { childLogger } from '../../lib/logger.js';
import { geocodeLocation } from '../../lib/text.js';
import { CategoriesRepository } from '../../repositories/categories.js';
import { DraftsRepository } from '../../repositories/drafts.js';
import { EventsRepository } from '../../repositories/events.js';
import { ModerationRepository } from '../../repositories/moderation.js';
import { OpsRepository } from '../../repositories/ops.js';
import { JOB_TYPES, JobQueue } from '../../queue/queue.js';
import { loadPublishingSettings } from '../publishing/settings.js';
import type { AiProcessor } from '../ai/processor.js';
import { loadEditorialStyle } from '../ai/style.js';
import { ProfanityGuard } from '../profanity/index.js';
import { TranscriptionService } from '../transcription/service.js';
import { resolveCategorySlug } from './category-slug.js';
import { buildTelegramPost } from './telegram-format.js';

const log = childLogger({ module: 'draft-service' });

/**
 * Формирование редакционного черновика события (ТЗ §8, §11, §13).
 *
 * Черновик всегда проходит проверку лексики и всегда попадает в очередь
 * модерации: путь «сразу в Telegram» отсутствует в коде, а не выключен
 * настройкой (ТЗ §13 — автопубликация в MVP выключена).
 */
export class DraftService {
  private readonly events: EventsRepository;
  private readonly drafts: DraftsRepository;
  private readonly moderation: ModerationRepository;
  private readonly categories: CategoriesRepository;
  private readonly ops: OpsRepository;
  private readonly queue: JobQueue;
  private readonly profanity: ProfanityGuard;
  private readonly transcription: TranscriptionService;

  constructor(
    private readonly db: Database,
    private readonly ai: AiProcessor,
    private readonly config: AppConfig,
    transcription: TranscriptionService,
    profanity?: ProfanityGuard,
  ) {
    this.events = new EventsRepository(db);
    this.drafts = new DraftsRepository(db);
    this.moderation = new ModerationRepository(db);
    this.categories = new CategoriesRepository(db);
    this.ops = new OpsRepository(db);
    this.queue = new JobQueue(db);
    this.transcription = transcription;
    this.profanity = profanity ?? new ProfanityGuard();
  }

  /** Сгенерировать черновик для события и поставить его на модерацию. */
  async generateForEvent(eventId: string): Promise<AiDraft | null> {
    const started = Date.now();
    const event = await this.events.findById(eventId);
    if (!event) return null;

    const sources = await this.events.sourcesFor(eventId);
    if (sources.length === 0) {
      log.warn({ eventId }, 'У события нет связанных публикаций — черновик не создаётся');
      return null;
    }

    const postRows = await this.db.many(
      `SELECT p.id, p.raw_text, p.posted_at, p.url, s.title AS source_title
         FROM event_sources es
         JOIN source_posts p ON p.id = es.source_post_id
         JOIN sources s ON s.id = es.source_id
        WHERE es.event_id = $1
        ORDER BY p.posted_at`,
      [eventId],
    );

    const transcripts = await this.transcription.forEvent(eventId);
    const categories = await this.categories.list();

    // Стиль читается здесь и применяется в двух местах сразу: к промпту
    // (тон и длина) и к сборке поста (значки и подпись). Так настройка
    // остаётся одной, а не расползается по вызывающему коду.
    const style = await loadEditorialStyle(this.db);
    this.ai.setStyle(style);

    const outcome = await this.ai.analyzeEvent({
      posts: postRows.map((row, index) => ({
        index,
        sourceTitle: String(row.source_title),
        postedAt: String(row.posted_at),
        text: String(row.raw_text),
        url: row.url ? String(row.url) : null,
      })),
      transcripts: transcripts
        .filter((t) => t.status === 'COMPLETED' && t.fullText)
        .map((t, index) => ({ mediaLabel: `Видео ${index + 1}`, text: t.fullText as string })),
      categories: categories.map((c) => ({ slug: c.slug, title: c.title })),
      existingLocation: event.locationText,
    });

    const { analysis } = outcome;

    // Категория приводится к справочнику по той же причине, что и при
    // классификации: на неё ссылается внешний ключ и в черновике, и в
    // событии, а модель называет её свободным словом.
    const categorySlug = resolveCategorySlug(analysis.category, categories);

    // Собираем итоговый текст поста ровно в том виде, в каком он уйдёт
    // в канал: именно этот текст показывается в preview и проверяется
    // перед отправкой.
    const hasMedia = await this.eventHasMedia(eventId);
    const telegramText = buildTelegramPost({
      title: analysis.title,
      body: analysis.summary,
      location: analysis.location,
      eventTime: analysis.eventTime ?? event.occurredAt,
      witnessQuotes: analysis.witnessQuotes.map((quote) => quote.text),
      sources: sources.map((source) => ({ title: source.sourceTitle, url: source.originalUrl })),
      hasMedia,
      useEmoji: style.useEmoji,
      signature: style.signature,
    });

    // Итоговый текст проверяется ещё раз: сборка добавила заголовок,
    // цитаты и названия источников, которых не было в проверенных полях.
    const finalReport = this.profanity.validateEditorialText({
      title: analysis.title,
      body: analysis.summary,
      telegramPreview: telegramText,
      quotes: analysis.witnessQuotes.map((q) => q.text),
      keyPhrases: analysis.uncertainties,
    });

    const draft = await this.drafts.create({
      eventId,
      title: analysis.title,
      body: analysis.summary,
      telegramText,
      categorySlug,
      importance: analysis.importance as Importance,
      locationText: analysis.location,
      witnessQuotes: analysis.witnessQuotes.map((q) => q.text),
      uncertainties: analysis.uncertainties,
      sourceClaims: analysis.sourceClaims.map((claim) => {
        const source = sources[claim.sourceIndex];
        return {
          claim: claim.claim,
          sourceTitle: source?.sourceTitle ?? 'Источник',
          sourceUrl: source?.originalUrl ?? null,
          attribution: claim.attribution,
        };
      }),
      confidence: analysis.confidence,
      createdBy: outcome.producedBy === 'AI' ? 'AI' : 'HUMAN',
      model: outcome.model,
      rawResponse: outcome.raw,
      profanityReport: finalReport,
    });

    // Обновляем само событие данными разбора.
    const geo = geocodeLocation(analysis.location);
    await this.events.update(eventId, {
      title: analysis.title,
      summary: analysis.summary,
      categorySlug,
      importance: analysis.importance as Importance,
      occurredAt: parseEventTime(analysis.eventTime) ?? event.occurredAt,
      locationText: analysis.location,
      latitude: geo?.latitude ?? event.latitude,
      longitude: geo?.longitude ?? event.longitude,
      confidence: analysis.confidence,
      status: finalReport.allowed ? 'PROCESSED' : 'NEEDS_REVIEW',
    });

    await this.events.replaceFacts(
      eventId,
      analysis.facts.map((fact) => ({
        text: fact.text,
        isConfirmed: fact.confirmed,
        isAssumption: fact.assumption,
        sourcePostId:
          fact.sourceIndex !== null ? (postRows[fact.sourceIndex]?.id as string) ?? null : null,
        attribution: fact.attribution,
        confidence: analysis.confidence,
      })),
    );

    // Материал с найденной лексикой уходит в очередь заблокированным:
    // опубликовать его невозможно, пока текст не будет исправлен.
    await this.moderation.enqueue({
      eventId,
      draftId: draft.id,
      priority: analysis.importance as Importance,
      status: finalReport.allowed ? 'PENDING' : 'BLOCKED',
      blockedReason: finalReport.allowed ? null : finalReport.reason,
    });

    // Автопубликация ставится отдельной задачей с паузой, а не
    // выполняется здесь же: событие ещё дополняется публикациями других
    // каналов, и за это время черновик может быть пересобран. Условия
    // проверяются при выполнении задачи, а не сейчас.
    if (finalReport.allowed) {
      await this.scheduleAutoPublish(eventId);
    }

    await this.ops.recordHistory({
      entityType: 'event',
      entityId: eventId,
      stage: PIPELINE_STAGE.AI_DRAFT,
      status: finalReport.allowed ? 'OK' : 'BLOCKED',
      message:
        `Черновик v${draft.version} (${outcome.producedBy}). ` +
        (outcome.warnings.length > 0 ? outcome.warnings.join(' ') : finalReport.reason),
      durationMs: Date.now() - started,
    });

    await this.ops.recordHistory({
      entityType: 'event',
      entityId: eventId,
      stage: PIPELINE_STAGE.PROFANITY_VALIDATION,
      status: finalReport.allowed ? 'PASSED' : 'BLOCKED',
      message: finalReport.reason,
    });

    log.info(
      {
        eventId,
        version: draft.version,
        producedBy: outcome.producedBy,
        profanityPassed: finalReport.allowed,
      },
      'Черновик создан',
    );

    return draft;
  }

  /**
   * Сохранить правку модератора как новую версию.
   *
   * Отредактированный текст проверяется заново (ТЗ §13.9): человек мог
   * вписать что угодно, и доверять предыдущей проверке нельзя.
   */
  async saveManualEdit(input: {
    eventId: string;
    userId: string;
    title: string;
    body: string;
    telegramText: string;
    categorySlug?: string | null;
    importance?: Importance;
    locationText?: string | null;
    witnessQuotes?: string[];
  }): Promise<{ draft: AiDraft; allowed: boolean }> {
    const current = await this.drafts.findCurrent(input.eventId);

    const report = this.profanity.validateEditorialText({
      title: input.title,
      body: input.body,
      telegramPreview: input.telegramText,
      quotes: input.witnessQuotes ?? [],
    });

    const draft = await this.drafts.create({
      eventId: input.eventId,
      title: input.title,
      body: input.body,
      telegramText: input.telegramText,
      categorySlug: input.categorySlug ?? current?.categorySlug ?? null,
      importance: input.importance ?? current?.importance ?? 'MEDIUM',
      locationText: input.locationText ?? current?.locationText ?? null,
      witnessQuotes: input.witnessQuotes ?? current?.witnessQuotes ?? [],
      uncertainties: current?.uncertainties ?? [],
      sourceClaims: current?.sourceClaims ?? [],
      confidence: current?.confidence ?? 0.5,
      createdBy: 'HUMAN',
      createdByUser: input.userId,
      model: null,
      profanityReport: report,
    });

    await this.moderation.enqueue({
      eventId: input.eventId,
      draftId: draft.id,
      priority: draft.importance,
      status: report.allowed ? 'PENDING' : 'BLOCKED',
      blockedReason: report.allowed ? null : report.reason,
    });

    await this.ops.recordHistory({
      entityType: 'event',
      entityId: input.eventId,
      stage: PIPELINE_STAGE.PROFANITY_VALIDATION,
      status: report.allowed ? 'PASSED' : 'BLOCKED',
      message: `Ручная правка: ${report.reason}`,
    });

    return { draft, allowed: report.allowed };
  }

  /**
   * Поставить задачу автоматической публикации, если она включена.
   *
   * Ключ дедупликации привязан к событию: пересборка черновика не
   * плодит задачи, а откладывает отправку на новый срок только в том
   * случае, если прежняя ещё не выполнена.
   */
  private async scheduleAutoPublish(eventId: string): Promise<void> {
    const settings = await loadPublishingSettings(this.db);
    if (!settings.autoPublish) return;

    await this.queue.enqueue({
      type: JOB_TYPES.AUTO_PUBLISH,
      stage: PIPELINE_STAGE.TELEGRAM_PUBLISH,
      payload: { eventId },
      dedupeKey: `autopublish:${eventId}`,
      delaySeconds: settings.delayMinutes * 60,
      priority: 500,
    });
  }

  private async eventHasMedia(eventId: string): Promise<boolean> {
    const row = await this.db.one(
      `SELECT EXISTS (
         SELECT 1 FROM event_sources es
           JOIN media m ON m.source_post_id = es.source_post_id
          WHERE es.event_id = $1 AND m.storage_key IS NOT NULL
       ) AS has_media`,
      [eventId],
    );
    return row.has_media === true;
  }
}

/** Время события от модели может прийти в свободной форме. */
function parseEventTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
