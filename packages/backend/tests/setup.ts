/**
 * Общая подготовка тестового окружения.
 *
 * Конфигурация задаётся явно, а не читается из `.env`: тесты обязаны быть
 * воспроизводимыми и не зависеть от локальных настроек разработчика.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.DATABASE_URL ??= 'postgres://nnm:nnm@127.0.0.1:5432/nnm_test';
process.env.SESSION_SECRET ??= 'test-session-secret-not-used-in-production-000000';
process.env.CSRF_SECRET ??= 'test-csrf-secret-not-used-in-production-0000000000';
process.env.AI_PROVIDER ??= 'mock';
process.env.EMBEDDING_PROVIDER ??= 'local';
process.env.TRANSCRIPTION_PROVIDER ??= 'mock';
process.env.TELEGRAM_INGEST_MODE ??= 'none';
process.env.TELEGRAM_PUBLISH_DRY_RUN ??= 'true';
process.env.STORAGE_DRIVER ??= 'local';
process.env.STORAGE_LOCAL_PATH ??= './tmp/test-media';
