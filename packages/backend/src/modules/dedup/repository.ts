import type { Database } from '../../db/pool.js';
import { childLogger } from '../../lib/logger.js';
import { textHash, type EmbeddingProvider } from './embeddings.js';

const log = childLogger({ module: 'dedup-repository' });

/**
 * Хранение и поиск эмбеддингов.
 *
 * Вектор всегда сохраняется в real[] — это работает на любой установке
 * PostgreSQL. Если доступно расширение pgvector, вектор дополнительно
 * пишется в колонку типа vector и поиск идёт через ANN-индекс. Без
 * расширения кандидаты отбираются по временно́му окну, а косинус
 * досчитывается в приложении: выборка при этом измеряется сотнями записей,
 * поэтому разница в скорости незаметна, а требование к окружению ниже.
 */
export class EmbeddingRepository {
  private vectorReady: boolean | null = null;

  constructor(
    private readonly db: Database,
    private readonly provider: EmbeddingProvider,
  ) {}

  /** Есть ли pgvector и подготовлен ли индекс. */
  private async ensureVectorIndex(): Promise<boolean> {
    if (this.vectorReady !== null) return this.vectorReady;

    const capabilities = await this.db.capabilities();
    if (!capabilities.hasPgVector) {
      this.vectorReady = false;
      log.info('pgvector недоступен — поиск похожих публикаций работает через real[] и досчёт в приложении');
      return false;
    }

    try {
      // Размерность у колонки vector фиксируется только здесь: в миграции
      // она неизвестна, потому что зависит от выбранного провайдера.
      await this.db.query(
        `ALTER TABLE post_embeddings
           ALTER COLUMN embedding_vec TYPE vector(${this.provider.dimensions})`,
      );
      await this.db.query(
        `CREATE INDEX IF NOT EXISTS post_embeddings_vec_idx
           ON post_embeddings USING hnsw (embedding_vec vector_cosine_ops)`,
      );
      this.vectorReady = true;
      log.info({ dimensions: this.provider.dimensions }, 'pgvector: ANN-индекс готов');
    } catch (error) {
      // Несовпадение размерности с уже сохранёнными векторами не должно
      // ронять систему: продолжаем работать в режиме досчёта.
      log.warn({ err: error }, 'Не удалось подготовить ANN-индекс, работаем без него');
      this.vectorReady = false;
    }

    return this.vectorReady;
  }

  /** Посчитать и сохранить эмбеддинг публикации. */
  async store(postId: string, text: string): Promise<Float32Array> {
    const hash = textHash(text);

    const existing = await this.db.maybeOne(
      'SELECT embedding, text_hash FROM post_embeddings WHERE source_post_id = $1',
      [postId],
    );
    if (existing && existing.text_hash === hash) {
      return Float32Array.from(existing.embedding as number[]);
    }

    const vector = await this.provider.embed(text);
    const asArray = Array.from(vector);
    const useVector = await this.ensureVectorIndex();

    await this.db.query(
      `INSERT INTO post_embeddings (source_post_id, provider, dimensions, embedding, text_hash${useVector ? ', embedding_vec' : ''})
       VALUES ($1, $2, $3, $4, $5${useVector ? ', $6::vector' : ''})
       ON CONFLICT (source_post_id) DO UPDATE SET
         provider = EXCLUDED.provider,
         dimensions = EXCLUDED.dimensions,
         embedding = EXCLUDED.embedding,
         text_hash = EXCLUDED.text_hash${useVector ? ',\n         embedding_vec = EXCLUDED.embedding_vec' : ''}`,
      useVector
        ? [postId, this.provider.name, this.provider.dimensions, asArray, hash, toVectorLiteral(asArray)]
        : [postId, this.provider.name, this.provider.dimensions, asArray, hash],
    );

    return vector;
  }

  async get(postId: string): Promise<Float32Array | null> {
    const row = await this.db.maybeOne(
      'SELECT embedding FROM post_embeddings WHERE source_post_id = $1',
      [postId],
    );
    return row ? Float32Array.from(row.embedding as number[]) : null;
  }

  async getMany(postIds: string[]): Promise<Map<string, Float32Array>> {
    if (postIds.length === 0) return new Map();
    const rows = await this.db.many(
      'SELECT source_post_id, embedding FROM post_embeddings WHERE source_post_id = ANY($1::uuid[])',
      [postIds],
    );
    return new Map(
      rows.map((row) => [String(row.source_post_id), Float32Array.from(row.embedding as number[])]),
    );
  }

  /**
   * Наиболее близкие публикации в заданном временно́м окне.
   *
   * При наличии pgvector сортировка выполняется СУБД по ANN-индексу;
   * без него возвращаются кандидаты окна, а ранжирование делает движок
   * дедупликации.
   */
  async findSimilar(input: {
    postId: string;
    embedding: Float32Array;
    postedAt: string;
    windowHours: number;
    limit: number;
  }): Promise<Array<{ postId: string; similarity: number | null }>> {
    const useVector = await this.ensureVectorIndex();

    if (useVector) {
      const rows = await this.db.many(
        `SELECT e.source_post_id,
                1 - (e.embedding_vec <=> $2::vector) AS similarity
           FROM post_embeddings e
           JOIN source_posts p ON p.id = e.source_post_id
          WHERE e.source_post_id <> $1
            AND e.embedding_vec IS NOT NULL
            AND p.posted_at BETWEEN $3::timestamptz - make_interval(hours => $4::int)
                                AND $3::timestamptz + make_interval(hours => $4::int)
          ORDER BY e.embedding_vec <=> $2::vector
          LIMIT $5`,
        [
          input.postId,
          toVectorLiteral(Array.from(input.embedding)),
          input.postedAt,
          input.windowHours,
          input.limit,
        ],
      );
      return rows.map((row) => ({
        postId: String(row.source_post_id),
        similarity: row.similarity === null ? null : Number(row.similarity),
      }));
    }

    const rows = await this.db.many(
      `SELECT e.source_post_id
         FROM post_embeddings e
         JOIN source_posts p ON p.id = e.source_post_id
        WHERE e.source_post_id <> $1
          AND p.posted_at BETWEEN $2::timestamptz - make_interval(hours => $3::int)
                              AND $2::timestamptz + make_interval(hours => $3::int)
        ORDER BY abs(extract(epoch FROM (p.posted_at - $2::timestamptz)))
        LIMIT $4`,
      [input.postId, input.postedAt, input.windowHours, input.limit],
    );
    return rows.map((row) => ({ postId: String(row.source_post_id), similarity: null }));
  }
}

/** Формат литерала pgvector: `[0.1,0.2,…]`. */
function toVectorLiteral(values: number[]): string {
  return `[${values.map((v) => (Number.isFinite(v) ? v.toFixed(6) : '0')).join(',')}]`;
}
