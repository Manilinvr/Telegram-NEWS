import { createDatabase, type Database } from '../../src/db/pool.js';
import { migrateUp } from '../../src/db/migrator.js';
import { loadConfig } from '../../src/config/env.js';

/**
 * Подключение к тестовой БД.
 *
 * Используется отдельная база (по умолчанию `nnm_test`), миграции
 * применяются один раз за прогон, а между тестами таблицы очищаются.
 * Так тесты работают на настоящей схеме со всеми ограничениями,
 * триггерами и индексами — это как раз то, что нужно проверять.
 */

let cached: Database | null = null;
let migrated = false;

export async function getTestDb(): Promise<Database> {
  if (!cached) {
    cached = createDatabase(loadConfig(process.env));
  }
  if (!migrated) {
    await migrateUp(cached);
    migrated = true;
  }
  return cached;
}

/** Таблицы, очищаемые между тестами. `schema_migrations` не трогаем. */
const TABLES = [
  'publications',
  'moderation_queue',
  'ai_drafts',
  'extracted_facts',
  'transcripts',
  'post_embeddings',
  'event_sources',
  'media',
  'source_posts',
  'events',
  'sources',
  'processing_history',
  'processing_errors',
  'processing_jobs',
  'audit_logs',
  'login_attempts',
  'sessions',
  'users',
  'settings',
];

export async function resetDb(db: Database): Promise<void> {
  // audit_logs защищён триггером от DELETE — на время очистки его
  // отключаем, иначе тестовые данные было бы не убрать.
  await db.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update');
  try {
    await db.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  } finally {
    await db.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_update');
  }
}

export async function closeTestDb(): Promise<void> {
  if (cached) {
    await cached.close();
    cached = null;
    migrated = false;
  }
}
