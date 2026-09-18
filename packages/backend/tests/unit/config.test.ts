import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config/env.js';
import { buildSslOptions } from '../../src/db/pool.js';
import { AdapterRegistry } from '../../src/modules/ingestion/registry.js';
import { OpenAiCompatibleProvider } from '../../src/modules/ai/openai-compatible.js';

/**
 * Конфигурация — единственное место, где установка соприкасается
 * с платформой развёртывания. Ошибки здесь проявляются не падением
 * тестов, а «сайт не открывается», поэтому проверяются явно.
 */

const base = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  SESSION_SECRET: 'x'.repeat(48),
  CSRF_SECRET: 'y'.repeat(48),
};

describe('loadConfig: порт', () => {
  it('по умолчанию слушает 4000', () => {
    expect(loadConfig({ ...base }).API_PORT).toBe(4000);
  });

  it('берёт PORT, назначенный платформой (Render, Railway, Fly)', () => {
    // Без этого платформа не дождётся ответа на своём порту
    // и пометит развёртывание упавшим.
    expect(loadConfig({ ...base, PORT: '10000' }).API_PORT).toBe(10000);
  });

  it('API_PORT важнее PORT, если задан явно', () => {
    expect(loadConfig({ ...base, PORT: '10000', API_PORT: '4100' }).API_PORT).toBe(4100);
  });
});

describe('loadConfig: защита production', () => {
  it('запрещает незащищённую сессионную куку в production', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' }),
    ).toThrow(/COOKIE_SECURE/);
  });

  it('требует DATABASE_URL', () => {
    const { DATABASE_URL: _omit, ...withoutDb } = base;
    expect(() => loadConfig(withoutDb)).toThrow(/DATABASE_URL/);
  });
});

