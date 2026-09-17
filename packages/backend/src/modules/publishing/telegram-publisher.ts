import { TELEGRAM_MEDIA_GROUP_LIMIT } from '@nnm/shared';
import type { AppConfig } from '../../config/env.js';
import { childLogger } from '../../lib/logger.js';
import { safeUrl } from '../ingestion/http.js';

const log = childLogger({ module: 'telegram-publisher' });

/**
 * TelegramPublisher (ТЗ §18, §31).
 *
 * Отправляет готовый материал в канал. Класс отвечает ТОЛЬКО за доставку:
 * решение о публикации, проверка прав и контроль лексики выполняются
 * уровнем выше и не могут быть обойдены вызовом этого класса напрямую,
 * потому что он не имеет доступа ни к очереди модерации, ни к черновикам.
 */

export interface PublishMedia {
  /**
   * Содержимое файла.
   *
   * Телеграму отдаётся сам файл, а не ссылка на него. Ссылка не подходит
   * принципиально: хранилище приватно, и адрес вида `/api/media/...`
   * относительный — Telegram отвечал на него
   * «invalid file HTTP URL specified: URL host is empty». Публиковать
   * пришлось бы через общедоступный адрес, то есть открыть хранилище
   * наружу. Отправка байтами обходится без этого.
   */
  data: Buffer;
  filename: string;
  mimeType: string | null;
  type: 'PHOTO' | 'VIDEO';
  caption?: string | null;
}

export interface PublishResult {
  ok: boolean;
  messageId: string | null;
  error?: string;
  /** Отправка не выполнялась — сухой прогон. */
  dryRun: boolean;
  /** Предупреждение, не являющееся ошибкой (например, бот не настроен). */
  warning?: string;
}

