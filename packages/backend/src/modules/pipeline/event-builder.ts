import { PIPELINE_STAGE, type SourcePost } from '@nnm/shared';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db/pool.js';
import { childLogger } from '../../lib/logger.js';
import { extractEntities, firstSentence, geocodeLocation, normalizeForAnalysis, truncate } from '../../lib/text.js';
import { JOB_TYPES, JobQueue } from '../../queue/queue.js';
import { CategoriesRepository } from '../../repositories/categories.js';
import { EventsRepository } from '../../repositories/events.js';
import { OpsRepository } from '../../repositories/ops.js';
import { PostsRepository } from '../../repositories/posts.js';
import type { AiProcessor } from '../ai/processor.js';
import { loadAiSettings } from '../ai/ai-settings.js';
import {
  compareForDedup,
  normalizeEntity,
  type DedupCandidate,
  type DedupVerdict,
} from '../dedup/engine.js';
import type { EmbeddingRepository } from '../dedup/repository.js';
import { resolveCategorySlug } from './category-slug.js';

const log = childLogger({ module: 'event-builder' });

export interface BuildOutcome {
  postId: string;
  eventId: string | null;
  action: 'attached' | 'created' | 'needs-review' | 'skipped';
  verdict?: DedupVerdict;
  reason?: string;
}

/**
 * Построение событий из публикаций (ТЗ §3, §4).
 *
 * Главное решение здесь — объединять публикации или считать их разными
 * событиями. Оно принимается консервативно: лишнее разделение исправляется
 * модератором одним действием, а лишнее объединение склеивает два разных
 * происшествия в одну новость и обнаруживается далеко не всегда.
 *
 * При пограничной уверенности создаётся отдельное событие, помеченное
 * NEEDS_REVIEW, и в карточке показывается связанное событие-кандидат —
 * так требует ТЗ §4.
 */
export class EventBuilder {
  private readonly posts: PostsRepository;
  private readonly events: EventsRepository;
  private readonly categories: CategoriesRepository;
  private readonly ops: OpsRepository;
  private readonly queue: JobQueue;

  constructor(
    private readonly db: Database,
    private readonly ai: AiProcessor,
    private readonly embeddings: EmbeddingRepository,
    private readonly config: AppConfig,
  ) {
    this.posts = new PostsRepository(db);
    this.events = new EventsRepository(db);
    this.categories = new CategoriesRepository(db);
    this.ops = new OpsRepository(db);
    this.queue = new JobQueue(db);
  }

