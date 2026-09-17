import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config/env.js';

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