export class TelegramPublisher {
  constructor(private readonly config: AppConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.TELEGRAM_PUBLISH_BOT_TOKEN && this.config.TELEGRAM_PUBLISH_CHANNEL);
  }

  unavailableReason(): string | null {
    if (!this.config.TELEGRAM_PUBLISH_BOT_TOKEN) {
      return 'Не задан TELEGRAM_PUBLISH_BOT_TOKEN.';
    }
    if (!this.config.TELEGRAM_PUBLISH_CHANNEL) {
      return 'Не задан TELEGRAM_PUBLISH_CHANNEL.';
    }
    return null;
  }

  get channel(): string {
    return this.config.TELEGRAM_PUBLISH_CHANNEL ?? '(не задан)';
  }

  get isDryRun(): boolean {
    return this.config.TELEGRAM_PUBLISH_DRY_RUN;
  }

  /**
   * Опубликовать материал.
   *
   * Сухой прогон включён по умолчанию: при приёмке системы и настройке
   * источников случайная отправка в реальный канал недопустима. Отключается
   * явным TELEGRAM_PUBLISH_DRY_RUN=false.
   */
  async publish(input: { text: string; media: PublishMedia[] }): Promise<PublishResult> {
    // Сухой прогон выполняется и без настроенного бота: его задача —
    // проверить весь путь материала ДО подключения Telegram. Отсутствие
    // токена при этом не скрывается, а возвращается предупреждением,
    // чтобы успешный прогон не приняли за проверенную отправку.
    if (this.isDryRun) {
      const reason = this.unavailableReason();
      log.info(
        {
          channel: this.channel,
          length: input.text.length,
          media: input.media.length,
          configured: reason === null,
        },
        'Сухой прогон публикации: сообщение НЕ отправлено',
      );
      return {
        ok: true,
        messageId: null,
        dryRun: true,
        ...(reason ? { warning: `Сухой прогон выполнен, но Telegram не настроен: ${reason}` } : {}),
      };
    }

    const reason = this.unavailableReason();
    if (reason) {
      return { ok: false, messageId: null, error: reason, dryRun: false };
    }

    try {
      const messageId =
        input.media.length === 0
          ? await this.sendMessage(input.text)
          : await this.sendMedia(input.text, input.media);

      log.info({ channel: this.channel, messageId }, 'Материал опубликован');
      return { ok: true, messageId, dryRun: false };
    } catch (error) {
      const message = safeUrl((error as Error).message);
      log.error({ err: message }, 'Не удалось опубликовать материал');
      return { ok: false, messageId: null, error: message, dryRun: false };
    }
  }

  /** Проверить доступ бота к каналу — используется в диагностике. */
  async verifyChannel(): Promise<{ ok: boolean; title?: string; reason?: string }> {
    const reason = this.unavailableReason();
    if (reason) return { ok: false, reason };

    try {
      const body = await this.call<{ ok: boolean; result?: { title?: string }; description?: string }>(
        'getChat',
        { chat_id: this.channel },
      );
      if (!body.ok) return { ok: false, reason: body.description ?? 'Канал недоступен' };
      return { ok: true, title: body.result?.title };
    } catch (error) {
      return { ok: false, reason: safeUrl((error as Error).message) };
    }
  }

  private async sendMessage(text: string): Promise<string | null> {
    const body = await this.call<{
      ok: boolean;
      result?: { message_id: number };
      description?: string;
    }>('sendMessage', {
      chat_id: this.channel,
      text,
      // Форматирование не применяется: текст отправляется как есть, и
      // случайный спецсимвол не может привести к отказу в отправке.
      disable_web_page_preview: true,
    });

    if (!body.ok) throw new Error(body.description ?? 'Telegram отклонил сообщение');
    return body.result ? String(body.result.message_id) : null;
  }

  /**
   * Отправить медиа-группу.
   *
   * Telegram допускает не более 10 вложений и переносит текст в подпись
   * первого элемента — остальные подписи он игнорирует.
   */
  private async sendMedia(text: string, media: PublishMedia[]): Promise<string | null> {
    const items = media.slice(0, TELEGRAM_MEDIA_GROUP_LIMIT);
    const form = new FormData();
    form.set('chat_id', this.channel);

    if (items.length === 1) {
      const item = items[0] as PublishMedia;
      const method = item.type === 'VIDEO' ? 'sendVideo' : 'sendPhoto';
      form.set('caption', text);
      form.set(item.type === 'VIDEO' ? 'video' : 'photo', toBlob(item), item.filename);

      const body = await this.callForm<{
        ok: boolean;
        result?: { message_id: number };
        description?: string;
      }>(method, form);
      if (!body.ok) throw new Error(body.description ?? 'Telegram отклонил медиа');
      return body.result ? String(body.result.message_id) : null;
    }

    // Для группы файлы прикладываются отдельными частями запроса, а в
    // описании группы на них ссылаются через attach://<имя части>.
    const group = items.map((item, index) => {
      const part = `file${index}`;
      form.set(part, toBlob(item), item.filename);
      return {
        type: item.type === 'VIDEO' ? 'video' : 'photo',
        media: `attach://${part}`,
        ...(index === 0 ? { caption: text } : {}),
      };
    });
    form.set('media', JSON.stringify(group));

    const body = await this.callForm<{
      ok: boolean;
      result?: Array<{ message_id: number }>;
      description?: string;
    }>('sendMediaGroup', form);

    if (!body.ok) throw new Error(body.description ?? 'Telegram отклонил медиа-группу');
    return body.result?.[0] ? String(body.result[0].message_id) : null;
  }

  /** Вызов с передачей файлов: тело запроса — multipart, не JSON. */
  private async callForm<T>(method: string, form: FormData): Promise<T> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.config.TELEGRAM_PUBLISH_BOT_TOKEN}/${method}`,
      { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) },
    );

    const body = (await response.json()) as T & { description?: string };
    if (!response.ok && !(body as { ok?: boolean }).ok) {
      throw new Error(body.description ?? `Telegram API вернул HTTP ${response.status}`);
    }
    return body;
  }

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.config.TELEGRAM_PUBLISH_BOT_TOKEN}/${method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(30_000),
      },
    );

    const body = (await response.json()) as T & { description?: string };
    if (!response.ok && !(body as { ok?: boolean }).ok) {
      throw new Error(body.description ?? `Telegram API вернул HTTP ${response.status}`);
    }
    return body;
  }
}

/** Файл для отправки в multipart-запросе. */
function toBlob(item: PublishMedia): Blob {
  return new Blob([new Uint8Array(item.data)], {
    type: item.mimeType ?? (item.type === 'VIDEO' ? 'video/mp4' : 'image/jpeg'),
  });
}