  /** Обработать одну публикацию: классифицировать и определить событие. */
  async processPost(postId: string): Promise<BuildOutcome> {
    const started = Date.now();
    const post = await this.posts.findById(postId);
    if (!post) return { postId, eventId: null, action: 'skipped', reason: 'Публикация не найдена' };

    await this.posts.setStatus(postId, 'PROCESSING');

    const source = await this.db.one('SELECT title FROM sources WHERE id = $1', [post.sourceId]);
    const categories = await this.categories.list();

    // --- классификация ---------------------------------------------------
    const normalized = post.normalizedText ?? normalizeForAnalysis(post.rawText);

    // На бесплатных тарифах считаются запросы в сутки, и классификация —
    // половина всех обращений. Настройка позволяет отдать её правилам,
    // сохранив модель там, где правила бессильны, — в переписывании текста.
    const aiSettings = await loadAiSettings(this.db);
    this.ai.setModelForClassification(aiSettings.useModelForClassification);

    const { classification } = await this.ai.classifyPost({
      text: post.rawText,
      sourceTitle: String(source.title),
      postedAt: post.postedAt,
      categories: categories.map((c) => ({ slug: c.slug, title: c.title })),
    });

    const entities = classification.entities.length > 0
      ? classification.entities
      : extractEntities(post.rawText);

    // Категория обязана существовать в справочнике: на неё ссылается
    // внешний ключ source_posts.category_slug. Модель называет категорию
    // словом и иногда придумывает своё («происшествие», «incidents»), а
    // справочник мог быть отредактирован в настройках уже после того, как
    // список ушёл в модель. Незнакомое значение поэтому не пишется в базу:
    // раньше это роняло разбор КАЖДОЙ такой публикации с нарушением ключа,
    // и материал терялся вместо того, чтобы дойти до модератора.
    const categorySlug = resolveCategorySlug(classification.category, categories);

    await this.posts.setClassification(postId, {
      categorySlug,
      importance: classification.importance,
      entities,
      normalizedText: normalized,
    });

    // Реклама, опросы и поздравления не порождают событий, но остаются
    // в базе: они видны в ленте публикаций и учитываются в статистике.
    if (!classification.isNews) {
      await this.posts.setStatus(postId, 'PROCESSED');
      await this.ops.recordHistory({
        entityType: 'source_post',
        entityId: postId,
        stage: PIPELINE_STAGE.CLASSIFICATION,
        status: 'SKIPPED',
        message: 'Публикация не является новостью',
        durationMs: Date.now() - started,
      });
      return { postId, eventId: null, action: 'skipped', reason: 'Не является новостью' };
    }

    // --- эмбеддинг и поиск кандидатов ------------------------------------
    const embedding = await this.embeddings.store(postId, normalized || post.rawText);
    const location = classification.location ?? null;
    const geo = geocodeLocation(location ?? entities.join(' '));

    const self: DedupCandidate = {
      post,
      embedding,
      entities,
      categorySlug,
      latitude: geo?.latitude ?? null,
      longitude: geo?.longitude ?? null,
      mediaChecksums: await this.mediaChecksums(postId),
    };

    const verdict = await this.findBestMatch(self);

    // --- решение ---------------------------------------------------------
    let outcome: BuildOutcome;

    if (verdict && verdict.decision === 'merge' && verdict.eventId) {
      await this.events.attachPost({
        eventId: verdict.eventId,
        sourcePostId: postId,
        sourceId: post.sourceId,
        isIndependent: !verdict.verdict.isReprint,
        similarity: verdict.verdict.score,
        matchSignals: { ...verdict.verdict.signals, explanation: verdict.verdict.explanation },
        attachedBy: 'SYSTEM',
      });
      await this.events.recalculateConfirmation(verdict.eventId);
      outcome = { postId, eventId: verdict.eventId, action: 'attached', verdict: verdict.verdict };
    } else {
      const event = await this.events.create({
        title: truncate(classification.headline || firstSentence(post.rawText), 190),
        summary: truncate(normalized, 600),
        categorySlug,
        importance: classification.importance,
        occurredAt: post.postedAt,
        firstReportedAt: post.postedAt,
        lastReportedAt: post.postedAt,
        locationText: location,
        latitude: geo?.latitude ?? null,
        longitude: geo?.longitude ?? null,
        confidence: classification.confidence,
      });

      await this.events.attachPost({
        eventId: event.id,
        sourcePostId: postId,
        sourceId: post.sourceId,
        isPrimary: true,
        isIndependent: true,
        similarity: null,
        matchSignals: {},
        attachedBy: 'SYSTEM',
      });
      await this.events.recalculateConfirmation(event.id);

      if (verdict && verdict.decision === 'review' && verdict.eventId) {
        // Пограничный случай: событие создаётся отдельным, но помечается
        // для проверки — модератор увидит кандидата на объединение.
        await this.events.setStatus(event.id, 'NEEDS_REVIEW');
        await this.ops.recordHistory({
          entityType: 'event',
          entityId: event.id,
          stage: PIPELINE_STAGE.DEDUPLICATION,
          status: 'NEEDS_REVIEW',
          message:
            `Возможный дубль события ${verdict.eventId} ` +
            `(оценка ${verdict.verdict.score}). ${verdict.verdict.explanation}`,
        });
        outcome = { postId, eventId: event.id, action: 'needs-review', verdict: verdict.verdict };
      } else {
        outcome = { postId, eventId: event.id, action: 'created', verdict: verdict?.verdict };
      }
    }

    await this.posts.setStatus(postId, 'PROCESSED');

    await this.ops.recordHistory({
      entityType: 'source_post',
      entityId: postId,
      stage: PIPELINE_STAGE.DEDUPLICATION,
      status: outcome.action.toUpperCase(),
      message: verdict
        ? `Событие ${outcome.eventId}: ${verdict.verdict.explanation}`
        : `Создано новое событие ${outcome.eventId}`,
      durationMs: Date.now() - started,
    });

    // Черновик генерируется отдельной задачей: объединение публикаций
    // может продолжиться, и переписывать текст на каждую из них не нужно.
    if (outcome.eventId) {
      await this.queue.enqueue({
        type: JOB_TYPES.GENERATE_DRAFT,
        stage: PIPELINE_STAGE.AI_DRAFT,
        payload: { eventId: outcome.eventId },
        dedupeKey: `draft:${outcome.eventId}`,
        // Небольшая задержка даёт другим источникам «догнать» событие,
        // чтобы черновик строился сразу по нескольким публикациям.
        delaySeconds: 90,
      });
    }

    log.info(
      { postId, action: outcome.action, eventId: outcome.eventId, score: outcome.verdict?.score },
      'Публикация обработана',
    );

    return outcome;
  }

