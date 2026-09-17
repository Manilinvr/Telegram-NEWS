import type { Source } from '@nnm/shared';
import type {
  FetchOptions,
  FetchResult,
  FetchedPost,
  SourceAdapter,
} from '../../src/modules/ingestion/types.js';

/**
 * Адаптер-заглушка для тестов.
 *
 * Позволяет прогнать весь pipeline на заранее заданных публикациях, не
 * обращаясь к внешним сервисам: тесты остаются детерминированными и не
 * зависят от доступности Telegram или VK.
 */
export class MockSourceAdapter implements SourceAdapter {
  readonly type = 'TELEGRAM' as const;
  readonly mode = 'mock';

  private queue: FetchedPost[] = [];
  private failure: Error | null = null;

  constructor(posts: FetchedPost[] = []) {
    this.queue = [...posts];
  }

  /** Задать публикации, которые вернёт следующий опрос. */
  setPosts(posts: FetchedPost[]): void {
    this.queue = [...posts];
  }

  /** Заставить адаптер завершиться ошибкой — проверка изоляции сбоев. */
  failWith(error: Error | null): void {
    this.failure = error;
  }

  isConfigured(): boolean {
    return true;
  }

  unavailableReason(): null {
    return null;
  }

  async fetch(_source: Source, options: FetchOptions): Promise<FetchResult> {
    if (this.failure) throw this.failure;

    const posts = this.queue.slice(0, options.limit);
    this.queue = this.queue.slice(posts.length);

    return {
      posts,
      lastExternalId: posts.at(-1)?.externalId ?? options.sinceExternalId,
    };
  }

  async verify(): Promise<{ ok: true; title?: string }> {
    return { ok: true, title: 'Тестовый источник' };
  }
}

/** Удобный конструктор тестовой публикации. */
export function makePost(input: {
  id: string;
  text: string;
  minutesAgo?: number;
  media?: FetchedPost['media'];
  isForward?: boolean;
}): FetchedPost {
  return {
    externalId: input.id,
    url: `https://t.me/test_channel/${input.id}`,
    postedAt: new Date(Date.now() - (input.minutesAgo ?? 0) * 60_000),
    text: input.text,
    isForward: input.isForward ?? false,
    forwardFrom: null,
    media: input.media ?? [],
    metadata: { test: true },
  };
}
