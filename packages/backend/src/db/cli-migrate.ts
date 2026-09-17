/** CLI миграций: `npm run migrate | migrate:down | migrate:status`. */
import { createDatabase } from './pool.js';
import { getStatus, migrateDown, migrateUp } from './migrator.js';
import { logger } from '../lib/logger.js';

const command = process.argv[2] ?? 'up';
const db = createDatabase();

try {
  switch (command) {
    case 'up': {
      const applied = await migrateUp(db);
      if (applied.length === 0) {
        logger.info('Новых миграций нет — схема актуальна.');
      } else {
        logger.info({ applied }, `Применено миграций: ${applied.length}`);
      }
      break;
    }
    case 'down': {
      const steps = Number(process.argv[3] ?? '1');
      const reverted = await migrateDown(db, steps);
      logger.info({ reverted }, `Откачено миграций: ${reverted.length}`);
      break;
    }
    case 'status': {
      const status = await getStatus(db);
      for (const row of status) {
        const mark = row.applied ? '✓' : '·';
        const warn = row.checksumMatches ? '' : '  ⚠ КОНТРОЛЬНАЯ СУММА НЕ СОВПАДАЕТ';
        process.stdout.write(`${mark} ${row.id}${warn}\n`);
      }
      break;
    }
    default:
      throw new Error(`Неизвестная команда: ${command}. Доступно: up | down | status`);
  }
  await db.close();
  process.exit(0);
} catch (error) {
  logger.error({ err: error }, 'Ошибка миграции');
  await db.close();
  process.exit(1);
}
