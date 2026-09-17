import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { TranscriptSegment } from '@nnm/shared';
import type { AppConfig } from '../../config/env.js';
import { childLogger } from '../../lib/logger.js';

const log = childLogger({ module: 'transcription' });

/**
 * Распознавание речи в видео (ТЗ §9).
 *
 * Общее правило для всех провайдеров: неразборчивые фрагменты помечаются
 * как таковые, а НЕ додумываются. Лучше явный пропуск, чем правдоподобно
 * выглядящая выдумка в цитате очевидца.
 */

export interface TranscriptionResult {
  fullText: string;
  segments: TranscriptSegment[];
  language: string | null;
  durationSeconds: number | null;
  provider: string;
}

export interface TranscriptionProvider {
  readonly name: string;
  isAvailable(): boolean;
  unavailableReason(): string | null;
  /** Распознать речь из аудиофайла (WAV 16 кГц моно). */
  transcribe(audioPath: string, options: { language?: string }): Promise<TranscriptionResult>;
}

/** Метка неразборчивого фрагмента — единая для всех провайдеров. */
export const UNCLEAR_MARKER = '[неразборчиво]';

/** Провайдер отключён: транскрипция не выполняется, событие не блокируется. */
export class NoopTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'none';
  isAvailable(): boolean {
    return false;
  }
  unavailableReason(): string {
    return 'Транскрипция отключена (TRANSCRIPTION_PROVIDER=none).';
  }
  async transcribe(): Promise<TranscriptionResult> {
    throw new Error('Провайдер транскрипции отключён');
  }
}

/**
 * HTTP-провайдер, совместимый с OpenAI Audio API.
 *
 * Подходит как для собственного развёртывания faster-whisper/whisper.cpp
 * с HTTP-обёрткой, так и для совместимых сервисов. Адрес задаётся
 * конфигурацией, поэтому данные можно не выпускать за пределы контура.
 */
