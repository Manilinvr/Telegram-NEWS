import type { Source } from '@nnm/shared';
import type { AppConfig } from '../../config/env.js';
import { childLogger } from '../../lib/logger.js';
import { httpGetJson, httpGetText, safeUrl } from './http.js';
import { htmlToText } from './html.js';
import {
  SourceFetchError,
  type FetchOptions,
  type FetchResult,
  type FetchedMedia,
  type FetchedPost,
  type SourceAdapter,
} from './types.js';

const log = childLogger({ module: 'telegram-adapter' });

/**
 * Доступ к публичным Telegram-каналам.
 *
 * Поддерживаются два официальных пути, и выбор между ними — это выбор
 * компромисса, а не «правильного» варианта:
 *
 *  • `bot` — Bot API. Полностью официальный интерфейс, но Telegram НЕ даёт
 *    ботам читать историю канала: бот получает только новые публикации и
 *    только там, где он добавлен участником. Для своих каналов это лучший
 *    вариант, для чужих — неприменим.
 *
 *  • `public-preview` — публичная страница предпросмотра t.me/s/<канал>,
 *    которую Telegram сам отдаёт без авторизации именно для просмотра
 *    открытых каналов. Позволяет читать чужие публичные каналы и получать
 *    небольшую историю. Никакие ограничения не обходятся: нет обхода
 *    авторизации, CAPTCHA или приватных чатов, запросы делаются редко и с
 *    честным User-Agent. Каналы, закрывшие предпросмотр, не читаются — это
 *    прямое указание владельца, и оно уважается.
 *
 * Режим задаётся TELEGRAM_INGEST_MODE. Подробности и последствия выбора
 * описаны в docs/SETUP-SOURCES.md.
 */

interface TelegramUpdate {
  update_id: number;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; username?: string; title?: string; type: string };
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; width: number; height: number; file_size?: number }>;
  video?: { file_id: string; width: number; height: number; duration: number; mime_type?: string; file_size?: number };
  animation?: { file_id: string; mime_type?: string; file_size?: number };
  audio?: { file_id: string; duration: number; mime_type?: string };
  document?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number };
  forward_from_chat?: { title?: string; username?: string };
  media_group_id?: string;
  views?: number;
}

/** Курсор Bot API, переживающий перезапуск процесса. */
export interface CursorStore {
  get(key: string): Promise<number | null>;
  set(key: string, value: number): Promise<void>;
}

export class TelegramBotAdapter implements SourceAdapter {
  readonly type = 'TELEGRAM' as const;
  readonly mode = 'bot';

