import type { Source, SourceType } from '@nnm/shared';
import type { AppConfig } from '../../config/env.js';
import type { CursorStore } from './telegram.js';
import { TelegramBotAdapter, TelegramPublicPreviewAdapter } from './telegram.js';
import { VkSourceAdapter } from './vk.js';
import type { SourceAdapter } from './types.js';

/**
 * Реестр адаптеров.
 *
 * Выбор адаптера вынесен сюда, чтобы остальной код работал с источником,
 * не зная платформы: добавление новой площадки сводится к реализации
 * SourceAdapter и одной строке здесь.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  constructor(config: AppConfig, cursors?: CursorStore) {
    if (config.TELEGRAM_INGEST_MODE === 'bot') {
      this.adapters.set('TELEGRAM', new TelegramBotAdapter(config, cursors));
    } else if (config.TELEGRAM_INGEST_MODE === 'mtproto') {
      // Режим mtproto требует пользовательского клиента и отдельной
      // библиотеки; он объявлен в конфигурации, но здесь не реализован —
      // см. «Известные ограничения» в docs/LIMITATIONS.md.
      this.adapters.set('TELEGRAM', new TelegramPublicPreviewAdapter());
    } else if (config.TELEGRAM_INGEST_MODE === 'public-preview') {
      this.adapters.set('TELEGRAM', new TelegramPublicPreviewAdapter());
    }

    this.adapters.set('VK', new VkSourceAdapter(config));
  }

  /** Заменить адаптер — используется в тестах и для ручной диагностики. */
  register(type: string, adapter: SourceAdapter): void {
    this.adapters.set(type, adapter);
  }

  get(type: SourceType): SourceAdapter | null {
    return this.adapters.get(type) ?? null;
  }

  forSource(source: Source): SourceAdapter | null {
    return this.get(source.type);
  }

  /** Состояние адаптеров для раздела диагностики. */
  status(): Array<{ type: string; mode: string; configured: boolean; reason: string | null }> {
    return [...this.adapters.entries()].map(([type, adapter]) => ({
      type,
      mode: adapter.mode,
      configured: adapter.isConfigured(),
      reason: adapter.unavailableReason(),
    }));
  }
}
