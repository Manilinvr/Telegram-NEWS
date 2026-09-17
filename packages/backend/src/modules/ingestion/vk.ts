import type { Source } from '@nnm/shared';
import type { AppConfig } from '../../config/env.js';
import { httpGetJson } from './http.js';
import {
  SourceFetchError,
  type FetchOptions,
  type FetchResult,
  type FetchedMedia,
  type FetchedPost,
  type SourceAdapter,
} from './types.js';

/**
 * Чтение публичных сообществ и страниц VK через официальный API
 * (метод wall.get, сервисный ключ доступа).
 *
 * Читаются только открытые стены. Закрытые сообщества требуют прав, которых
 * у сервисного ключа нет, и попытки их получить не предпринимаются.
 */

interface VkPhotoSize {
  url: string;
  width: number;
  height: number;
  type: string;
}

interface VkAttachment {
  type: string;
  photo?: { id: number; sizes: VkPhotoSize[]; text?: string };
  video?: {
    id: number;
    owner_id: number;
    title?: string;
    duration?: number;
    player?: string;
    image?: VkPhotoSize[];
  };
  doc?: { id: number; url?: string; ext?: string; title?: string; size?: number };
  audio?: { id: number; url?: string; duration?: number; title?: string };
  link?: { url: string; title?: string };
}

interface VkPost {
  id: number;
  owner_id: number;
  from_id: number;
  date: number;
  text: string;
  attachments?: VkAttachment[];
  copy_history?: VkPost[];
  views?: { count: number };
  likes?: { count: number };
  reposts?: { count: number };
  is_pinned?: number;
}

interface VkResponse<T> {
  response?: T;
  error?: { error_code: number; error_msg: string };
}

/** Коды ошибок VK, при которых повтор бессмысленен. */
const PERMANENT_VK_ERRORS = new Set([
  5,   // авторизация не удалась
  15,  // доступ запрещён
  18,  // страница удалена или заблокирована
  100, // неверные параметры
  113, // неверный ID владельца
  200, // доступ к стене запрещён
]);

export class VkSourceAdapter implements SourceAdapter {
  readonly type = 'VK' as const;
  readonly mode = 'api';