  /**
   * Буфер публикаций по каналам.
   *
   * getUpdates отдаёт единый поток обновлений сразу по всем чатам, а
   * интерфейс адаптера работает с одним источником, поэтому обновления
   * сначала раскладываются по каналам, а затем выдаются нужному источнику.
   */
  private readonly buffer = new Map<string, FetchedPost[]>();
  private draining: Promise<void> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly cursors?: CursorStore,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.TELEGRAM_BOT_TOKEN);
  }

  unavailableReason(): string | null {
    if (!this.config.TELEGRAM_BOT_TOKEN) {
      return 'Не задан TELEGRAM_BOT_TOKEN. См. docs/SETUP-SOURCES.md.';
    }
    return null;
  }

  private api(method: string, params: Record<string, string | number> = {}): string {
    const query = new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)] as [string, string]),
    );
    return `https://api.telegram.org/bot${this.config.TELEGRAM_BOT_TOKEN}/${method}?${query}`;
  }

  /** Забрать новые обновления и разложить их по каналам. */
  private async drainUpdates(): Promise<void> {
    // Параллельные вызовы getUpdates с одним токеном конфликтуют, поэтому
    // одновременно выполняется только одно обновление буфера.
    if (this.draining) return this.draining;

    this.draining = (async () => {
      const offsetKey = 'telegram.bot.offset';
      const offset = (await this.cursors?.get(offsetKey)) ?? 0;

      const response = await httpGetJson<{
        ok: boolean;
        result: TelegramUpdate[];
        description?: string;
      }>(
        this.api('getUpdates', {
          offset: offset + 1,
          limit: 100,
          timeout: 0,
          allowed_updates: JSON.stringify(['channel_post', 'edited_channel_post']),
        }),
      );

      if (!response.ok) {
        throw new SourceFetchError(`Telegram Bot API: ${response.description ?? 'ошибка'}`, true);
      }

      let maxUpdateId = offset;
      for (const update of response.result) {
        maxUpdateId = Math.max(maxUpdateId, update.update_id);
        const message = update.channel_post ?? update.edited_channel_post;
        if (!message) continue;

        const key = channelKey(message.chat.username, message.chat.id);
        const posts = this.buffer.get(key) ?? [];
        posts.push(this.toPost(message));
        this.buffer.set(key, posts);
      }

      if (maxUpdateId > offset) {
        await this.cursors?.set(offsetKey, maxUpdateId);
      }
    })().finally(() => {
      this.draining = null;
    });

    return this.draining;
  }

  async fetch(source: Source, options: FetchOptions): Promise<FetchResult> {
    if (!this.isConfigured()) {
      throw new SourceFetchError(this.unavailableReason() as string, false);
    }

    await this.drainUpdates();

    const key = channelKey(source.username, source.externalId);
    const buffered = this.buffer.get(key) ?? [];
    this.buffer.set(key, []);

    const posts = buffered
      .filter((post) => !options.notBefore || post.postedAt >= options.notBefore)
      .slice(0, options.limit);

    return {
      posts,
      lastExternalId: posts.at(-1)?.externalId ?? options.sinceExternalId,
      ...(posts.length === 0 && buffered.length === 0
        ? {
            warning:
              'Bot API отдаёт только новые публикации и только для каналов, где бот является участником. История канала недоступна.',
          }
        : {}),
    };
  }

  async verify(
    source: Pick<Source, 'type' | 'username' | 'externalId' | 'url'>,
  ): Promise<{ ok: true; title?: string; externalId?: string } | { ok: false; reason: string }> {
    if (!this.isConfigured()) {
      return { ok: false, reason: this.unavailableReason() as string };
    }
    const chatId = source.username ? `@${source.username.replace(/^@/, '')}` : source.externalId;
    if (!chatId) return { ok: false, reason: 'Не указан username или ID канала.' };

    try {
      const response = await httpGetJson<{
        ok: boolean;
        result?: { id: number; title?: string };
        description?: string;
      }>(this.api('getChat', { chat_id: chatId }));

      if (!response.ok || !response.result) {
        return { ok: false, reason: response.description ?? 'Канал недоступен для бота.' };
      }
      return {
        ok: true,
        title: response.result.title,
        externalId: String(response.result.id),
      };
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
  }

  private toPost(message: TelegramMessage): FetchedPost {
    const username = message.chat.username;
    const media: FetchedMedia[] = [];

    // Из набора превью берём самое крупное.
    if (message.photo?.length) {
      const largest = message.photo.reduce((a, b) => (a.width > b.width ? a : b));
      media.push({
        type: 'PHOTO',
        url: null,
        externalFileId: largest.file_id,
        width: largest.width,
        height: largest.height,
        sizeBytes: largest.file_size ?? null,
        caption: message.caption ?? null,
      });
    }
    if (message.video) {
      media.push({
        type: 'VIDEO',
        url: null,
        externalFileId: message.video.file_id,
        width: message.video.width,
        height: message.video.height,
        durationSeconds: message.video.duration,
        mimeType: message.video.mime_type ?? null,
        sizeBytes: message.video.file_size ?? null,
        caption: message.caption ?? null,
      });
    }
    if (message.animation) {
      media.push({
        type: 'ANIMATION',
        url: null,
        externalFileId: message.animation.file_id,
        mimeType: message.animation.mime_type ?? null,
      });
    }
    if (message.audio) {
      media.push({
        type: 'AUDIO',
        url: null,
        externalFileId: message.audio.file_id,
        durationSeconds: message.audio.duration,
        mimeType: message.audio.mime_type ?? null,
      });
    }
    if (message.document) {
      media.push({
        type: 'DOCUMENT',
        url: null,
        externalFileId: message.document.file_id,
        mimeType: message.document.mime_type ?? null,
        sizeBytes: message.document.file_size ?? null,
      });
    }

    return {
      externalId: String(message.message_id),
      url: username ? `https://t.me/${username}/${message.message_id}` : null,
      postedAt: new Date(message.date * 1000),
      text: message.text ?? message.caption ?? '',
      isForward: Boolean(message.forward_from_chat),
      forwardFrom: message.forward_from_chat?.title ?? message.forward_from_chat?.username ?? null,
      media,
      metadata: {
        chatId: message.chat.id,
        chatTitle: message.chat.title,
        mediaGroupId: message.media_group_id ?? null,
        views: message.views ?? null,
      },
    };
  }

  /** Получить временную прямую ссылку на файл по его file_id. */
  async resolveFileUrl(fileId: string): Promise<string | null> {
    if (!this.isConfigured()) return null;
    const response = await httpGetJson<{ ok: boolean; result?: { file_path?: string } }>(
      this.api('getFile', { file_id: fileId }),
    );
    if (!response.ok || !response.result?.file_path) return null;
    return `https://api.telegram.org/file/bot${this.config.TELEGRAM_BOT_TOKEN}/${response.result.file_path}`;
  }
}

/**
 * Чтение публичной страницы предпросмотра канала.
 *
 * Страница t.me/s/<канал> публикуется самим Telegram без авторизации.
 * Если канал предпросмотр отключил, ответ не содержит публикаций — адаптер
 * сообщает об этом и НЕ пытается получить данные иным путём.
 */
