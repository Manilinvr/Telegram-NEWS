/**
 * Заполнение справочников начальными данными.
 *
 * Скрипт идемпотентен: повторный запуск обновляет категории, но не
 * дублирует их и не трогает пользовательские изменения источников.
 */
import { getConfig } from '../config/env.js';
import { createDatabase } from './pool.js';
import { CategoriesRepository } from '../repositories/categories.js';
import { OpsRepository } from '../repositories/ops.js';
import { logger } from '../lib/logger.js';

const config = getConfig();
const db = createDatabase(config);

try {
  const categories = new CategoriesRepository(db);
  const ops = new OpsRepository(db);

  const count = await categories.seedDefaults();
  logger.info({ count }, 'Категории записаны');

  // Настройки по умолчанию. Обратите внимание: у фильтра лексики есть
  // политика по грубой брани, но нет и не может быть выключателя мата.
  const defaults: Array<[string, unknown, boolean]> = [
    ['profanity', { blockOnWarn: true, extraBlockWords: [], extraAllowWords: [] }, true],
    [
      'dedup',
      {
        timeWindowHours: config.DEDUP_TIME_WINDOW_HOURS,
        mergeThreshold: config.DEDUP_MERGE_THRESHOLD,
        reviewThreshold: config.DEDUP_REVIEW_THRESHOLD,
      },
      true,
    ],
    ['moderation', { requireManualApproval: true, autoPublish: false }, true],
    ['feed', { defaultPeriod: '24h', defaultSort: 'newest', pageSize: 50 }, false],
  ];

  for (const [key, value, critical] of defaults) {
    const existing = await ops.getSetting(key, null);
    if (existing === null) {
      await ops.setSetting(key, value, { isCritical: critical });
      logger.info({ key }, 'Настройка создана');
    }
  }

  await db.close();
  process.exit(0);
} catch (error) {
  logger.error({ err: error }, 'Не удалось выполнить заполнение');
  await db.close();
  process.exit(1);
}
