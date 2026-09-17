import { spawn } from 'node:child_process';
import { childLogger } from '../../lib/logger.js';

const log = childLogger({ module: 'ffmpeg' });

/**
 * Обёртки над ffmpeg/ffprobe.
 *
 * Оба инструмента необязательны: если их нет в системе, видео всё равно
 * сохраняется, событие создаётся, а транскрипция помечается как
 * недоступная (ТЗ §24). Ошибка здесь не должна останавливать pipeline.
 */

export interface MediaProbe {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  format: string | null;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    // Ограничиваем накопление вывода: повреждённый файл может заставить
    // ffmpeg писать предупреждения бесконечно.
    const LIMIT = 1024 * 1024;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command}: превышено время выполнения (${timeoutMs} мс)`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < LIMIT) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < LIMIT) stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export class FfmpegTools {
  constructor(
    private readonly ffmpegPath = 'ffmpeg',
    private readonly ffprobePath = 'ffprobe',
  ) {}

  private availability: boolean | null = null;

  /** Есть ли ffmpeg в системе. Результат кэшируется на время жизни процесса. */
  async isAvailable(): Promise<boolean> {
    if (this.availability !== null) return this.availability;
    try {
      const result = await run(this.ffprobePath, ['-version'], 10_000);
      this.availability = result.code === 0;
    } catch {
      this.availability = false;
    }
    if (!this.availability) {
      log.warn(
        'ffmpeg/ffprobe не найдены: длительность видео и транскрипция будут недоступны. ' +
          'Установите ffmpeg или задайте FFMPEG_PATH/FFPROBE_PATH.',
      );
    }
    return this.availability;
  }

  /** Определить параметры медиафайла. Возвращает null, если ffprobe недоступен. */
  async probe(filePath: string): Promise<MediaProbe | null> {
    if (!(await this.isAvailable())) return null;

    try {
      const result = await run(
        this.ffprobePath,
        [
          '-v', 'error',
          '-print_format', 'json',
          '-show_format',
          '-show_streams',
          filePath,
        ],
        60_000,
      );
      if (result.code !== 0) return null;

      const parsed = JSON.parse(result.stdout) as {
        format?: { duration?: string; format_name?: string };
        streams?: Array<{
          codec_type?: string;
          width?: number;
          height?: number;
          duration?: string;
        }>;
      };

      const streams = parsed.streams ?? [];
      const video = streams.find((s) => s.codec_type === 'video');
      const duration = Number(parsed.format?.duration ?? video?.duration ?? NaN);

      return {
        durationSeconds: Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : null,
        width: video?.width ?? null,
        height: video?.height ?? null,
        hasAudio: streams.some((s) => s.codec_type === 'audio'),
        format: parsed.format?.format_name ?? null,
      };
    } catch (error) {
      log.warn({ err: error, filePath }, 'Не удалось определить параметры медиафайла');
      return null;
    }
  }

  /**
   * Извлечь аудиодорожку в формате, пригодном для распознавания речи:
   * моно, 16 кГц — это то, что ожидают модели семейства Whisper.
   */
  async extractAudio(inputPath: string, outputPath: string): Promise<boolean> {
    if (!(await this.isAvailable())) return false;

    try {
      const result = await run(
        this.ffmpegPath,
        [
          '-y',
          '-i', inputPath,
          '-vn',
          '-ac', '1',
          '-ar', '16000',
          '-c:a', 'pcm_s16le',
          outputPath,
        ],
        300_000,
      );
      return result.code === 0;
    } catch (error) {
      log.warn({ err: error, inputPath }, 'Не удалось извлечь аудиодорожку');
      return false;
    }
  }

  /** Кадр из видео для превью в ленте. */
  async extractThumbnail(inputPath: string, outputPath: string, atSecond = 1): Promise<boolean> {
    if (!(await this.isAvailable())) return false;
    try {
      const result = await run(
        this.ffmpegPath,
        ['-y', '-ss', String(atSecond), '-i', inputPath, '-frames:v', '1', '-q:v', '3', outputPath],
        60_000,
      );
      return result.code === 0;
    } catch {
      return false;
    }
  }
}
