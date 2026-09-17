import type { Source } from '@nnm/shared';
import { PIPELINE_STAGE } from '@nnm/shared';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db/pool.js';
import { childLogger } from '../../lib/logger.js';
import { normalizeForAnalysis } from '../../lib/text.js';
import { JOB_TYPES, JobQueue } from '../../queue/queue.js';
import { OpsRepository } from '../../repositories/ops.js';
import { PostsRepository } from '../../repositories/posts.js';
import { SourcesRepository } from '../../repositories/sources.js';
import { ProfanityGuard } from '../profanity/index.js';
import type { AdapterRegistry } from './registry.js';
import { SourceFetchError } from './types.js';

const log = childLogger({ module: 'ingestion' });

export interface SyncResult {
  sourceId: string;
  fetched: number;
  saved: number;
  skipped: number;
  warning?: string;
  error?: string;
}

/**
 * Сбор публикаций (ТЗ §1, §2).
 *
 * Ключевые свойства:
 *  - сбой одного источника не влияет на другие (ТЗ §24): исключение
 *    перехватывается здесь, фиксируется в источнике и в журнале ошибок,
 *    а обработка остальных источников продолжается;
 *  - сохранение идемпотентно: повторный опрос не создаёт дублей;
 *  - исходный текст сохраняется без изменений, включая нецензурную лексику,
 *    — это первичные данные для аудита. Для генерации черновика позже
 *    используется очищенная копия (ТЗ §7).
 */
export class IngestionService {
  private readonly sources: SourcesRepository;
  private readonly posts: PostsRepository;
  private readonly ops: OpsRepository;
  private readonly queue: JobQueue;
  private readonly profanity = new ProfanityGuard();

  constructor(
    private readonly db: Database,
    private readonly registry: AdapterRegistry,
    private readonly config: AppConfig,
  ) {
    this.sources = new SourcesRepository(db);
    this.posts = new PostsRepository(db);
    this.ops = new OpsRepository(db);
    this.queue = new JobQueue(db);
  }

