import { SourceFetchError } from './types.js';

/**
 * HTTP-клиент для адаптеров источников.
 *
 * Общий для всех платформ: единый таймаут, ограничение размера ответа и
 * понятная классификация ошибок. Отдельно выделяются ошибки, которые имеет
 * смысл повторить (сеть, 5xx, 429), и те, которые повторять бессмысленно
 * (404, неверный токен) — от этого зависит поведение очереди.
 */

export interface HttpOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  maxBytes?: number;
  /** Сколько раз повторить при временной ошибке. */
  retries?: number;
}

const DEFAULT_TIMEOUT = 20_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/** Ошибки этих кодов повторять бессмысленно. */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 410]);

export async function httpGet(url: string, options: HttpOptions = {}): Promise<Response> {
  const retries = options.retries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          // Идентифицируемся честно: мониторинг не маскируется под браузер.
          'user-agent': 'NovorossiyskNewsMonitor/1.0 (private monitoring instance)',
          accept: 'application/json, text/html;q=0.9, */*;q=0.8',
          ...options.headers,
        },
        redirect: 'follow',
      });

      if (!response.ok) {
        const permanent = PERMANENT_STATUSES.has(response.status);
        const error = new SourceFetchError(
          `HTTP ${response.status} ${response.statusText} при запросе ${safeUrl(url)}`,
          !permanent,
        );
        if (permanent) throw error;
        lastError = error;
        // 429 и 5xx — ждём с увеличением паузы и пробуем ещё раз.
        if (attempt < retries) {
          await delay(retryDelayMs(response, attempt));
          continue;
        }
        throw error;
      }

      return response;
    } catch (error) {
      if (error instanceof SourceFetchError && !error.retriable) throw error;
      lastError = error;
      if (attempt < retries) {
        await delay(1000 * 2 ** attempt);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new SourceFetchError(
    `Не удалось выполнить запрос к ${safeUrl(url)}: ${(lastError as Error)?.message ?? 'неизвестная ошибка'}`,
    true,
    lastError,
  );
}

export async function httpGetJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
  const response = await httpGet(url, options);
  return (await response.json()) as T;
}

export async function httpGetText(url: string, options: HttpOptions = {}): Promise<string> {
  const response = await httpGet(url, options);
  return response.text();
}

/** Скачать бинарный файл с ограничением размера. */
export async function httpGetBuffer(
  url: string,
  options: HttpOptions = {},
): Promise<{ buffer: Buffer; contentType: string | null }> {
  const response = await httpGet(url, options);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new SourceFetchError(
      `Файл слишком большой: ${declared} байт при лимите ${maxBytes}`,
      false,
    );
  }

  const chunks: Buffer[] = [];
  let total = 0;

  if (!response.body) {
    throw new SourceFetchError('Пустой ответ при скачивании файла', true);
  }

  // Читаем потоком и обрываем, если размер превысил лимит: сервер мог
  // не прислать content-length.
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new SourceFetchError(`Превышен лимит размера файла (${maxBytes} байт)`, false);
    }
    chunks.push(Buffer.from(chunk));
  }

  return { buffer: Buffer.concat(chunks), contentType: response.headers.get('content-type') };
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60_000);
  }
  return Math.min(1000 * 2 ** attempt, 30_000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Убрать токен из URL перед записью в лог. */
export function safeUrl(url: string): string {
  return url
    .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot<TOKEN>')
    .replace(/access_token=[^&]+/g, 'access_token=<TOKEN>');
}
