import {
  DEFAULT_PUBLISHING_SETTINGS,
  PUBLISHING_SETTING_KEY,
  publishingSettingsSchema,
  type PublishingSettings,
} from '@nnm/shared';
import type { Database } from '../../db/pool.js';
import { childLogger } from '../../lib/logger.js';
import { OpsRepository } from '../../repositories/ops.js';

const log = childLogger({ module: 'publishing-settings' });

/**
 * Прочитать настройки публикации.
 *
 * Сомнительная запись трактуется в сторону ручной публикации: сбой
 * разбора настройки не должен оказаться способом включить отправку в
 * канал без человека.
 */
export async function loadPublishingSettings(db: Database): Promise<PublishingSettings> {
  const raw = await new OpsRepository(db).getSetting(PUBLISHING_SETTING_KEY, null);
  if (raw === null || raw === undefined) return DEFAULT_PUBLISHING_SETTINGS;

  const parsed = publishingSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn(
      { issues: parsed.error.issues.map((issue) => issue.message) },
      'Настройка публикации некорректна — автопубликация считается выключенной',
    );
    return DEFAULT_PUBLISHING_SETTINGS;
  }
  return parsed.data;
}
