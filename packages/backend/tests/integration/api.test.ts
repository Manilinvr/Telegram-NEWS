import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../src/db/pool.js';
import { closeTestDb } from '../helpers/db.js';
import {
  createTestApp,
  login,
  resetTestDb,
  seedCategories,
  seedOwner,
  TEST_PASSWORD,
} from '../helpers/app.js';

/**
 * Тесты HTTP API.
 *
 * Приложение поднимается тем же кодом, что и в продакшене, включая плагины
 * безопасности: проверяется реальная конфигурация, а не упрощённая копия.
 */

let app: FastifyInstance;
let db: Database;

beforeAll(async () => {
  const ctx = await createTestApp();
  app = ctx.app;
  db = ctx.db;
});

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);
  await seedOwner(db);
  await seedCategories(db);
});

describe('Закрытость системы', () => {
  it.each([
    ['/api/feed'],
    ['/api/analytics/dashboard'],
    ['/api/sources'],
    ['/api/moderation'],
    ['/api/settings'],
    ['/api/diagnostics'],
    ['/api/audit'],
  ])('без авторизации %s недоступен', async (url) => {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(401);
  });

  it('проверка живости доступна без авторизации', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('регистрация новых пользователей не предусмотрена', async () => {
    // Маршрута регистрации нет: доступ только у заранее заведённого владельца.
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'intruder@example.com', password: 'whatever-long-pass' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('Вход и cookie сессии', () => {
  it('выдаёт httpOnly-cookie сессии и читаемый CSRF-токен', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@example.com', password: TEST_PASSWORD },
    });

    expect(response.statusCode).toBe(200);

    // Проверяем сырые заголовки: именно они уходят браузеру, и именно
    // в них видно фактический набор атрибутов cookie.
    const raw = response.headers['set-cookie'];
    const headers = Array.isArray(raw) ? raw : [String(raw)];

    const session = headers.find((h) => h.startsWith('nnm_session='));
    const csrf = headers.find((h) => h.startsWith('nnm_csrf='));

    expect(session).toBeDefined();
    expect(csrf).toBeDefined();

    // Cookie сессии недоступна скриптам, CSRF-токен — доступен намеренно.
    expect(session).toContain('HttpOnly');
    expect(csrf).not.toContain('HttpOnly');
    expect(session).toContain('SameSite=Lax');
    expect(session).toContain('Path=/');
  });

  it('отклоняет неверный пароль', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@example.com', password: 'wrong-password-value' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('после входа возвращает текущего пользователя', async () => {
    const { cookie } = await login(app);
    const response = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { user: { email: string } };
    expect(body.user.email).toBe('owner@example.com');
    expect(body.user).not.toHaveProperty('passwordHash');
  });

  it('после выхода сессия недействительна', async () => {
    const { cookie, csrfToken } = await login(app);
    await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });

    const response = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(response.statusCode).toBe(401);
  });
});