export class TelegramPublicPreviewAdapter implements SourceAdapter {
  readonly type = 'TELEGRAM' as const;
  readonly mode = 'public-preview';

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): null {
    return null;
  }

  async fetch(source: Source, options: FetchOptions): Promise<FetchResult> {
    const username = (source.username ?? '').replace(/^@/, '');
    if (!username) {
      throw new SourceFetchError('Для режима public-preview нужен username канала.', false);
    }

    // `before` листает страницу назад; при первом импорте берём последнюю.
    const url = `https://t.me/s/${encodeURIComponent(username)}`;
    const html = await httpGetText(url, { timeoutMs: 20_000 });

    const posts = parsePreviewPage(html, username)
      .filter((post) => {
        if (options.notBefore && post.postedAt < options.notBefore) return false;
        if (options.sinceExternalId) {
          // ID публикаций в канале монотонно растут.
          return Number(post.externalId) > Number(options.sinceExternalId);
        }
        return true;
      })
      .sort((a, b) => Number(a.externalId) - Number(b.externalId))
      .slice(-options.limit);

    if (posts.length === 0 && !html.includes('tgme_widget_message')) {
      return {
        posts: [],
        lastExternalId: options.sinceExternalId,
        warning:
          `Канал @${username} не отдаёт публичный предпросмотр (он отключён владельцем либо канал закрыт). ` +
          'Используйте режим bot, добавив бота в канал.',
      };
    }

    log.debug({ username, count: posts.length }, 'Прочитан публичный предпросмотр канала');

    return {
      posts,
      lastExternalId: posts.at(-1)?.externalId ?? options.sinceExternalId,
    };
  }

  async verify(
    source: Pick<Source, 'type' | 'username' | 'externalId' | 'url'>,
  ): Promise<{ ok: true; title?: string; externalId?: string } | { ok: false; reason: string }> {
    const username = (source.username ?? '').replace(/^@/, '');
    if (!username) return { ok: false, reason: 'Не указан username канала.' };

    try {
      const html = await httpGetText(`https://t.me/s/${encodeURIComponent(username)}`);
      if (!html.includes('tgme_widget_message')) {
        return {
          ok: false,
          reason: 'Канал не публикует предпросмотр: он закрыт или предпросмотр отключён владельцем.',
        };
      }
      const title = /<meta property="og:title" content="([^"]+)"/.exec(html)?.[1];
      return { ok: true, title: title ? htmlToText(title) : undefined };
    } catch (error) {
      return { ok: false, reason: safeUrl((error as Error).message) };
    }
  }
}

/** Разбор страницы предпросмотра в набор публикаций. */
export function parsePreviewPage(html: string, username: string): FetchedPost[] {
  const posts: FetchedPost[] = [];

  // Разметка страницы состоит из блоков-сообщений; делим по началу блока.
  const blocks = html.split('<div class="tgme_widget_message_wrap').slice(1);

  for (const block of blocks) {
    const postId = /data-post="[^/"]+\/(\d+)"/.exec(block)?.[1];
    if (!postId) continue;

    const datetime = /<time[^>]+datetime="([^"]+)"/.exec(block)?.[1];
    const postedAt = datetime ? new Date(datetime) : null;
    if (!postedAt || Number.isNaN(postedAt.getTime())) continue;

    const textMatch = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block);
    const text = textMatch?.[1] ? htmlToText(textMatch[1]) : '';

    const media: FetchedMedia[] = [];

    // Фотографии лежат в background-image у обёртки превью.
    for (const photoUrl of collect(block, /tgme_widget_message_photo_wrap[^"]*"[^>]*background-image:url\('([^']+)'\)/g)) {
      media.push({ type: 'PHOTO', url: photoUrl });
    }
    for (const videoUrl of collect(block, /<video[^>]+src="([^"]+)"/g)) {
      const duration = /<time class="message_video_duration[^"]*">([^<]+)<\/time>/.exec(block)?.[1];
      media.push({ type: 'VIDEO', url: videoUrl, durationSeconds: parseDuration(duration) });
    }
    for (const roundUrl of collect(block, /<audio[^>]+src="([^"]+)"/g)) {
      media.push({ type: 'AUDIO', url: roundUrl });
    }

    const forwardFrom = /tgme_widget_message_forwarded_from_name"[^>]*>([\s\S]*?)<\/(?:a|span)>/.exec(block)?.[1];
    const views = /<span class="tgme_widget_message_views">([^<]+)<\/span>/.exec(block)?.[1];

    posts.push({
      externalId: postId,
      url: `https://t.me/${username}/${postId}`,
      postedAt,
      text,
      isForward: Boolean(forwardFrom),
      forwardFrom: forwardFrom ? htmlToText(forwardFrom) : null,
      media,
      metadata: { views: views ?? null, source: 'public-preview' },
    });
  }

  return posts;
}

function collect(input: string, pattern: RegExp): string[] {
  const out: string[] = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(pattern.source, pattern.flags);
  while ((match = regex.exec(input)) !== null) {
    if (match[1]) out.push(match[1]);
    if (match.index === regex.lastIndex) regex.lastIndex += 1;
  }
  return out;
}

/** «1:23» → 83 секунды. */
function parseDuration(value: string | undefined): number | null {
  if (!value) return null;
  const parts = value.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, part) => acc * 60 + part, 0);
}

function channelKey(username: string | null | undefined, id: string | number | null | undefined): string {
  if (username) return `@${String(username).replace(/^@/, '').toLowerCase()}`;
  return String(id ?? '');
}
