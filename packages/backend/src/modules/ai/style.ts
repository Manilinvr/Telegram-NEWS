import {
  DEFAULT_EDITORIAL_STYLE,
  EDITORIAL_SETTING_KEY,
  editorialStyleSchema,
  type EditorialStyle,
} from '@nnm/shared';
import type { Database } from '../../db/pool.js';
import { childLogger } from '../../lib/logger.js';
import { OpsRepository } from '../../repositories/ops.js';

const log = childLogger({ module: 'editorial-style' });

/**
 * Прочитать редакционный стиль из настроек.
 *
 * Читается при каждой подготовке черновика, а не кэшируется: настройку
 * меняют, глядя на вышедший пост, и следующий материал должен выйти уже
 * по-новому. Запрос копеечный — одна строка по первичному ключу.
 *
 * Повреждённое или устаревшее значение не останавливает работу: берутся
 * значения по умолчанию, а расхождение попадает в журнал. Черновик важнее
 * оформления, и терять материал из-за настройки тона нельзя.
 */
export async function loadEditorialStyle(db: Database): Promise<EditorialStyle> {
  const raw = await new OpsRepository(db).getSetting(EDITORIAL_SETTING_KEY, null);
  if (raw === null || raw === undefined) return DEFAULT_EDITORIAL_STYLE;

  const parsed = editorialStyleSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn(
      { issues: parsed.error.issues.map((issue) => issue.message) },
      'Настройка редакционного стиля некорректна — взяты значения по умолчанию',
    );
    return DEFAULT_EDITORIAL_STYLE;
  }
  return parsed.data;
}
