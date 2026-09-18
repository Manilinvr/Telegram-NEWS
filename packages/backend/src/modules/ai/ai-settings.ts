import {
  AI_SETTING_KEY,
  aiSettingsSchema,
  DEFAULT_AI_SETTINGS,
  type AiSettings,
} from '@nnm/shared';
import type { Database } from '../../db/pool.js';
import { childLogger } from '../../lib/logger.js';
import { OpsRepository } from '../../repositories/ops.js';

const log = childLogger({ module: 'ai-settings' });

/**
 * Прочитать настройки расхода запросов к модели.
 *
 * Некорректная запись не выключает модель молча: берутся значения по
 * умолчанию, а расхождение попадает в журнал.
 */
export async function loadAiSettings(db: Database): Promise<AiSettings> {
  const raw = await new OpsRepository(db).getSetting(AI_SETTING_KEY, null);
  if (raw === null || raw === undefined) return DEFAULT_AI_SETTINGS;

  const parsed = aiSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn(
      { issues: parsed.error.issues.map((issue) => issue.message) },
      'Настройка расхода запросов некорректна — взяты значения по умолчанию',
    );
    return DEFAULT_AI_SETTINGS;
  }
  return parsed.data;
}
