import pg from 'pg';
import type { AppConfig } from '../config/env.js';
import { getConfig } from '../config/env.js';
import { logger } from '../lib/logger.js';

const { Pool, types } = pg;

/**
 * `timestamptz` возвращаем как ISO-строку, а не как JS Date.
 *
 * Это убирает целый класс ошибок: значение больше не зависит от таймзоны
 * процесса, одинаково сериализуется в API и безопасно сравнивается в тестах.
 */
types.setTypeParser(1184, (value: string | null) =>
  value === null ? null : new Date(value).toISOString(),
);
/** `timestamp` без таймзоны — трактуем как UTC. */
types.setTypeParser(1114, (value: string | null) =>
  value === null ? null : new Date(`${value}Z`).toISOString(),
);
/** `numeric` — в число: все numeric-поля в схеме заведомо влезают в double. */
types.setTypeParser(1700, (value: string | null) => (value === null ? null : Number(value)));
/** `int8` — в число (счётчики заведомо меньше 2^53). */
types.setTypeParser(20, (value: string | null) => (value === null ? null : Number(value)));

export type QueryParams = readonly unknown[];

/** Минимальный интерфейс исполнителя запросов: пул или клиент в транзакции. */
export interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: QueryParams,
  ): Promise<pg.QueryResult<T>>;
}

export interface Database extends Queryable {
  /** Вернуть все строки. */
  many<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: QueryParams,
  ): Promise<T[]>;
  /** Вернуть первую строку или null. */
  maybeOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: QueryParams,
  ): Promise<T | null>;
  /** Вернуть ровно одну строку; иначе — ошибка. */
  one<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: QueryParams,
  ): Promise<T>;
  /** Выполнить работу в транзакции с автоматическим COMMIT/ROLLBACK. */
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
  /** Возможности конкретной установки PostgreSQL. */
  capabilities(): Promise<DbCapabilities>;
  close(): Promise<void>;
  readonly pool: pg.Pool;
}

export interface DbCapabilities {
  /**
   * Доступно ли расширение pgvector.
   *
   * Система работает и без него: при отсутствии расширения эмбеддинги
   * хранятся в `real[]`, а поиск похожих идёт по временно́му окну с
   * досчётом косинусного расстояния в приложении. pgvector включает
   * ANN-индекс и нужен на больших объёмах, но не является обязательным.
   */
  hasPgVector: boolean;
  hasPgTrgm: boolean;
  hasUnaccent: boolean;
  serverVersion: string;
}

/** Низкоуровневая функция выполнения запроса: пул или клиент в транзакции. */
type RawQuery = <T extends pg.QueryResultRow>(
  text: string,
  params?: QueryParams,
) => Promise<pg.QueryResult<T>>;

/**
 * Собрать объект Database поверх произвольного исполнителя запросов.
 *
 * Хелперы `one`/`maybeOne`/`many` описаны здесь один раз и одинаково
 * работают и на пуле, и на клиенте внутри транзакции — благодаря этому
 * репозитории пишутся без оглядки на то, выполняются они в транзакции
 * или вне её.
 */
function buildDatabase(
  raw: RawQuery,
  pool: pg.Pool,
  extras: Pick<Database, 'transaction' | 'capabilities' | 'close'>,
): Database {
  return {
    pool,
    query: raw,
    async many<T extends pg.QueryResultRow = pg.QueryResultRow>(
      text: string,
      params?: QueryParams,
    ): Promise<T[]> {
      const result = await raw<T>(text, params);
      return result.rows;
    },
    async maybeOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
      text: string,
      params?: QueryParams,
    ): Promise<T | null> {
      const result = await raw<T>(text, params);
      return result.rows[0] ?? null;
    },
    async one<T extends pg.QueryResultRow = pg.QueryResultRow>(
      text: string,
      params?: QueryParams,
    ): Promise<T> {
      const result = await raw<T>(text, params);
      const row = result.rows[0];
      if (!row) {
        throw new Error('Ожидалась одна строка, получено 0');
      }
      return row;
    },
    ...extras,
  };
}

export function createDatabase(config: AppConfig = getConfig()): Database {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    ssl: config.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
    // Не даём «зависшим» запросам удерживать соединение бесконечно.
    //
    // Эти два параметра передаются в стартовом пакете соединения. Пулеры
    // в режиме транзакций (например, Supabase на порту 6543) такие
    // параметры отклоняют, и подключение не устанавливается вовсе.
    // Поэтому их можно отключить, задав DATABASE_STATEMENT_TIMEOUT_MS=0;
    // для этой системы правильнее использовать session pooler, где они
    // работают и защищают от зависших запросов.
    ...(config.DATABASE_STATEMENT_TIMEOUT_MS > 0
      ? {
          statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
          idle_in_transaction_session_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
        }
      : {}),
    connectionTimeoutMillis: 10_000,
  });

  pool.on('error', (error) => {
    // Ошибка простаивающего клиента не должна ронять процесс.
    logger.error({ err: error }, 'Ошибка простаивающего соединения с БД');
  });

  let capabilitiesCache: DbCapabilities | null = null;

  const capabilities = async (): Promise<DbCapabilities> => {
    if (capabilitiesCache) return capabilitiesCache;
    const result = await pool.query<{
      has_vector: boolean;
      has_trgm: boolean;
      has_unaccent: boolean;
      version: string;
    }>(
      `SELECT
         EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')   AS has_vector,
         EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm')  AS has_trgm,
         EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'unaccent') AS has_unaccent,
         current_setting('server_version') AS version`,
    );
    const row = result.rows[0];
    if (!row) throw new Error('Не удалось определить возможности PostgreSQL');

    capabilitiesCache = {
      hasPgVector: row.has_vector,
      hasPgTrgm: row.has_trgm,
      hasUnaccent: row.has_unaccent,
      serverVersion: row.version,
    };
    return capabilitiesCache;
  };

  const transaction = async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const txRaw: RawQuery = (text, params) =>
        client.query(text, params as unknown[] | undefined) as never;
      const tx = buildDatabase(txRaw, pool, { transaction, capabilities, close });
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        logger.error({ err: rollbackError }, 'Не удалось выполнить ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  };

  const close = async (): Promise<void> => {
    await pool.end();
  };

  const poolRaw: RawQuery = (text, params) =>
    pool.query(text, params as unknown[] | undefined) as never;

  return buildDatabase(poolRaw, pool, { transaction, capabilities, close });
}

let singleton: Database | null = null;

export function getDatabase(): Database {
  singleton ??= createDatabase();
  return singleton;
}

export async function closeDatabase(): Promise<void> {
  if (singleton) {
    await singleton.close();
    singleton = null;
  }
}
