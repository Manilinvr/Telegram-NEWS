import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { loadConfig } from '../../src/config/env.js';
import { AiProcessor } from '../../src/modules/ai/processor.js';
import { resolveCategorySlug } from '../../src/modules/pipeline/category-slug.js';

/**
 * Подключение модели проверяется отдельно от разбора.
 *
 * Причина в том, что неудачное подключение НЕ ломает систему: разбор
 * уходит на правила, и установка с опечаткой в ключе внешне выглядит
 * исправной. Ошибка обнаруживается только здесь и в проверке связи.
 */

const base = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  SESSION_SECRET: 'x'.repeat(48),
  CSRF_SECRET: 'y'.repeat(48),
};

describe('Состояние подключения модели', () => {
  it('mock: причина названа словами, а не флагом', () => {
    const processor = new AiProcessor(loadConfig({ ...base }), []);
    expect(processor.unavailableReason()).toMatch(/mock/);
  });

  it('openai-compatible с адресом считается настроенным', () => {
    const config = loadConfig({
      ...base,
      AI_PROVIDER: 'openai-compatible',
      AI_BASE_URL: 'https://api.deepseek.com/v1',
      AI_API_KEY: 'sk-test',
      AI_MODEL: 'deepseek-chat',
    });
    // Прежняя проверка спрашивала только ключ Anthropic, из-за чего
    // подключённый DeepSeek показывался в диагностике ненастроенным.
    expect(new AiProcessor(config, []).unavailableReason()).toBeNull();
  });

  it('anthropic без ключа настроенным не считается', () => {
    const processor = new AiProcessor(loadConfig({ ...base }), []);
    expect(processor.unavailableReason()).not.toBeNull();
  });

  it('проверка связи возвращает ответ службы, а не общий отказ', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Authentication Fails' } }));
    });
    await new Promise<void>((r) => server.listen(4715, '127.0.0.1', () => r()));

    try {
      const processor = new AiProcessor(
        loadConfig({
          ...base,
          AI_PROVIDER: 'openai-compatible',
          AI_BASE_URL: 'http://127.0.0.1:4715',
          AI_API_KEY: 'sk-wrong',
          AI_MODEL: 'deepseek-chat',
        }),
        [],
      );
      const result = await processor.check();
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/Authentication Fails/);
      expect(result.model).toBe('deepseek-chat');
    } finally {
      server.close();
    }
  });

  it('проверка связи подтверждает рабочую службу', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'готово' } }] }));
    });
    await new Promise<void>((r) => server.listen(4716, '127.0.0.1', () => r()));

    try {
      const processor = new AiProcessor(
        loadConfig({
          ...base,
          AI_PROVIDER: 'openai-compatible',
          AI_BASE_URL: 'http://127.0.0.1:4716',
          AI_MODEL: 'deepseek-chat',
        }),
        [],
      );
      await expect(processor.check()).resolves.toMatchObject({ ok: true, model: 'deepseek-chat' });
    } finally {
      server.close();
    }
  });

  it('в режиме mock проверка не ходит в сеть и объясняет почему', async () => {
    const result = await new AiProcessor(loadConfig({ ...base }), []).check();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/mock/);
  });
});

describe('Категория из разбора приводится к справочнику', () => {
  const categories = [
    { slug: 'incident', title: 'Происшествия' },
    { slug: 'other', title: 'Прочее' },
  ];

  it('известный slug остаётся как есть', () => {
    expect(resolveCategorySlug('incident', categories)).toBe('incident');
  });

  it('регистр и пробелы не мешают', () => {
    expect(resolveCategorySlug('  Incident ', categories)).toBe('incident');
  });

  it('название категории принимается наравне со slug', () => {
    expect(resolveCategorySlug('Происшествия', categories)).toBe('incident');
  });

  it('придуманная моделью категория заменяется на other', () => {
    // Иначе запись падала с нарушением внешнего ключа
    // source_posts.category_slug, и публикация терялась.
    expect(resolveCategorySlug('катастрофы', categories)).toBe('other');
  });

  it('пустое значение заменяется на other', () => {
    expect(resolveCategorySlug(null, categories)).toBe('other');
  });

  it('пустой справочник даёт null, а не несуществующий slug', () => {
    expect(resolveCategorySlug('incident', [])).toBeNull();
  });
});