  constructor(private readonly config: AppConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.VK_ACCESS_TOKEN);
  }

  unavailableReason(): string | null {
    return this.isConfigured()
      ? null
      : 'Не задан VK_ACCESS_TOKEN (сервисный ключ доступа). См. docs/SETUP-SOURCES.md.';
  }

  private async call<T>(method: string, params: Record<string, string | number>): Promise<T> {
    const query = new URLSearchParams({
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      access_token: this.config.VK_ACCESS_TOKEN as string,
      v: this.config.VK_API_VERSION,
    });

    const body = await httpGetJson<VkResponse<T>>(`https://api.vk.com/method/${method}?${query}`);

    if (body.error) {
      throw new SourceFetchError(
        `VK API (${method}): ${body.error.error_msg} [код ${body.error.error_code}]`,
        !PERMANENT_VK_ERRORS.has(body.error.error_code),
      );
    }
    if (body.response === undefined) {
      throw new SourceFetchError(`VK API (${method}): пустой ответ`, true);
    }
    return body.response;
  }

  async fetch(source: Source, options: FetchOptions): Promise<FetchResult> {
    if (!this.isConfigured()) {
      throw new SourceFetchError(this.unavailableReason() as string, false);
    }

    const target = this.resolveTarget(source);
    const response = await this.call<{ count: number; items: VkPost[] }>('wall.get', {
      ...target,
      count: Math.min(options.limit, 100),
      // Стена отдаётся от новых к старым; фильтруем на нашей стороне.
      offset: 0,
      extended: 0,
    });

    const posts = response.items
      .filter((item) => {
        if (options.notBefore && item.date * 1000 < options.notBefore.getTime()) return false;
        if (options.sinceExternalId) return item.id > Number(options.sinceExternalId);
        return true;
      })
      // Закреплённая запись всплывает наверх годами — она не является новой.
      .filter((item) => item.is_pinned !== 1 || !options.sinceExternalId)
      .map((item) => this.toPost(item, source))
      .sort((a, b) => Number(a.externalId) - Number(b.externalId));

    return {
      posts,
      lastExternalId: posts.at(-1)?.externalId ?? options.sinceExternalId,
    };
  }

  async verify(
    source: Pick<Source, 'type' | 'username' | 'externalId' | 'url'>,
  ): Promise<{ ok: true; title?: string; externalId?: string } | { ok: false; reason: string }> {
    if (!this.isConfigured()) {
      return { ok: false, reason: this.unavailableReason() as string };
    }
    try {
      const target = this.resolveTarget(source as Source);
      const response = await this.call<{ count: number; items: VkPost[] }>('wall.get', {
        ...target,
        count: 1,
      });
      const ownerId = response.items[0]?.owner_id;
      return { ok: true, externalId: ownerId ? String(ownerId) : undefined };
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
  }

  /** VK принимает либо числовой owner_id, либо короткое имя (domain). */
  private resolveTarget(source: Pick<Source, 'externalId' | 'username' | 'url'>): Record<string, string> {
    if (source.externalId) return { owner_id: source.externalId };
    const domain =
      source.username ??
      /vk\.com\/([A-Za-z0-9._]+)/.exec(source.url ?? '')?.[1] ??
      null;
    if (!domain) {
      throw new SourceFetchError('Для источника VK не указан ни owner_id, ни короткое имя.', false);
    }
    return { domain: domain.replace(/^@/, '') };
  }

  private toPost(item: VkPost, source: Source): FetchedPost {
    // Репост: собственный текст может быть пустым, а содержимое лежит
    // в copy_history. Сохраняем оба текста, помечая публикацию репостом.
    const original = item.copy_history?.[0];
    const text = [item.text, original?.text].filter(Boolean).join('\n\n').trim();
    const attachments = [...(item.attachments ?? []), ...(original?.attachments ?? [])];

    const media: FetchedMedia[] = [];
    for (const attachment of attachments) {
      if (attachment.type === 'photo' && attachment.photo) {
        const largest = attachment.photo.sizes.reduce((a, b) => (a.width > b.width ? a : b));
        media.push({
          type: 'PHOTO',
          url: largest.url,
          width: largest.width,
          height: largest.height,
          caption: attachment.photo.text || null,
        });
      } else if (attachment.type === 'video' && attachment.video) {
        const preview = attachment.video.image?.reduce((a, b) => (a.width > b.width ? a : b));
        media.push({
          type: 'VIDEO',
          // Сервисный ключ не даёт прямой ссылки на файл: сохраняем
          // ссылку на плеер, она же служит оригиналом для атрибуции.
          url: attachment.video.player ?? preview?.url ?? null,
          durationSeconds: attachment.video.duration ?? null,
          caption: attachment.video.title ?? null,
          width: preview?.width ?? null,
          height: preview?.height ?? null,
        });
      } else if (attachment.type === 'doc' && attachment.doc?.url) {
        media.push({
          type: 'DOCUMENT',
          url: attachment.doc.url,
          caption: attachment.doc.title ?? null,
          sizeBytes: attachment.doc.size ?? null,
        });
      } else if (attachment.type === 'audio' && attachment.audio?.url) {
        media.push({
          type: 'AUDIO',
          url: attachment.audio.url,
          durationSeconds: attachment.audio.duration ?? null,
          caption: attachment.audio.title ?? null,
        });
      }
    }

    return {
      externalId: String(item.id),
      url: `https://vk.com/wall${item.owner_id}_${item.id}`,
      postedAt: new Date(item.date * 1000),
      text,
      isForward: Boolean(original),
      forwardFrom: original ? `vk.com/wall${original.owner_id}_${original.id}` : null,
      media,
      metadata: {
        ownerId: item.owner_id,
        fromId: item.from_id,
        views: item.views?.count ?? null,
        likes: item.likes?.count ?? null,
        reposts: item.reposts?.count ?? null,
        sourceTitle: source.title,
      },
    };
  }
}