  /** Опросить один источник. Исключения наружу не выбрасываются. */
  async syncSource(source: Source): Promise<SyncResult> {
    const started = Date.now();
    const adapter = this.registry.forSource(source);

    if (!adapter) {
      const message = `Нет адаптера для источника типа ${source.type}`;
      await this.fail(source, message, false);
      return { sourceId: source.id, fetched: 0, saved: 0, skipped: 0, error: message };
    }

    if (!adapter.isConfigured()) {
      const message = adapter.unavailableReason() ?? 'Адаптер не настроен';
      await this.fail(source, message, false);
      return { sourceId: source.id, fetched: 0, saved: 0, skipped: 0, error: message };
    }

    await this.sources.markSyncStarted(source.id);

    try {
      const backfillHours = Number(source.config.backfillHours ?? 48);
      const sinceExternalId = await this.sources.getLastExternalId(source.id);

      const result = await adapter.fetch(source, {
        sinceExternalId,
        // При первом импорте не тянем всю историю канала.
        notBefore: sinceExternalId
          ? null
          : new Date(Date.now() - backfillHours * 3600_000),
        limit: Number(source.config.fetchLimit ?? 50),
      });

      let saved = 0;
      let skipped = 0;
      let lastPostAt: string | null = null;

      for (const fetched of result.posts) {
        // Публикации без содержательного текста не создают событий, но
        // сохраняются: к ним могут относиться медиа и последующие правки.
        const minLength = Number(source.config.minTextLength ?? 0);
        if (source.config.skipForwards && fetched.isForward) {
          skipped += 1;
          continue;
        }

        const normalized = normalizeForAnalysis(fetched.text);
        const profanityMatches = this.profanity.detectProfanity(fetched.text);

        const post = await this.posts.insertIfNew(
          {
            sourceId: source.id,
            externalId: fetched.externalId,
            url: fetched.url,
            postedAt: fetched.postedAt.toISOString(),
            // Исходный текст сохраняется как есть — он первичен.
            rawText: fetched.text,
            normalizedText: normalized,
            isForward: fetched.isForward,
            forwardFrom: fetched.forwardFrom,
            rawHasProfanity: profanityMatches.length > 0,
            metadata: { ...fetched.metadata, adapterMode: adapter.mode },
          },
          fetched.media.map((item, index) => ({
            type: item.type,
            originalUrl: item.url,
            mimeType: item.mimeType ?? null,
            caption: item.caption ?? null,
            width: item.width ?? null,
            height: item.height ?? null,
            durationSeconds: item.durationSeconds ?? null,
            sizeBytes: item.sizeBytes ?? null,
            position: index,
          })),
        );

        if (!post) {
          // Уже сохранена ранее — это нормальный путь, а не ошибка.
          skipped += 1;
          continue;
        }

        saved += 1;
        lastPostAt = post.postedAt;

        if (normalized.length >= minLength) {
          await this.queue.enqueue({
            type: JOB_TYPES.PROCESS_POST,
            stage: PIPELINE_STAGE.NORMALIZATION,
            payload: { postId: post.id },
            dedupeKey: `process:${post.id}`,
          });
        }

        // Медиа скачиваются отдельными задачами, чтобы большое видео
        // не задерживало обработку самой новости.
        const mediaRows = await this.db.many(
          `SELECT id FROM media WHERE source_post_id = $1 AND download_status = 'NEW'`,
          [post.id],
        );
        for (const media of mediaRows) {
          await this.queue.enqueue({
            type: JOB_TYPES.DOWNLOAD_MEDIA,
            stage: PIPELINE_STAGE.MEDIA_PROCESSING,
            payload: { mediaId: String(media.id) },
            dedupeKey: `media:${String(media.id)}`,
            priority: 200,
          });
        }
      }

      await this.sources.markSyncSuccess(source.id, {
        fetched: saved,
        lastExternalId: result.lastExternalId,
        lastPostAt,
      });

      await this.ops.recordHistory({
        entityType: 'source',
        entityId: source.id,
        stage: PIPELINE_STAGE.INGESTION,
        status: 'OK',
        message: `Получено ${result.posts.length}, сохранено ${saved}`,
        durationMs: Date.now() - started,
      });

      if (result.warning) {
        await this.ops.recordError({
          stage: PIPELINE_STAGE.INGESTION,
          entityType: 'source',
          entityId: source.id,
          sourceId: source.id,
          message: result.warning,
          details: { adapter: adapter.mode },
        });
      }

      log.info(
        { source: source.title, fetched: result.posts.length, saved, skipped },
        'Источник опрошен',
      );

      return {
        sourceId: source.id,
        fetched: result.posts.length,
        saved,
        skipped,
        ...(result.warning ? { warning: result.warning } : {}),
      };
    } catch (error) {
      const retriable = error instanceof SourceFetchError ? error.retriable : true;
      const message = (error as Error).message;
      await this.fail(source, message, retriable);
      return { sourceId: source.id, fetched: 0, saved: 0, skipped: 0, error: message };
    }
  }

  /** Опросить все источники, которым подошло время. */
  async syncDueSources(): Promise<SyncResult[]> {
    const due = await this.sources.findDueForSync();
    const results: SyncResult[] = [];

    // Последовательно, а не параллельно: так проще соблюдать лимиты
    // платформ и не создавать всплеск запросов с одного адреса.
    for (const source of due) {
      results.push(await this.syncSource(source));
    }
    return results;
  }

  private async fail(source: Source, message: string, retriable: boolean): Promise<void> {
    const health = await this.sources.markSyncFailure(source.id, message);
    await this.ops.recordError({
      stage: PIPELINE_STAGE.INGESTION,
      entityType: 'source',
      entityId: source.id,
      sourceId: source.id,
      message,
      details: { retriable, health },
    });
    log.warn({ source: source.title, err: message, health }, 'Сбой опроса источника');
  }
}
