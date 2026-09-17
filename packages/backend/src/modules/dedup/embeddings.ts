import { createHash } from 'node:crypto';
import type { AppConfig } from '../../config/env.js';
import { childLogger } from '../../lib/logger.js';
import { significantWords, stem } from '../../lib/text.js';

const log = childLogger({ module: 'embeddings' });

/**
 * Векторные представления текстов для семантической дедупликации (ТЗ §4).
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Локальный провайдер: детерминированные векторы без обращения к сети.
 *
 * Это не нейросетевые эмбеддинги, и «смысловой» близости они не дают. Зато
 * они очень хорошо решают задачу, которая здесь и стоит на практике:
 * распознать, что два канала пишут об одном происшествии, обычно
 * пересказывая одни и те же факты и имена. Признаки — основы слов и
 * символьные триграммы — устойчивы к переформулировкам и опечаткам.
 *
 * Важные свойства: работает офлайн (содержимое новостей никуда не уходит),
 * бесплатен, детерминирован и потому воспроизводим в тестах. Когда нужна
 * настоящая семантика, подключается внешний провайдер.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local-hashed';

  constructor(readonly dimensions = 512) {}

  async embed(text: string): Promise<Float32Array> {
    return this.embedSync(text);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedSync(text));
  }

  embedSync(text: string): Float32Array {
    const vector = new Float32Array(this.dimensions);
    const words = significantWords(text);

    // Признак 1: основы слов — устойчивы к словоформам.
    for (const word of words) {
      this.add(vector, `w:${stem(word)}`, 1);
    }

    // Признак 2: биграммы основ — учитывают порядок слов, благодаря чему
    // «машина сбила пешехода» и «пешеход сбил машину» различаются.
    for (let i = 0; i < words.length - 1; i += 1) {
      this.add(vector, `b:${stem(words[i] as string)}|${stem(words[i + 1] as string)}`, 0.7);
    }

    // Признак 3: символьные триграммы — дают устойчивость к опечаткам
    // и разному написанию имён собственных.
    const compact = text.toLowerCase().replace(/\s+/g, ' ');
    for (let i = 0; i < compact.length - 2; i += 1) {
      this.add(vector, `t:${compact.slice(i, i + 3)}`, 0.25);
    }

    return normalizeVector(vector);
  }

  /**
   * Хеширование признака в позицию вектора.
   *
   * Знак берётся из отдельного бита хэша: это стандартный приём hashing
   * trick, который не даёт коллизиям систематически завышать сходство.
   */
  private add(vector: Float32Array, feature: string, weight: number): void {
    const digest = createHash('sha1').update(feature).digest();
    const index = digest.readUInt32BE(0) % this.dimensions;
    const sign = (digest[4] as number) & 1 ? 1 : -1;
    vector[index] = (vector[index] as number) + sign * weight;
  }
}

/**
 * Внешний провайдер эмбеддингов (Voyage AI).
 *
 * Включается явно: тексты новостей при этом покидают контур системы,
 * поэтому по умолчанию используется локальный провайдер.
 */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'voyage';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    readonly dimensions: number,
  ) {}

  async embed(text: string): Promise<Float32Array> {
    const [first] = await this.embedBatch([text]);
    return first as Float32Array;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ input: texts, model: this.model, input_type: 'document' }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`Voyage API: HTTP ${response.status} ${await response.text()}`);
    }

    const body = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return body.data.map((item) => normalizeVector(Float32Array.from(item.embedding)));
  }
}

export function createEmbeddingProvider(config: AppConfig): EmbeddingProvider {
  if (config.EMBEDDING_PROVIDER === 'voyage') {
    log.info('Используется внешний провайдер эмбеддингов Voyage');
    return new VoyageEmbeddingProvider(
      config.VOYAGE_API_KEY as string,
      config.VOYAGE_MODEL,
      config.EMBEDDING_DIMENSIONS,
    );
  }
  return new LocalEmbeddingProvider(config.EMBEDDING_DIMENSIONS);
}

/** Привести вектор к единичной длине: тогда косинус — это скалярное произведение. */
export function normalizeVector(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  const result = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    result[i] = (vector[i] as number) / norm;
  }
  return result;
}

/** Косинусная близость нормализованных векторов. */
export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  // Векторы уже нормализованы, но пересчёт защищает от накопленной
  // погрешности и позволяет принимать «сырые» векторы извне.
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Хэш текста — позволяет не пересчитывать эмбеддинг для того же содержимого. */
export function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}