  /** Найти событие, к которому публикация подходит лучше всего. */
  private async findBestMatch(self: DedupCandidate): Promise<
    { eventId: string | null; decision: DedupVerdict['decision']; verdict: DedupVerdict } | null
  > {
    const options = {
      timeWindowHours: this.config.DEDUP_TIME_WINDOW_HOURS,
      mergeThreshold: this.config.DEDUP_MERGE_THRESHOLD,
      reviewThreshold: this.config.DEDUP_REVIEW_THRESHOLD,
    };

    const similar = await this.embeddings.findSimilar({
      postId: self.post.id,
      embedding: self.embedding as Float32Array,
      postedAt: self.post.postedAt,
      windowHours: options.timeWindowHours,
      limit: 40,
    });

    if (similar.length === 0) return null;

    const candidateIds = similar.map((item) => item.postId);
    const rows = await this.db.many(
      `SELECT p.*, e.latitude AS event_lat, e.longitude AS event_lon
         FROM source_posts p
         LEFT JOIN events e ON e.id = p.event_id
        WHERE p.id = ANY($1::uuid[])
          AND p.event_id IS NOT NULL`,
      [candidateIds],
    );

    if (rows.length === 0) return null;

    const embeddingMap = await this.embeddings.getMany(rows.map((row) => String(row.id)));
    const checksumMap = await this.checksumsForPosts(rows.map((row) => String(row.id)));

    // Вес редкости сущностей считается по самому окну кандидатов: так
    // мера настраивается сама и не требует поддерживать список «частых»
    // слов вручную. Город упоминается почти везде и веса почти не имеет,
    // название улицы встречается редко и весит много.
    const entityIdf = buildEntityIdf([
      self.entities,
      ...rows.map((row) => (Array.isArray(row.entities) ? row.entities.map(String) : [])),
    ]);

    let best: { eventId: string; verdict: DedupVerdict } | null = null;

    for (const row of rows) {
      const candidate: DedupCandidate = {
        post: {
          id: String(row.id),
          sourceId: String(row.source_id),
          postedAt: String(row.posted_at),
          normalizedText: row.normalized_text ? String(row.normalized_text) : null,
          rawText: String(row.raw_text),
        },
        embedding: embeddingMap.get(String(row.id)) ?? null,
        entities: Array.isArray(row.entities) ? row.entities.map(String) : [],
        categorySlug: row.category_slug ? String(row.category_slug) : null,
        latitude: row.event_lat === null ? null : Number(row.event_lat),
        longitude: row.event_lon === null ? null : Number(row.event_lon),
        mediaChecksums: checksumMap.get(String(row.id)) ?? [],
      };

      // Публикация того же источника почти всегда является отдельной
      // новостью или уточнением, а не независимым подтверждением.
      const verdict = compareForDedup(self, candidate, { ...options, entityIdf });

      if (!best || verdict.score > best.verdict.score) {
        best = { eventId: String(row.event_id), verdict };
      }
    }

    if (!best) return null;
    return { eventId: best.eventId, decision: best.verdict.decision, verdict: best.verdict };
  }

  private async mediaChecksums(postId: string): Promise<string[]> {
    const rows = await this.db.many(
      'SELECT checksum FROM media WHERE source_post_id = $1 AND checksum IS NOT NULL',
      [postId],
    );
    return rows.map((row) => String(row.checksum));
  }

  private async checksumsForPosts(postIds: string[]): Promise<Map<string, string[]>> {
    if (postIds.length === 0) return new Map();
    const rows = await this.db.many(
      `SELECT source_post_id, checksum FROM media
        WHERE source_post_id = ANY($1::uuid[]) AND checksum IS NOT NULL`,
      [postIds],
    );
    const map = new Map<string, string[]>();
    for (const row of rows) {
      const key = String(row.source_post_id);
      map.set(key, [...(map.get(key) ?? []), String(row.checksum)]);
    }
    return map;
  }
}

/**
 * Обратная частота сущностей по набору публикаций.
 *
 * Чем в большем числе публикаций встречается сущность, тем меньше она
 * говорит о том, что речь об одном событии.
 */
function buildEntityIdf(sets: string[][]): Map<string, number> {
  const documentFrequency = new Map<string, number>();

  for (const entities of sets) {
    // Ключи должны совпадать с теми, по которым сущности сравниваются,
    // иначе вес редкости не найдётся и признак потеряет поправку.
    for (const entity of new Set(entities.map(normalizeEntity).filter(Boolean))) {
      documentFrequency.set(entity, (documentFrequency.get(entity) ?? 0) + 1);
    }
  }

  const total = sets.length;
  const idf = new Map<string, number>();
  for (const [entity, frequency] of documentFrequency) {
    idf.set(entity, Math.log(1 + total / (1 + frequency)));
  }
  return idf;
}

