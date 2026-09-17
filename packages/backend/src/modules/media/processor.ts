import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MediaItem } from '@nnm/shared';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db/pool.js';
import { sha256 } from '../../lib/crypto.js';
import { childLogger } from '../../lib/logger.js';
import { httpGetBuffer } from '../ingestion/http.js';
import { buildStorageKey, type StorageDriver } from '../storage/driver.js';
import { FfmpegTools } from './ffmpeg.js';

const log = childLogger({ module: 'media-processor' });

/**
 * MediaProcessor (ТЗ §18).
 *
 * Скачивает вложения, кладёт их в приватное хранилище, считает контрольную
 * сумму и определяет параметры файла. Контрольная сумма важна не только для
 * дедупликации файлов: совпадение фотографий у разных источников — сильный
 * признак того, что это перепечатка, а не независимое подтверждение
 * события.
 */
export class MediaProcessor {
  private readonly ffmpeg: FfmpegTools;

  constructor(
    private readonly db: Database,
    private readonly storage: StorageDriver,
    private readonly config: AppConfig,
    /** Позволяет получить свежую ссылку для платформ с временными URL. */
    private readonly resolveUrl?: (media: MediaItem) => Promise<string | null>,
  ) {
    this.ffmpeg = new FfmpegTools(
      config.FFMPEG_PATH ?? 'ffmpeg',
      config.FFPROBE_PATH ?? 'ffprobe',
    );
  }

  /**
   * Обработать одно вложение.
   *
   * Ошибка скачивания не выбрасывается наружу: она фиксируется в самой
   * записи медиа, а обработка публикации продолжается — новость важнее
   * картинки к ней.
   */
  async process(mediaId: string): Promise<{ ok: boolean; reason?: string }> {
    const row = await this.db.maybeOne('SELECT * FROM media WHERE id = $1', [mediaId]);
    if (!row) return { ok: false, reason: 'Вложение не найдено' };

    const media = row as unknown as {
      id: string;
      source_post_id: string;
      type: MediaItem['type'];
      original_url: string | null;
      mime_type: string | null;
      storage_key: string | null;
    };

    if (media.storage_key) return { ok: true };

    await this.db.query(`UPDATE media SET download_status = 'PROCESSING' WHERE id = $1`, [mediaId]);

    try {
      const url =
        media.original_url ??
        (this.resolveUrl ? await this.resolveUrl(row as unknown as MediaItem) : null);

      if (!url) {
        await this.markError(mediaId, 'Нет доступной ссылки на файл');
        return { ok: false, reason: 'Нет ссылки' };
      }

      // Ссылка на плеер — не файл: скачивать нечего, но запись остаётся
      // валидной и хранит оригинальный URL для атрибуции.
      if (isPlayerUrl(url)) {
        await this.db.query(
          `UPDATE media SET download_status = 'PROCESSED', download_error = $2 WHERE id = $1`,
          [mediaId, 'Источник отдаёт только ссылку на плеер; файл не скачивается.'],
        );
        return { ok: true };
      }

      const { buffer, contentType } = await httpGetBuffer(url, {
        maxBytes: this.config.MEDIA_MAX_FILE_MB * 1024 * 1024,
      });

      const mime = media.mime_type ?? contentType ?? guessMime(url, media.type);
      if (!this.isAllowedMime(mime)) {
        await this.markError(mediaId, `Тип файла не разрешён: ${mime}`);
        return { ok: false, reason: 'Недопустимый тип файла' };
      }

      const post = await this.db.one(
        'SELECT source_id, posted_at FROM source_posts WHERE id = $1',
        [media.source_post_id],
      );

      const checksum = sha256(buffer);
      const key = buildStorageKey({
        sourceId: String(post.source_id),
        postId: media.source_post_id,
        filename: `${checksum.slice(0, 16)}${extensionFor(mime, url)}`,
        postedAt: new Date(String(post.posted_at)),
      });

      await this.storage.put(key, buffer, mime);

      // Параметры файла определяем локально: длительность и наличие звука
      // решают, нужно ли ставить задачу на транскрипцию.
      let probe = null;
      let thumbnailKey: string | null = null;

      if (media.type === 'VIDEO' || media.type === 'AUDIO' || media.type === 'ANIMATION') {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nnm-media-'));
        const tempFile = path.join(tempDir, `input${extensionFor(mime, url)}`);
        try {
          await fs.writeFile(tempFile, buffer);
          probe = await this.ffmpeg.probe(tempFile);

          if (media.type === 'VIDEO') {
            const thumbFile = path.join(tempDir, 'thumb.jpg');
            if (await this.ffmpeg.extractThumbnail(tempFile, thumbFile)) {
              const thumbBuffer = await fs.readFile(thumbFile);
              thumbnailKey = `${key}.thumb.jpg`;
              await this.storage.put(thumbnailKey, thumbBuffer, 'image/jpeg');
            }
          }
        } finally {
          await fs.rm(tempDir, { recursive: true, force: true });
        }
      }

      await this.db.query(
        `UPDATE media SET
           storage_key      = $2,
           mime_type        = COALESCE(mime_type, $3),
           size_bytes       = $4,
           checksum         = $5,
           width            = COALESCE(width, $6),
           height           = COALESCE(height, $7),
           duration_seconds = COALESCE(duration_seconds, $8),
           has_audio        = $9,
           thumbnail_key    = $10,
           download_status  = 'PROCESSED',
           download_error   = NULL
         WHERE id = $1`,
        [
          mediaId,
          key,
          mime,
          buffer.byteLength,
          checksum,
          probe?.width ?? null,
          probe?.height ?? null,
          probe?.durationSeconds ?? null,
          probe?.hasAudio ?? null,
          thumbnailKey,
        ],
      );

      return { ok: true };
    } catch (error) {
      const message = (error as Error).message;
      log.warn({ err: error, mediaId }, 'Не удалось обработать вложение');
      await this.markError(mediaId, message);
      return { ok: false, reason: message };
    }
  }

