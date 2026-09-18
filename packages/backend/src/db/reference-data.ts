/**
 * Справочные данные, без которых система не работает.
 *
 * Категории — не пользовательские данные, а часть схемы по смыслу: на
 * `categories.slug` ссылается внешний ключ `source_posts.category_slug`.
 * Пока справочник пуст, разбор КАЖДОЙ публикации падает с нарушением
 * этого ключа, и в журнале копятся одинаковые ошибки.
 *
 * Раньше справочник заполнялся только командой `npm run seed`. На
 * хостинге, где нет доступа к командной строке (бесплатный тариф Render
 * не даёт Shell), выполнить её невозможно — и установка выглядела
 * рабочей, но не обрабатывала ни одной новости.
 *
 * Поэтому справочник дозаполняется при старте. Существующие записи не
 * трогаются: правки, сделанные в настройках, сохраняются.
 */
import {
  AI_SETTING_KEY,
  DEFAULT_AI_SETTINGS,
  DEFAULT_EDITORIAL_STYLE,
  DEFAULT_PUBLISHING_SETTINGS,
  EDITORIAL_SETTING_KEY,
  PUBLISHING_SETTING_KEY,
} from '@nnm/shared';
import type { AppConfig } from '../config/env.js';
import type { Database } from './pool.js';
import { CategoriesRepository } from '../repositories/categories.js';
import { OpsRepository } from '../repositories/ops.js';

export interface ReferenceDataResult {
  categoriesAdded: number;
  settingsAdded: string[];
}

export async function ensureReferenceData(
  db: Database,
  config: AppConfig,
): Promise<ReferenceDataResult> {
  const categoriesAdded = await new CategoriesRepository(db).ensureDefaults();

  const ops = new OpsRepository(db);
  const settingsAdded: string[] = [];

  // Значения по умолчанию совпадают с `npm run seed`. Существующая
  // настройка не перезаписывается — иначе старт процесса откатывал бы
  // всё, что настроено в интерфейсе.
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
    // Автопубликация выключена по умолчанию: включается осознанно, в
    // настройках, с подтверждением паролем.
    [PUBLISHING_SETTING_KEY, DEFAULT_PUBLISHING_SETTINGS, true],
    ['feed', { defaultPeriod: '24h', defaultSort: 'newest', pageSize: 50 }, false],
    // Редакционный стиль: без записи интерфейс показывал бы пустую форму,
    // хотя разбор уже идёт со значениями по умолчанию.
    [EDITORIAL_SETTING_KEY, DEFAULT_EDITORIAL_STYLE, false],
    [AI_SETTING_KEY, DEFAULT_AI_SETTINGS, false],
  ];

  for (const [key, value, critical] of defaults) {
    if ((await ops.getSetting(key, null)) === null) {
      await ops.setSetting(key, value, { isCritical: critical });
      settingsAdded.push(key);
    }
  }

  return { categoriesAdded, settingsAdded };
}