describe('Защита от CSRF', () => {
  it('изменяющий запрос без CSRF-токена отклоняется', async () => {
    const { cookie } = await login(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: { cookie },
      payload: { type: 'TELEGRAM', title: 'Тест', url: 'https://t.me/test', username: 'test' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'CSRF_FAILED' });
  });

  it('чужой CSRF-токен не подходит', async () => {
    const first = await login(app);
    const second = await login(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: { cookie: first.cookie, 'x-csrf-token': second.csrfToken },
      payload: { type: 'TELEGRAM', title: 'Тест', url: 'https://t.me/test', username: 'test' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('чтение не требует CSRF-токена', async () => {
    const { cookie } = await login(app);
    const response = await app.inject({ method: 'GET', url: '/api/feed', headers: { cookie } });
    expect(response.statusCode).toBe(200);
  });
});

describe('Заголовки безопасности', () => {
  it('ответ содержит защитные заголовки', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBeDefined();
    expect(String(response.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });
});

describe('Лента и фильтры', () => {
  it('возвращает пустую ленту на чистой базе', async () => {
    const { cookie } = await login(app);
    const response = await app.inject({ method: 'GET', url: '/api/feed', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: [], total: 0 });
  });

  it('отклоняет некорректные параметры фильтра', async () => {
    const { cookie } = await login(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/feed?confidenceMin=5&limit=999999',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR' });
  });

  it('принимает комбинацию фильтров', async () => {
    const { cookie } = await login(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/feed?period=24h&categories=dtp,fire&importance=HIGH,CRITICAL&hasPhoto=true&kind=events&sort=importance',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
  });

  it('не допускает SQL-инъекцию через поисковый запрос', async () => {
    const { cookie } = await login(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/feed?q=${encodeURIComponent("'; DROP TABLE events; --")}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    // Таблица должна остаться на месте: значения передаются параметрами.
    const check = await db.one('SELECT count(*)::int AS count FROM events');
    expect(Number(check.count)).toBe(0);
    const tables = await db.one(
      `SELECT count(*)::int AS count FROM pg_tables WHERE tablename = 'events'`,
    );
    expect(Number(tables.count)).toBe(1);
  });
});

describe('Аналитика', () => {
  it('отдаёт полный набор данных для главного экрана', async () => {
    const { cookie } = await login(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/analytics/dashboard',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('summary.sources.total');
    expect(body).toHaveProperty('timeseries');
    expect(body).toHaveProperty('categories');
    expect(body).toHaveProperty('moderationQueue');
    // Ряд строится по сетке интервалов, поэтому точки есть всегда.
    expect(Array.isArray(body.timeseries)).toBe(true);
    expect(body.timeseries.length).toBeGreaterThan(0);
  });
});

describe('Категории и настройки', () => {
  it('возвращает начальный набор категорий', async () => {
    const { cookie } = await login(app);
    const response = await app.inject({ method: 'GET', url: '/api/categories', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { categories: Array<{ slug: string }> };
    expect(body.categories.length).toBeGreaterThanOrEqual(14);
    expect(body.categories.map((c) => c.slug)).toContain('dtp');
    expect(body.categories.map((c) => c.slug)).toContain('other');
  });

  it('критичная настройка требует повторного ввода пароля', async () => {
    const { cookie, csrfToken } = await login(app);
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/profanity',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { value: { blockOnWarn: false, extraBlockWords: [], extraAllowWords: [] } },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'CONFIRMATION_REQUIRED' });
  });

  it('с подтверждением пароля настройка сохраняется', async () => {
    const { cookie, csrfToken } = await login(app);
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/profanity',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: {
        value: { blockOnWarn: true, extraBlockWords: ['запрещёнка'], extraAllowWords: [] },
        confirmPassword: TEST_PASSWORD,
      },
    });
    expect(response.statusCode).toBe(200);
  });

  it('в настройках фильтра нет возможности отключить проверку мата', async () => {
    const { cookie, csrfToken } = await login(app);
    // Попытка передать «выключатель» отклоняется схемой.
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/profanity',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: {
        value: { enabled: false, blockOnWarn: false },
        confirmPassword: TEST_PASSWORD,
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('проверяет произвольный текст фильтром', async () => {
    const { cookie, csrfToken } = await login(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/profanity/test',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { text: 'В Новороссийске прошёл фестиваль.' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ allowed: true });
  });
});

describe('Ограничение частоты запросов', () => {
  it('после серии попыток входа возвращает 429, а не внутреннюю ошибку', async () => {
    // Отдельный экземпляр приложения со штатным жёстким лимитом.
    const ctx = await createTestApp({ AUTH_RATE_LIMIT_MAX: '3', RATE_LIMIT_MAX: '100' });
    try {
      const attempt = () =>
        ctx.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: 'owner@example.com', password: 'deliberately-wrong' },
        });

      for (let i = 0; i < 3; i += 1) await attempt();
      const limited = await attempt();

      expect(limited.statusCode).toBe(429);
      const body = limited.json() as { error: string; message: string };
      expect(body.error).toBe('RATE_LIMITED');
      // Сообщение должно подсказывать, когда можно повторить.
      expect(body.message).toMatch(/Повторите через \d+ с\./);
    } finally {
      await ctx.app.close();
    }
  });
});

describe('Диагностика', () => {
  it('показывает фактическое состояние подсистем', async () => {
    const { cookie } = await login(app);
    const response = await app.inject({ method: 'GET', url: '/api/diagnostics', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('database.version');
    expect(body).toHaveProperty('adapters');
    expect(body).toHaveProperty('publishing.dryRun');
    expect(body).toHaveProperty('transcription.provider');
    // Автопубликация в MVP выключена.
    expect(body.autoPublishEnabled).toBe(false);
  });
});

describe('Источники', () => {
  it('отклоняет источник с некорректным URL', async () => {
    const { cookie, csrfToken } = await login(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { type: 'TELEGRAM', title: 'Тест', url: 'не-ссылка', username: 'test' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR' });
  });

  it('сообщает, что тип источника не настроен', async () => {
    const { cookie, csrfToken } = await login(app);
    // В тестовом окружении VK_ACCESS_TOKEN не задан.
    const response = await app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: { cookie, 'x-csrf-token': csrfToken },
      payload: { type: 'VK', title: 'Сообщество', url: 'https://vk.com/test', username: 'test' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'SOURCE_UNREACHABLE' });
  });
});
