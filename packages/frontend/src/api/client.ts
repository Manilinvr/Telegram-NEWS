import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@nnm/shared';

/**
 * Клиент API.
 *
 * Сессия живёт в httpOnly-cookie и в JavaScript недоступна — это защита на
 * случай XSS. Поэтому запросы всегда идут с `credentials: 'include'`, а для
 * изменяющих методов из отдельной, читаемой cookie берётся CSRF-токен.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Сессия истекла или отсутствует. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** Материал заблокирован проверкой лексики. */
  get isProfanityBlocked(): boolean {
    return this.code === 'PROFANITY_BLOCKED';
  }
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  query?: Record<string, string | number | boolean | undefined | null | string[]>;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const url = new URL(`/api${path}`, window.location.origin);

  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined || value === null || value === '') continue;
      // Массивы передаются одним параметром через запятую — так их
      // разбирает схема фильтров на сервере.
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
  }

  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  if (method !== 'GET') {
    const csrf = readCookie(CSRF_COOKIE_NAME);
    if (csrf) headers[CSRF_HEADER_NAME] = csrf;
  }

  const response = await fetch(url, {
    method,
    headers,
    // Без этого браузер не отправит cookie сессии.
    credentials: 'include',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? safeParse(text) : null;

  if (!response.ok) {
    const error = (payload ?? {}) as { error?: string; message?: string };
    throw new ApiError(
      response.status,
      error.error ?? 'UNKNOWN',
      error.message ?? `Запрос завершился с кодом ${response.status}`,
      payload,
    );
  }

  return payload as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query']) =>
    apiRequest<T>(path, { method: 'GET', ...(query ? { query } : {}) }),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
};