  private async markError(mediaId: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE media SET download_status = 'ERROR', download_error = $2 WHERE id = $1`,
      [mediaId, reason.slice(0, 1000)],
    );
  }

  private isAllowedMime(mime: string | null): boolean {
    if (!mime) return false;
    const base = mime.split(';')[0]?.trim().toLowerCase() ?? '';
    return this.config.mediaAllowedMimeList.includes(base);
  }

  /** Видео со звуком, укладывающееся в лимит длительности. */
  async needsTranscription(mediaId: string): Promise<boolean> {
    const row = await this.db.maybeOne(
      `SELECT type, has_audio, duration_seconds, storage_key FROM media WHERE id = $1`,
      [mediaId],
    );
    if (!row || !row.storage_key) return false;
    if (row.type !== 'VIDEO' && row.type !== 'AUDIO') return false;
    // has_audio = null означает, что ffprobe недоступен: пробуем распознать,
    // а отсутствие речи выяснится на этапе транскрипции.
    if (row.has_audio === false) return false;

    const duration = row.duration_seconds === null ? null : Number(row.duration_seconds);
    if (duration !== null && duration > this.config.TRANSCRIPTION_MAX_DURATION_SECONDS) {
      return false;
    }
    return true;
  }
}

/** Ссылки на встраиваемые плееры — файлов за ними нет. */
function isPlayerUrl(url: string): boolean {
  return /\/video_ext\.php|youtube\.com|youtu\.be|rutube\.ru\/play/.test(url);
}

function guessMime(url: string, type: MediaItem['type']): string {
  const ext = path.extname(new URL(url, 'https://example.invalid').pathname).toLowerCase();
  const byExt: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
  };
  if (byExt[ext]) return byExt[ext] as string;
  return type === 'PHOTO' ? 'image/jpeg' : type === 'VIDEO' ? 'video/mp4' : 'application/octet-stream';
}

function extensionFor(mime: string | null, url: string): string {
  const fromUrl = path.extname(new URL(url, 'https://example.invalid').pathname);
  if (fromUrl && fromUrl.length <= 6) return fromUrl.toLowerCase();
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'audio/mp4': '.m4a',
  };
  return map[(mime ?? '').split(';')[0]?.trim() ?? ''] ?? '.bin';
}
