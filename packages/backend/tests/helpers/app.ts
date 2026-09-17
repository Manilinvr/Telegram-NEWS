import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import type { Database } from '../../src/db/pool.js';
import { buildServer } from '../../src/http/server.js';
import { hashPassword } from '../../src/lib/crypto.js';
import { CategoriesRepository } from '../../src/repositories/categories.js';
import { UsersRepository } from '../../src/repositories/users.js';
import { getTestDb, resetDb } from './db.js';

export const TEST_PASSWORD = 'test-owner-password-2026';

export interface TestContext {
  app: FastifyInstance;
  db: Database;
  config: AppConfig;
}

/** Поднять приложение ровно в той конфигурации, что и в продакшене. */
export async function createTestApp(overrides: NodeJS.ProcessEnv = {}): Promise<TestContext> {
  const db = await getTestDb();
  const config = loadConfig({
    ...process.env,
    // Лимиты частоты запросов проверяются отдельным тестом с собственным
    // экземпляром приложения. В общем наборе они подняты: все запросы
    // приходят с одного адреса, и штатный лимит входа отсекал бы
    // последующие тесты, проверяющие совсем другое.
    RATE_LIMIT_MAX: '10000',
    AUTH_RATE_LIMIT_MAX: '1000',
    ...overrides,
  });
  const app = await buildServer(config, db);
  await app.ready();
  return { app, db, config };
}

export async function seedOwner(db: Database): Promise<{ id: string; email: string }> {
  const users = new UsersRepository(db);
  const user = await users.create({
    email: 'owner@example.com',
    passwordHash: await hashPassword(TEST_PASSWORD),
    displayName: 'Владелец',
    role: 'OWNER',
  });
  return { id: user.id, email: user.email };
}

export async function seedCategories(db: Database): Promise<void> {
  await new CategoriesRepository(db).seedDefaults();
}

/** Выполнить вход и вернуть заголовки для последующих запросов. */
export async function login(
  app: FastifyInstance,
  email = 'owner@example.com',
  password = TEST_PASSWORD,
): Promise<{ cookie: string; csrfToken: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Вход не выполнен: ${response.statusCode} ${response.body}`);
  }

  const cookies = response.cookies as Array<{ name: string; value: string }>;
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const body = response.json() as { csrfToken: string };
  return { cookie, csrfToken: body.csrfToken };
}

export async function resetTestDb(db: Database): Promise<void> {
  await resetDb(db);
}
