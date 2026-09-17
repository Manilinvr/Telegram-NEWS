import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PIPELINE_STAGE, type Transcript } from '@nnm/shared';
import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db/pool.js';
import { childLogger } from '../../lib/logger.js';
import { mapTranscript } from '../../repositories/mappers.js';
import { OpsRepository } from '../../repositories/ops.js';
import { FfmpegTools } from '../media/ffmpeg.js';
import type { StorageDriver } from '../storage/driver.js';
import { createTranscriptionProvider, type TranscriptionProvider } from './provider.js';

const log = childLogger({ module: 'transcription-service' });

/**
 * TranscriptionProcessor (ТЗ §9, §18).
 *
 * Полная транскрипция сохраняется для просмотра в админке и НЕ обязана
 * попадать в Telegram-пост: в публичный черновик идут только отобранные
 * смысловые фрагменты.
 *
 * Неудача распознавания не блокирует событие (ТЗ §24): транскрипция
 * помечается как недоступная, а новость проходит дальше по pipeline.
 */
export class TranscriptionService {
  private readonly provider: TranscriptionProvider;
  private readonly ffmpeg: FfmpegTools;
  private readonly ops: OpsRepository;

  constructor(
    private readonly db: Database,
    private readonly storage: StorageDriver,
    private readonly config: AppConfig,
    provider?: TranscriptionProvider,
  ) {
    this.provider = provider ?? createTranscriptionProvider(config);
    this.ffmpeg = new FfmpegTools(config.FFMPEG_PATH ?? 'ffmpeg', config.FFPROBE_PATH ?? 'ffprobe');
    this.ops = new OpsRepository(db);
  }

  get providerName(): string {
    return this.provider.name;
  }

  isAvailable(): boolean {
    return this.provider.isAvailable();
  }

  /** Распознать речь в одном медиафайле. Исключения наружу не выбрасываются. */
  async transcribeMedia(mediaId: string): Promise<Transcript | null> {
    const media = await this.db.maybeOne(
      `SELECT id, type, storage_key, has_audio, duration_seconds FROM media WHERE id = $1`,
      [mediaId],
    );

    if (!media) return null;

    if (!this.provider.isAvailable()) {
      return this.markStatus(mediaId, 'UNAVAILABLE', this.provider.unavailableReason());
    }
    if (!media.storage_key) {
      return this.markStatus(mediaId, 'SKIPPED', 'Файл не был скачан.');
    }
    if (media.has_audio === false) {
      return this.markStatus(mediaId, 'SKIPPED', 'В файле нет звуковой дорожки.');
    }

    const duration = media.duration_seconds === null ? null : Number(media.duration_seconds);
    if (duration !== null && duration > this.config.TRANSCRIPTION_MAX_DURATION_SECONDS) {
      return this.markStatus(
        mediaId,
        'SKIPPED',
        `Длительность ${Math.round(duration)} с превышает лимит ${this.config.TRANSCRIPTION_MAX_DURATION_SECONDS} с.`,
      );
    }

    await this.upsert(mediaId, { status: 'PROCESSING' });

    const started = Date.now();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nnm-transcribe-'));

    try {
      const sourceFile = path.join(tempDir, 'source');
      const buffer = await this.storage.get(String(media.storage_key));
      await fs.writeFile(sourceFile, buffer);

      const audioFile = path.join(tempDir, 'audio.wav');
      const extracted = await this.ffmpeg.extractAudio(sourceFile, audioFile);

      if (!extracted) {
        // Без ffmpeg аудио не выделить — это ожидаемое ограничение среды,
        // а не сбой: фиксируем и идём дальше.
        return this.markStatus(
          mediaId,
          'UNAVAILABLE',
          'Не удалось извлечь аудиодорожку: ffmpeg недоступен или файл не содержит звука.',
        );
      }

      const result = await this.provider.transcribe(audioFile, {
        language: this.config.TRANSCRIPTION_LANGUAGE,
      });

      const unclearCount = result.segments.filter((segment) => segment.unclear).length;

      const transcript = await this.upsert(mediaId, {
        status: 'COMPLETED',
        fullText: result.fullText,
        language: result.language,
        segments: result.segments,
        unclearSegmentCount: unclearCount,
        provider: result.provider,
        durationSeconds: result.durationSeconds,
        error: null,
      });

      await this.ops.recordHistory({
        entityType: 'media',
        entityId: mediaId,
        stage: PIPELINE_STAGE.TRANSCRIPTION,
        status: 'OK',
        message: `Сегментов: ${result.segments.length}, неразборчивых: ${unclearCount}`,
        durationMs: Date.now() - started,
      });

      log.info({ mediaId, segments: result.segments.length, unclearCount }, 'Видео расшифровано');
      return transcript;
    } catch (error) {
      const message = (error as Error).message;
      log.warn({ err: error, mediaId }, 'Не удалось расшифровать видео');

      await this.ops.recordError({
        stage: PIPELINE_STAGE.TRANSCRIPTION,
        entityType: 'media',
        entityId: mediaId,
        message,
      });

      return this.markStatus(mediaId, 'FAILED', message);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  /** Транскрипции, относящиеся к публикациям события. */
  async forEvent(eventId: string): Promise<Transcript[]> {
    const rows = await this.db.many(
      `SELECT t.* FROM transcripts t
         JOIN media m ON m.id = t.media_id
         JOIN event_sources es ON es.source_post_id = m.source_post_id
        WHERE es.event_id = $1
        ORDER BY t.created_at`,
      [eventId],
    );
    return rows.map(mapTranscript);
  }

  private async markStatus(
    mediaId: string,
    status: Transcript['status'],
    error: string | null,
  ): Promise<Transcript> {
    log.debug({ mediaId, status, error }, 'Статус транскрипции обновлён');
    return this.upsert(mediaId, { status, error });
  }

  private async upsert(
    mediaId: string,
    patch: Partial<{
      status: Transcript['status'];
      fullText: string | null;
      language: string | null;
      segments: unknown[];
      unclearSegmentCount: number;
      provider: string | null;
      durationSeconds: number | null;
      error: string | null;
    }>,
  ): Promise<Transcript> {
    const row = await this.db.one(
      `INSERT INTO transcripts
         (media_id, status, full_text, language, segments, unclear_segment_count, provider, duration_seconds, error)
       VALUES ($1, COALESCE($2,'PENDING'), $3, $4, COALESCE($5::jsonb,'[]'::jsonb), COALESCE($6,0), $7, $8, $9)
       ON CONFLICT (media_id) DO UPDATE SET
         status                = COALESCE($2, transcripts.status),
         full_text             = COALESCE($3, transcripts.full_text),
         language              = COALESCE($4, transcripts.language),
         segments              = COALESCE($5::jsonb, transcripts.segments),
         unclear_segment_count = COALESCE($6, transcripts.unclear_segment_count),
         provider              = COALESCE($7, transcripts.provider),
         duration_seconds      = COALESCE($8, transcripts.duration_seconds),
         error                 = $9
       RETURNING *`,
      [
        mediaId,
        patch.status ?? null,
        patch.fullText ?? null,
        patch.language ?? null,
        patch.segments ? JSON.stringify(patch.segments) : null,
        patch.unclearSegmentCount ?? null,
        patch.provider ?? null,
        patch.durationSeconds ?? null,
        patch.error ?? null,
      ],
    );
    return mapTranscript(row);
  }
}
