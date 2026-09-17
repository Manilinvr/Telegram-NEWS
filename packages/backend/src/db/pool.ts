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

function wrap(executor: Queryable, root: () => Database): Database {
  const db: Database = {
    pool: (executor as { pool?: pg.Pool }).pool ?? (executor as unknown as pg.Pool),
    query: (text, params) => executor.query(text, params),
    async many(text, params) {
      const result = await executor.query(text, params);
      return result.rows;
    },
    async maybeOne(text, params) {
      const result = await executor.query(text, params);
      return result.rows[0] ?? null;
    },
    async one(text, params) {
      const result = await executor.query(text, params);
      const row = result.rows[0];
      if (!row) {
        throw new Error('Ожидалась одна строка, получено 0');
      }
      return row;
    },
    transaction: (fn) => root().transaction(fn),
    capabilities: () => root().capabilities(),
    close: () => root().close(),
  };
  return db;
}

export function createDatabase(config: AppConfig = getConfig()): Database {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    ssl: config.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
    // Не даём «зависшим» запросам удерживать соединение бесконечно.
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on('error', (error) => {
    // Ошибка простаивающего клиента не должна ронять процесс.
    logger.error({ err: error }, 'Ошибка простаивающего соединения с БД');
  });

  let capabilitiesCache: DbCapabilities | null = null;

  const database: Database = {
    pool,
    query: (text, params) => pool.query(text, params),
    async many(text, params) {
      const result = await pool.query(text, params);
      return result.rows;
    },
    async maybeOne(text, params) {
      const result = await pool.query(text, params);
      return result.rows[0] ?? null;
    },
    async one(text, params) {
      const result = await pool.query(text, params);
      const row = result.rows[0];
      if (!row) {
        throw new Error('Ожидалась одна строка, получено 0');
      }
      return row;
    },
    async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client, () => database));
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
    },
    async capabilities(): Promise<DbCapabilities> {
      if (capabilitiesCache) return capabilitiesCache;
      const row = await database.one<{
        has_vector: boolean;
        has_trgm: boolean;
        has_unaccent: boolean;
        version: string;
      }>(
        `SELECT
           EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')    AS has_vector,
           EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm')   AS has_trgm,
           EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'unaccent')  AS has_unaccent,
           current_setting('server_version') AS version`,
      );
      capabilitiesCache = {
        hasPgVector: row.has_vector,
        hasPgTrgm: row.has_trgm,
        hasUnaccent: row.has_unaccent,
        serverVersion: row.version,
      };
      return capabilitiesCache;
    },
    async close() {
      await pool.end();
    },
  };

  return database;
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
