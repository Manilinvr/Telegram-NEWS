import { PIPELINE_STAGE } from '@nnm/shared';
import type { AppConfig } from '../config/env.js';
import type { Database } from '../db/pool.js';
import { childLogger } from '../lib/logger.js';
import { JOB_TYPES, JobQueue } from '../queue/queue.js';
import { CategoriesRepository } from '../repositories/categories.js';
import { OpsRepository } from '../repositories/ops.js';
import { ModerationRepository } from '../repositories/moderation.js';
import { SessionsRepository } from '../repositories/sessions.js';
import { AiProcessor } from '../modules/ai/processor.js';
import { EmbeddingRepository } from '../modules/dedup/repository.js';
import { createEmbeddingProvider } from '../modules/dedup/embeddings.js';
import { AdapterRegistry } from '../modules/ingestion/registry.js';
import { IngestionService } from '../modules/ingestion/service.js';
import { MediaProcessor } from '../modules/media/processor.js';
import { DraftService, MODEL_UNAVAILABLE_ERROR } from '../modules/pipeline/draft-service.js';
import { PublishingService } from '../modules/publishing/service.js';
import { loadPublishingSettings } from '../modules/publishing/settings.js';
import { EventBuilder } from '../modules/pipeline/event-builder.js';
import { createStorageDriver } from '../modules/storage/driver.js';
import { TranscriptionService } from '../modules/transcription/service.js';
import { SourcesRepository } from '../repositories/sources.js';

const log = childLogger({ module: 'worker-handlers' });

export type JobHandler = (payload: Record<string, unknown>) => Promise<unknown>;

/**
 * Сборка обработчиков задач.
 *
 * Все зависимости создаются один раз: воркер — долгоживущий процесс, и
 * пересоздавать клиентов на каждую задачу не нужно.
 */
