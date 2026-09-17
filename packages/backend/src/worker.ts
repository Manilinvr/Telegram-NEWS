/**
 * Точка входа воркера.
 *
 * Воркер запускается отдельным процессом от API: тяжёлая обработка
 * (скачивание медиа, транскрипция, обращения к модели) не должна
 * конкурировать с обслуживанием запросов интерфейса, а перезапуск одного
 * не затрагивает другой.
 */
import { getConfig } from './config/env.js';
import { getDatabase, closeDatabase } from './db/pool.js';
import { logger } from './lib/logger.js';
import { Worker } from './workers/runtime.js';

const config = getConfig();
const db = getDatabase();
const worker = new Worker(db, config);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Получен сигнал завершения');

  try {
    await worker.stop();
    await closeDatabase();
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Ошибка при остановке воркера');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  // Необработанное отклонение не должно ронять воркер: задача будет
  // повторена, а причина останется в логах.
  logger.error({ err: reason }, 'Необработанное отклонение промиса');
});

try {
  await worker.start();
} catch (error) {
  logger.fatal({ err: error }, 'Воркер аварийно завершился');
  await closeDatabase();
  process.exit(1);
}