describe('buildSslOptions: подключение к базе по TLS', () => {
  const withSsl = (extra: Record<string, string> = {}) =>
    loadConfig({ ...base, DATABASE_SSL: 'true', ...extra });

  it('без SSL параметров TLS нет', () => {
    expect(buildSslOptions(loadConfig({ ...base }))).toBeUndefined();
  });

  it('по умолчанию проверяет подлинность сервера', () => {
    expect(buildSslOptions(withSsl())).toEqual({ rejectUnauthorized: true });
  });

  it('принимает сертификат как содержимое PEM', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    expect(buildSslOptions(withSsl({ DATABASE_SSL_CA: pem }))).toEqual({
      ca: pem,
      rejectUnauthorized: true,
    });
  });

  it('разворачивает \\n, как их передают панели хостингов', () => {
    const raw = '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----';
    const result = buildSslOptions(withSsl({ DATABASE_SSL_CA: raw }));
    expect(result?.ca).toBe('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----');
    expect(result?.rejectUnauthorized).toBe(true);
  });

  it('читает сертификат из файла', () => {
    const file = path.join(tmpdir(), `ca-${Date.now()}.crt`);
    writeFileSync(file, '-----BEGIN CERTIFICATE-----\nFROMFILE\n-----END CERTIFICATE-----');
    try {
      expect(buildSslOptions(withSsl({ DATABASE_SSL_CA: file }))?.ca).toContain('FROMFILE');
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('объясняет, что делать, если файл сертификата не найден', () => {
    expect(() => buildSslOptions(withSsl({ DATABASE_SSL_CA: '/нет/такого.crt' }))).toThrow(
      /DATABASE_SSL_CA/,
    );
  });

  it('позволяет явно отключить проверку подлинности', () => {
    expect(buildSslOptions(withSsl({ DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' }))).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('сертификат важнее отключённой проверки', () => {
    // Иначе одна забытая переменная тихо обесценила бы сертификат.
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    expect(
      buildSslOptions(
        withSsl({ DATABASE_SSL_CA: pem, DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' }),
      ),
    ).toEqual({ ca: pem, rejectUnauthorized: true });
  });
});

describe('Режимы сбора Telegram', () => {
  // Расхождение между документацией и списком допустимых значений
  // не видно ни типами, ни сборкой: оно проявляется только на
  // развёртывании, отказом запуска. Поэтому проверяется явно.
  it('принимает public-preview — режим без ключей, описанный в документации', () => {
    const config = loadConfig({ ...base, TELEGRAM_INGEST_MODE: 'public-preview' });
    expect(config.TELEGRAM_INGEST_MODE).toBe('public-preview');
  });

  it('для public-preview не требует ни токена, ни api-ключей', () => {
    expect(() => loadConfig({ ...base, TELEGRAM_INGEST_MODE: 'public-preview' })).not.toThrow();
  });

  it('в режиме public-preview адаптер Telegram зарегистрирован и готов', () => {
    const registry = new AdapterRegistry(
      loadConfig({ ...base, TELEGRAM_INGEST_MODE: 'public-preview' }),
    );
    const adapter = registry.get('TELEGRAM');
    expect(adapter).not.toBeNull();
    expect(adapter?.mode).toBe('public-preview');
    expect(adapter?.isConfigured()).toBe(true);
  });

  it('по умолчанию Telegram-источники отключены', () => {
    expect(new AdapterRegistry(loadConfig({ ...base })).get('TELEGRAM')).toBeNull();
  });

  it('режим bot без токена отвергается с понятным сообщением', () => {
    expect(() => loadConfig({ ...base, TELEGRAM_INGEST_MODE: 'bot' })).toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
  });
});

describe('Бесплатный разбор новостей через службу с интерфейсом OpenAI', () => {
  it('провайдер openai-compatible требует адрес службы', () => {
    expect(() => loadConfig({ ...base, AI_PROVIDER: 'openai-compatible' })).toThrow(/AI_BASE_URL/);
  });

  it('с адресом конфигурация принимается', () => {
    const config = loadConfig({
      ...base,
      AI_PROVIDER: 'openai-compatible',
      AI_BASE_URL: 'https://api.groq.com/openai/v1',
      AI_MODEL: 'llama-3.3-70b-versatile',
    });
    expect(config.AI_PROVIDER).toBe('openai-compatible');
    expect(config.AI_BASE_URL).toBe('https://api.groq.com/openai/v1');
  });

  it('обращается к службе и возвращает её ответ', async () => {
    const seen: { url?: string; auth?: string; body?: Record<string, unknown> } = {};
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        seen.url = req.url ?? '';
        seen.auth = req.headers.authorization;
        seen.body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(4713, '127.0.0.1', () => r()));

    try {
      const provider = new OpenAiCompatibleProvider(
        loadConfig({
          ...base,
          AI_PROVIDER: 'openai-compatible',
          AI_BASE_URL: 'http://127.0.0.1:4713',
          AI_API_KEY: 'test-key',
          AI_MODEL: 'free-model',
        }),
      );
      expect(provider.isAvailable()).toBe(true);

      const text = await provider.complete({ system: 'ты редактор', user: 'перепиши' });
      expect(text).toBe('{"ok":true}');
      expect(seen.url).toBe('/chat/completions');
      expect(seen.auth).toBe('Bearer test-key');
      expect(seen.body?.model).toBe('free-model');
    } finally {
      server.close();
    }
  });

  it('объясняет отказ службы, а не прячет его за кодом', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Rate limit exceeded' } }));
    });
    await new Promise<void>((r) => server.listen(4714, '127.0.0.1', () => r()));

    try {
      const provider = new OpenAiCompatibleProvider(
        loadConfig({ ...base, AI_PROVIDER: 'openai-compatible', AI_BASE_URL: 'http://127.0.0.1:4714' }),
      );
      await expect(provider.complete({ system: 's', user: 'u' })).rejects.toThrow(
        /429.*Rate limit exceeded/s,
      );
    } finally {
      server.close();
    }
  });
});
