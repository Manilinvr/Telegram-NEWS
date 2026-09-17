/**
 * Точка входа API.
 *
 * Процесс API намеренно отделён от воркера: обслуживание интерфейса не
 * должно конкурировать за ресурсы с транскрипцией видео и обращениями
 * к модели, а перезапуск одного не влияет на другой.
 */
import { getConfig } from './config/env.js';
import { closeDatabase, getDatabase } from './db/pool.js';
import { buildServer } from './http/server.js';
import { liveBus } from './http/live.js';
import { logger } from './lib/logger.js';
import { migrateUp } from './db/migrator.js';

const config = getConfig();
const db = getDatabase();

try {
  // Миграции применяются при старте: схема и код всегда согласованы,
  // и нельзя запустить новый код на старой схеме.
  const applied = await migrateUp(db);
  if (applied.length > 0) {
    logger.info({ applied }, `Применено миграций при старте: ${applied.length}`);
  }

  const app = await buildServer(config, db);

  await app.listen({ host: config.API_HOST, port: config.API_PORT });

  logger.info(
    {
      url: `http://${config.API_HOST}:${config.API_PORT}`,
      env: config.NODE_ENV,
      aiProvider: config.AI_PROVIDER,
      storage: config.STORAGE_DRIVER,
      dryRun: config.TELEGRAM_PUBLISH_DRY_RUN,
    },
    'API запущен',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Получен сигнал завершения');
    try {
      liveBus.close();
      await app.close();
      await closeDatabase();
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Ошибка при остановке API');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
} catch (error) {
  logger.fatal({ err: error }, 'Не удалось запустить API');
  await closeDatabase();
  process.exit(1);
}