export class OpenAiCompatibleTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'openai-compatible';

  constructor(private readonly config: AppConfig) {}

  isAvailable(): boolean {
    return Boolean(this.config.TRANSCRIPTION_API_URL);
  }

  unavailableReason(): string | null {
    return this.isAvailable() ? null : 'Не задан TRANSCRIPTION_API_URL.';
  }

  async transcribe(audioPath: string, options: { language?: string }): Promise<TranscriptionResult> {
    const buffer = await fs.readFile(audioPath);
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'audio/wav' }), path.basename(audioPath));
    form.append('model', this.config.TRANSCRIPTION_MODEL);
    form.append('language', options.language ?? this.config.TRANSCRIPTION_LANGUAGE);
    // Формат с таймкодами: без него сегменты и время получить нельзя.
    form.append('response_format', 'verbose_json');

    const response = await fetch(this.config.TRANSCRIPTION_API_URL as string, {
      method: 'POST',
      headers: this.config.TRANSCRIPTION_API_KEY
        ? { authorization: `Bearer ${this.config.TRANSCRIPTION_API_KEY}` }
        : {},
      body: form,
      signal: AbortSignal.timeout(600_000),
    });

    if (!response.ok) {
      throw new Error(`Сервис транскрипции вернул HTTP ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as {
      text?: string;
      language?: string;
      duration?: number;
      segments?: Array<{
        start: number;
        end: number;
        text: string;
        no_speech_prob?: number;
        avg_logprob?: number;
      }>;
    };

    const segments: TranscriptSegment[] = (body.segments ?? []).map((segment) => {
      // Низкая уверенность модели — признак неразборчивого фрагмента.
      const unclear =
        (segment.no_speech_prob ?? 0) > 0.6 || (segment.avg_logprob ?? 0) < -1.0;
      return {
        start: segment.start,
        end: segment.end,
        text: unclear ? UNCLEAR_MARKER : segment.text.trim(),
        speaker: null,
        confidence:
          segment.avg_logprob === undefined
            ? null
            : Math.max(0, Math.min(1, 1 + segment.avg_logprob)),
        unclear,
      };
    });

    return {
      fullText: segments.length > 0 ? segments.map((s) => s.text).join(' ') : (body.text ?? '').trim(),
      segments,
      language: body.language ?? options.language ?? null,
      durationSeconds: body.duration ?? null,
      provider: this.name,
    };
  }
}

/**
 * Локальный whisper.cpp.
 *
 * Полностью офлайновый вариант: аудио не покидает сервер. Требует
 * собранного бинарника и файла модели.
 */
export class WhisperCppTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'whisper-cpp';

  constructor(private readonly config: AppConfig) {}

  isAvailable(): boolean {
    return Boolean(this.config.WHISPER_CPP_BIN && this.config.WHISPER_CPP_MODEL);
  }

  unavailableReason(): string | null {
    return this.isAvailable() ? null : 'Не заданы WHISPER_CPP_BIN и WHISPER_CPP_MODEL.';
  }

  async transcribe(audioPath: string, options: { language?: string }): Promise<TranscriptionResult> {
    const outputPrefix = `${audioPath}.out`;

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        this.config.WHISPER_CPP_BIN as string,
        [
          '-m', this.config.WHISPER_CPP_MODEL as string,
          '-f', audioPath,
          '-l', options.language ?? this.config.TRANSCRIPTION_LANGUAGE,
          '-oj',              // JSON с таймкодами
          '-of', outputPrefix,
          '-np',              // без служебного вывода
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );

      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 100_000) stderr += chunk.toString();
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('whisper.cpp: превышено время выполнения'));
      }, 900_000);

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`whisper.cpp завершился с кодом ${code}: ${stderr.slice(0, 500)}`));
      });
    });

    const jsonPath = `${outputPrefix}.json`;
    const raw = await fs.readFile(jsonPath, 'utf8');
    await fs.rm(jsonPath, { force: true });

    const parsed = JSON.parse(raw) as {
      transcription?: Array<{ timestamps?: { from: string; to: string }; offsets?: { from: number; to: number }; text: string }>;
    };

    const segments: TranscriptSegment[] = (parsed.transcription ?? []).map((item) => {
      const text = item.text.trim();
      // whisper.cpp помечает неразборчивое пустым текстом или скобками.
      const unclear = text === '' || /^\[.*\]$/.test(text) || text === '(...)';
      return {
        start: (item.offsets?.from ?? 0) / 1000,
        end: (item.offsets?.to ?? 0) / 1000,
        text: unclear ? UNCLEAR_MARKER : text,
        speaker: null,
        confidence: null,
        unclear,
      };
    });

    return {
      fullText: segments.map((s) => s.text).join(' ').trim(),
      segments,
      language: options.language ?? this.config.TRANSCRIPTION_LANGUAGE,
      durationSeconds: segments.at(-1)?.end ?? null,
      provider: this.name,
    };
  }
}

/**
 * Детерминированная заглушка для тестов и приёмки.
 * Позволяет проверить весь путь «видео → транскрипция → цитаты в карточке»
 * без установки моделей распознавания.
 */
export class MockTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'mock';
  isAvailable(): boolean {
    return true;
  }
  unavailableReason(): null {
    return null;
  }

  async transcribe(audioPath: string): Promise<TranscriptionResult> {
    const segments: TranscriptSegment[] = [
      {
        start: 0,
        end: 6,
        text: 'Сейчас здесь, на улице Видова, произошло дорожно-транспортное происшествие.',
        speaker: 'SPEAKER_1',
        confidence: 0.94,
        unclear: false,
      },
      {
        start: 6,
        end: 11,
        text: 'Два автомобиля столкнулись, движение по полосе затруднено.',
        speaker: 'SPEAKER_1',
        confidence: 0.91,
        unclear: false,
      },
      {
        start: 11,
        end: 14,
        text: UNCLEAR_MARKER,
        speaker: null,
        confidence: 0.2,
        unclear: true,
      },
      {
        start: 14,
        end: 20,
        text: 'На месте уже работают сотрудники ДПС, пострадавших, кажется, нет.',
        speaker: 'SPEAKER_2',
        confidence: 0.88,
        unclear: false,
      },
    ];

    log.debug({ audioPath }, 'Использована заглушка транскрипции');

    return {
      fullText: segments.map((s) => s.text).join(' '),
      segments,
      language: 'ru',
      durationSeconds: 20,
      provider: this.name,
    };
  }
}

export function createTranscriptionProvider(config: AppConfig): TranscriptionProvider {
  switch (config.TRANSCRIPTION_PROVIDER) {
    case 'whisper-cpp':
      return new WhisperCppTranscriptionProvider(config);
    case 'openai-compatible':
      return new OpenAiCompatibleTranscriptionProvider(config);
    case 'mock':
      return new MockTranscriptionProvider();
    default:
      return new NoopTranscriptionProvider();
  }
}
