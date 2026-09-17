import { PIPELINE_STAGE } from '@nnm/shared';
import type { AppConfig } from '../config/env.js';
import type { Database } from '../db/pool.js';
import { childLogger } from '../lib/logger.js';
import { JOB_TYPES, JobQueue } from '../queue/queue.js';
import { CategoriesRepository } from '../repositories/categories.js';
import { OpsRepository } from '../repositories/ops.js';
import { SessionsRepository } from '../repositories/sessions.js';
import { AiProcessor } from '../modules/ai/processor.js';
import { EmbeddingRepository } from '../modules/dedup/repository.js';
import { createEmbeddingProvider } from '../modules/dedup/embeddings.js';
import { AdapterRegistry } from '../modules/ingestion/registry.js';
import { IngestionService } from '../modules/ingestion/service.js';
import { MediaProcessor } from '../modules/media/processor.js';
import { DraftService } from '../modules/pipeline/draft-service.js';
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

    /** Периодическое обслуживание. */
    [JOB_TYPES.CLEANUP]: async () => {
      const sessionsRepo = new SessionsRepository(db);
      const [sessions, jobs, stale] = await Promise.all([
        sessionsRepo.cleanup(),
        queue.purgeCompleted(7),
        queue.recoverStale(15),
      ]);
      log.info({ sessions, jobs, stale }, 'Обслуживание выполнено');
      return { sessions, jobs, stale };
    },
  };

  return { handlers, ingestion, queue };
}
