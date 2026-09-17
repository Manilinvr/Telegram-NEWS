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
import { Worker } from './workers/runtime.js';
import { bootstrapOwner } from './modules/auth/bootstrap.js';

const config = getConfig();
const db = getDatabase();

try {
  // Миграции применяются при старте: схема и код всегда согласованы,
  // и нельзя запустить новый код на старой схеме. Когда схемой управляет
  // внешний механизм (интеграция Supabase с GitHub), шаг отключается —
  // иначе раннер попытается создать уже существующие таблицы.
  if (config.MIGRATE_ON_STARTUP) {
    const applied = await migrateUp(db);
    if (applied.length > 0) {
      logger.info({ applied }, `Применено миграций при старте: ${applied.length}`);
    }
  } else {
    logger.info('Миграции при старте отключены (MIGRATE_ON_STARTUP=false)');
  }

  // Создание владельца при первом запуске — для хостингов, где неудобно
  // выполнять разовые команды. Пароль не генерируется: показать его
  // из веб-процесса некуда, поэтому он обязан прийти из окружения.
  if (config.BOOTSTRAP_ON_STARTUP) {
    const result = await bootstrapOwner(db, config, { allowGenerate: false });
    logger.info({ created: result.created }, result.message);
  }

  const app = await buildServer(config, db);

  // Воркер в одном процессе с API — режим для личной установки.
  // start() не завершается, пока воркер работает, поэтому его нельзя
  // ожидать здесь: иначе прослушивание порта так и не началось бы.
  let worker: Worker | null = null;
  if (config.RUN_WORKER_IN_API) {
    worker = new Worker(db, config);
    void worker.start().catch((error) => {
      logger.error({ err: error }, 'Воркер в процессе API аварийно завершился');
    });
    logger.info({ workerId: worker.workerId }, 'Воркер запущен внутри процесса API');
  }

  await app.listen({ host: config.API_HOST, port: config.API_PORT });

  logger.info(
    {
      url: `http://${config.API_HOST}:${config.API_PORT}`,
      env: config.NODE_ENV,
      aiProvider: config.AI_PROVIDER,
      storage: config.STORAGE_DRIVER,
      dryRun: config.TELEGRAM_PUBLISH_DRY_RUN,
      workerInProcess: config.RUN_WORKER_IN_API,
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
      if (worker) await worker.stop();
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
