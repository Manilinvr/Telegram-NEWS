import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { loadConfig } from '../../src/config/env.js';
import { OpenAiCompatibleProvider } from '../../src/modules/ai/openai-compatible.js';

/**
 * Отказы службы модели объясняются словами.
 *
 * Причина в том, что настройки модели живут на хостинге, а отказ ничего
 * не ломает: система продолжает работать по правилам. Единственное, что
 * отличает «работает» от «работает без модели» — этот текст, поэтому он
 * должен называть и причину, и действие.
 */

const base = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  SESSION_SECRET: 'x'.repeat(48),
  CSRF_SECRET: 'y'.repeat(48),
};

async function withServer(
  port: number,
  respond: (res: Parameters<Parameters<typeof createServer>[0]>[1]) => void,
  run: (provider: OpenAiCompatibleProvider) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((_req, res) => respond(res));
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  try {
    await run(
      new OpenAiCompatibleProvider(
        loadConfig({
          ...base,
          AI_PROVIDER: 'openai-compatible',
          AI_BASE_URL: `http://127.0.0.1:${port}`,
          AI_MODEL: 'test-model',
        }),
      ),
    );
  } finally {
    server.close();
  }
}

describe('Объяснение отказов службы модели', () => {
  it('исчерпанный дневной лимит назван лимитом, а не кодом 429', async () => {
    const reset = Date.now() + 3 * 60 * 60_000;
    await withServer(
      4721,
      (res) => {
        res.writeHead(429, {
          'content-type': 'application/json',
          'x-ratelimit-limit': '50',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(reset),
        });
        res.end(
          JSON.stringify({
            error: { message: 'Rate limit exceeded: free-models-per-day', code: 429 },
          }),
        );
      },
      async (provider) => {
        const error = await provider.complete({ system: 's', user: 'u' }).catch((e) => e as Error);

        expect(error.message).toMatch(/Исчерпан лимит запросов/);
        expect(error.message).toMatch(/50 в сутки/);
        // Названо и время обновления лимита: без него непонятно, ждать
        // час или до завтра.
        expect(error.message).toMatch(/Лимит обновится/);
        expect(error.message).toMatch(/разбор идёт по правилам/);
      },
    );
  });

  it('нулевой баланс назван балансом', async () => {
    await withServer(
      4722,
      (res) => {
        res.writeHead(402, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Insufficient Balance' } }));
      },
      async (provider) => {
        const error = await provider.complete({ system: 's', user: 'u' }).catch((e) => e as Error);
        expect(error.message).toMatch(/Недостаточно средств/);
        expect(error.message).toMatch(/Insufficient Balance/);
      },
    );
  });

  it('отказ по ключу указывает на переменную, которую надо проверить', async () => {
    await withServer(
      4723,
      (res) => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'No auth credentials found' } }));
      },
      async (provider) => {
        const error = await provider.complete({ system: 's', user: 'u' }).catch((e) => e as Error);
        expect(error.message).toMatch(/AI_API_KEY/);
      },
    );
  });

  it('404 подсказывает про модель и адрес до /chat/completions', async () => {
    await withServer(
      4724,
      (res) => {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'No endpoints found' } }));
      },
      async (provider) => {
        const error = await provider.complete({ system: 's', user: 'u' }).catch((e) => e as Error);
        expect(error.message).toMatch(/AI_MODEL/);
        expect(error.message).toMatch(/AI_BASE_URL/);
      },
    );
  });

  it('незнакомый отказ показывается как есть, без придуманного объяснения', async () => {
    await withServer(
      4725,
      (res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Internal provider error' } }));
      },
      async (provider) => {
        const error = await provider.complete({ system: 's', user: 'u' }).catch((e) => e as Error);
        expect(error.message).toMatch(/HTTP 500/);
        expect(error.message).toMatch(/Internal provider error/);
      },
    );
  });
});