export function createHandlers(db: Database, config: AppConfig): {
  handlers: Record<string, JobHandler>;
  ingestion: IngestionService;
  queue: JobQueue;
} {
  const queue = new JobQueue(db);
  const ops = new OpsRepository(db);
  const storage = createStorageDriver(config);
  const categoriesRepo = new CategoriesRepository(db);
  const sources = new SourcesRepository(db);

  // Курсор Bot API хранится в настройках и переживает перезапуск воркера.
  const cursors = {
    async get(key: string) {
      return ops.getSetting<number | null>(key, null);
    },
    async set(key: string, value: number) {
      await ops.setSetting(key, value);
    },
  };

  const registry = new AdapterRegistry(config, cursors);
  const ingestion = new IngestionService(db, registry, config);
  const embeddings = new EmbeddingRepository(db, createEmbeddingProvider(config));
  const transcription = new TranscriptionService(db, storage, config);

  const telegramAdapter = registry.get('TELEGRAM');
  const media = new MediaProcessor(db, storage, config, async (item) => {
    // Telegram отдаёт файлы по file_id, а не по прямой ссылке, и она
    // быстро истекает — запрашиваем свежую непосредственно перед загрузкой.
    const fileId = (item as { metadata?: { fileId?: string } }).metadata?.fileId;
    if (!fileId || !telegramAdapter) return null;
    const resolver = telegramAdapter as unknown as {
      resolveFileUrl?: (id: string) => Promise<string | null>;
    };
    return resolver.resolveFileUrl ? resolver.resolveFileUrl(fileId) : null;
  });

  /** Список категорий кэшируется: он меняется редко, а нужен постоянно. */
  let categoriesCache: Awaited<ReturnType<CategoriesRepository['list']>> | null = null;
  let categoriesLoadedAt = 0;
  const getCategories = async () => {
    if (!categoriesCache || Date.now() - categoriesLoadedAt > 60_000) {
      categoriesCache = await categoriesRepo.list();
      categoriesLoadedAt = Date.now();
    }
    return categoriesCache;
  };

  const makeAi = async () =>
    new AiProcessor(
      config,
      (await getCategories()).map((c) => ({
        slug: c.slug,
        title: c.title,
        keywords: c.keywords,
        defaultImportance: c.defaultImportance,
      })),
    );

  /**
   * Вернуть к модели материалы, разобранные правилами.
   *
   * Когда модель недоступна — исчерпан дневной лимит, кончился баланс —
   * новости не теряются, но и не переписываются: черновик собирается
   * правилами и остаётся таким навсегда, хотя лимит обнуляется уже через
   * несколько часов. Здесь такие материалы возвращаются в работу.
   *
   * Отбирается только то, что ещё ждёт модератора: опубликованное,
   * отклонённое и взятое в работу не трогается, а ручная правка не
   * трогается тем более — черновики человека отличаются от собранных
   * правилами пометкой created_by.
   *
   * Отдельной проверки связи не делается: она сама расходовала бы лимит
   * (обслуживание идёт каждые 15 минут — 96 запросов в сутки, больше
   * бесплатной квоты целиком). Вместо этого используется отсрочка: если
   * недоступность записана меньше получаса назад, попытка откладывается.
   */
  async function requeueRulesDrafts(): Promise<number> {
    const ai = new AiProcessor(config, []);
    if (!ai.isAiAvailable()) return 0;

    const lastFailure = await ops.lastErrorAt(MODEL_UNAVAILABLE_ERROR);
    if (lastFailure && Date.now() - lastFailure.getTime() < 30 * 60_000) return 0;

    const rows = await db.many(
      `SELECT d.event_id
         FROM ai_drafts d
         JOIN moderation_queue m ON m.event_id = d.event_id
        WHERE d.is_current
          AND d.created_by = 'RULES'
          AND m.status = 'PENDING'
          AND d.created_at > now() - interval '48 hours'
        ORDER BY d.created_at DESC
        LIMIT 5`,
    );

    for (const row of rows) {
      await queue.enqueue({
        type: JOB_TYPES.GENERATE_DRAFT,
        stage: PIPELINE_STAGE.AI_DRAFT,
        payload: { eventId: String(row.event_id) },
        dedupeKey: `draft:${String(row.event_id)}`,
        priority: 700,
      });
    }

    if (rows.length > 0) {
      log.info({ count: rows.length }, 'Черновики, собранные правилами, возвращены модели');
    }
    return rows.length;
  }

  /**
   * Поставить на автопубликацию материалы, уже ждущие модератора.
   *
   * Задача автопубликации ставится при создании черновика, поэтому
   * включённый позже переключатель не действовал ни на что: очередь
   * молчала, и со стороны это выглядело как «автопубликация не
   * работает». Здесь очередь подхватывается целиком.
   *
   * Условия отправки проверяются не тут, а в PublishingService при
   * выполнении задачи: ключ дедупликации не даёт поставить вторую
   * задачу на то же событие.
   */
  async function scheduleAutoPublishForPending(): Promise<number> {
    const settings = await loadPublishingSettings(db);
    if (!settings.autoPublish) return 0;

    const rows = await db.many(
      `SELECT m.event_id
         FROM moderation_queue m
         JOIN ai_drafts d ON d.event_id = m.event_id AND d.is_current
         JOIN events e ON e.id = m.event_id
        WHERE m.status = 'PENDING'
          AND e.status = 'PROCESSED'
          AND d.confidence >= $1
        ORDER BY m.created_at
        LIMIT 20`,
      [settings.minConfidence],
    );

    for (const row of rows) {
      await queue.enqueue({
        type: JOB_TYPES.AUTO_PUBLISH,
        stage: PIPELINE_STAGE.TELEGRAM_PUBLISH,
        payload: { eventId: String(row.event_id) },
        dedupeKey: `autopublish:${String(row.event_id)}`,
        delaySeconds: settings.delayMinutes * 60,
        priority: 500,
      });
    }

    if (rows.length > 0) {
      log.info({ count: rows.length }, 'Материалы из очереди поставлены на автопубликацию');
    }
    return rows.length;
  }

  const handlers: Record<string, JobHandler> = {
    /** Опрос одного источника. */
    [JOB_TYPES.SYNC_SOURCE]: async (payload) => {
      const sourceId = String(payload.sourceId ?? '');
      const source = await sources.findById(sourceId);
      if (!source) return { skipped: true, reason: 'Источник не найден' };
      return ingestion.syncSource(source);
    },

    /** Классификация публикации и определение события. */
    [JOB_TYPES.PROCESS_POST]: async (payload) => {
      const ai = await makeAi();
      const builder = new EventBuilder(db, ai, embeddings, config);
      return builder.processPost(String(payload.postId ?? ''));
    },

    /** Скачивание и обработка вложения. */
    [JOB_TYPES.DOWNLOAD_MEDIA]: async (payload) => {
      const mediaId = String(payload.mediaId ?? '');
      const result = await media.process(mediaId);

      // Транскрипция ставится только для того, где действительно есть речь.
      if (result.ok && (await media.needsTranscription(mediaId))) {
        await queue.enqueue({
          type: JOB_TYPES.TRANSCRIBE_MEDIA,
          stage: PIPELINE_STAGE.TRANSCRIPTION,
          payload: { mediaId },
          dedupeKey: `transcribe:${mediaId}`,
          priority: 300,
        });
      }
      return result;
    },

    /** Распознавание речи. */
    [JOB_TYPES.TRANSCRIBE_MEDIA]: async (payload) => {
      const transcript = await transcription.transcribeMedia(String(payload.mediaId ?? ''));

      // Появление транскрипции — повод перегенерировать черновик:
      // в нём могут появиться цитаты очевидцев.
      if (transcript?.status === 'COMPLETED') {
        const row = await db.maybeOne(
          `SELECT es.event_id FROM media m
             JOIN event_sources es ON es.source_post_id = m.source_post_id
            WHERE m.id = $1 LIMIT 1`,
          [String(payload.mediaId ?? '')],
        );
        if (row?.event_id) {
          await queue.enqueue({
            type: JOB_TYPES.GENERATE_DRAFT,
            stage: PIPELINE_STAGE.AI_DRAFT,
            payload: { eventId: String(row.event_id) },
            dedupeKey: `draft:${String(row.event_id)}`,
            delaySeconds: 10,
          });
        }
      }
      return { status: transcript?.status ?? 'UNKNOWN' };
    },

    /** Генерация редакционного черновика. */
    [JOB_TYPES.GENERATE_DRAFT]: async (payload) => {
      const eventId = String(payload.eventId ?? '');
      const ai = await makeAi();
      const service = new DraftService(db, ai, config, transcription);
      const draft = await service.generateForEvent(eventId);
      return { draftId: draft?.id ?? null, version: draft?.version ?? null };
    },

    /**
     * Автоматическая публикация события.
     *
     * Задача только напоминает о событии: все условия — включена ли
     * автопубликация, сохранил ли права включивший её человек, не взял ли
     * материал в работу модератор, достаточно ли уверенности — проверяются
     * в PublishingService при выполнении. Пропуск не считается ошибкой:
     * материал остаётся в очереди и ждёт человека.
     */
    [JOB_TYPES.AUTO_PUBLISH]: async (payload) => {
      const eventId = String(payload.eventId ?? '');
      const publishing = new PublishingService(db, config, storage);
      const result = await publishing.publishAutomatically({ eventId });

      if (result.skipped) {
        log.info({ eventId, reason: result.skipped }, 'Автопубликация пропущена');
        return { published: false, skipped: result.skipped };
      }
      if (!result.ok) {
        log.warn({ eventId, code: result.code }, 'Автопубликация не удалась');
        return { published: false, code: result.code, message: result.message };
      }

      log.info({ eventId, publicationId: result.publication?.id }, 'Материал опубликован автоматически');
      return { published: true, publicationId: result.publication?.id ?? null };
    },

    /** Периодическое обслуживание. */
    [JOB_TYPES.CLEANUP]: async () => {
      const sessionsRepo = new SessionsRepository(db);
      const moderationRepo = new ModerationRepository(db);
      const [sessions, jobs, stale, expired, redrafted, autoQueued] = await Promise.all([
        sessionsRepo.cleanup(),
        queue.purgeCompleted(7),
        queue.recoverStale(15),
        // Вчерашние нерассмотренные материалы уходят в «Отклонённые»,
        // чтобы очередь начинала день пустой.
        moderationRepo.expireStale(),
        requeueRulesDrafts(),
        scheduleAutoPublishForPending(),
      ]);
      log.info(
        { sessions, jobs, stale, expired, redrafted, autoQueued },
        'Обслуживание выполнено',
      );
      return { sessions, jobs, stale, expired, redrafted, autoQueued };
    },
  };

  return { handlers, ingestion, queue };
}
