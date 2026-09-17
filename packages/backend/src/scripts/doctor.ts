/**
 * Проверка готовности установки.
 *
 * Скрипт отвечает на вопрос «почему не работает» до того, как придётся
 * читать логи: проверяет конфигурацию, доступность базы, применённость
 * миграций, защиту данных, наличие владельца и состояние источников.
 *
 * Каждая проблема сопровождается конкретным действием, а не только
 * констатацией. Код возврата 1, если есть блокирующие проблемы.
 */
import { access } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, type AppConfig } from '../config/env.js';
import { createDatabase, type Database } from '../db/pool.js';

type Level = 'ok' | 'warn' | 'fail';

interface Check {
  level: Level;
  title: string;
  detail?: string;
  /** Что сделать, если проверка не пройдена. */
  action?: string;
}

const checks: Check[] = [];
const add = (check: Check) => checks.push(check);

const MARK: Record<Level, string> = { ok: '  ✓', warn: '  ⚠', fail: '  ✗' };

// --- 1. Конфигурация ---------------------------------------------------

let config: AppConfig;
try {
  config = loadConfig();
  add({ level: 'ok', title: 'Конфигурация прочитана' });
} catch (error) {
  process.stdout.write('\nПроверка установки\n\n');
  process.stdout.write(`  ✗ Конфигурация некорректна\n\n${(error as Error).message}\n\n`);
  process.exit(1);
}

const isProd = config.NODE_ENV === 'production';

if (!config.SESSION_SECRET || config.SESSION_SECRET.length < 32) {
  add({
    level: isProd ? 'fail' : 'warn',
    title: 'SESSION_SECRET не задан или короче 32 символов',
    action:
      'Сгенерируйте: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
  });
} else {
  add({ level: 'ok', title: 'SESSION_SECRET задан' });
}

if (!config.CSRF_SECRET || config.CSRF_SECRET.length < 32) {
  add({
    level: isProd ? 'fail' : 'warn',
    title: 'CSRF_SECRET не задан или короче 32 символов',
    action: 'Сгенерируйте так же, как SESSION_SECRET, но ДРУГОЕ значение.',
  });
} else if (config.CSRF_SECRET === config.SESSION_SECRET) {
  add({
    level: 'warn',
    title: 'CSRF_SECRET совпадает с SESSION_SECRET',
    action: 'Задайте разные значения: компрометация одного не должна раскрывать другое.',
  });
} else {
  add({ level: 'ok', title: 'CSRF_SECRET задан' });
}

if (isProd && !config.COOKIE_SECURE) {
  add({
    level: 'fail',
    title: 'COOKIE_SECURE выключен в production',
    action: 'Задайте COOKIE_SECURE=true — иначе cookie сессии уйдёт по незащищённому каналу.',
  });
}

// --- 2. База данных ----------------------------------------------------

let db: Database | null = null;
let dbReachable = false;

try {
  db = createDatabase(config);
  const row = await db.one<{ version: string }>('SELECT version() AS version');
  dbReachable = true;
  add({
    level: 'ok',
    title: 'База данных доступна',
    detail: String(row.version).split(',')[0],
  });
} catch (error) {
  const message = (error as Error).message;
  add({
    level: 'fail',
    title: 'База данных недоступна',
    detail: message,
    action: /self.signed|certificate/i.test(message)
      ? 'Похоже на проблему с сертификатом. Проверьте DATABASE_SSL.'
      : /password|authentication/i.test(message)
        ? 'Проверьте логин и пароль в DATABASE_URL.'
        : /ENOTFOUND|EAI_AGAIN/i.test(message)
          ? 'Адрес сервера не разрешается. Проверьте хост в DATABASE_URL.'
          : 'Проверьте DATABASE_URL. Для Supabase используйте session pooler (порт 5432).',
  });
}

if (db && dbReachable) {
  // --- 3. Схема --------------------------------------------------------
  const tables = await db.one<{ count: number }>(
    `SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'`,
  );
  const tableCount = Number(tables.count);

  if (tableCount === 0) {
    add({
      level: 'fail',
      title: 'Схема не установлена: таблиц нет',
      action:
        'Примените миграции: npm run migrate — либо вставьте supabase/setup.sql в SQL-редактор Supabase.',
    });
  } else if (tableCount < 20) {
    add({
      level: 'fail',
      title: `Схема установлена частично: таблиц ${tableCount}, ожидается не менее 20`,
      action: 'Примените недостающие миграции: npm run migrate',
    });
  } else {
    add({ level: 'ok', title: `Схема установлена: таблиц ${tableCount}` });
  }

  if (tableCount > 0) {
    // --- 4. Защита данных ----------------------------------------------
    const rls = await db.one<{ with_rls: number; total: number; policies: number }>(
      `SELECT
         count(*) FILTER (WHERE rowsecurity)::int AS with_rls,
         count(*)::int AS total,
         (SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public') AS policies
       FROM pg_tables WHERE schemaname = 'public'`,
    );

    const isSupabase = await db.one<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AS present`,
    );

    if (Number(rls.with_rls) < Number(rls.total)) {
      add({
        level: isSupabase.present ? 'fail' : 'warn',
        title: `RLS включён не везде: ${rls.with_rls} из ${rls.total}`,
        action: isSupabase.present
          ? 'Это Supabase: без RLS таблицы читаются через публичный API. Примените миграцию 008_hardening.'
          : 'Примените миграцию 008_hardening.',
      });
    } else {
      add({ level: 'ok', title: `Защита данных: RLS на всех ${rls.total} таблицах` });
    }

    if (Number(rls.policies) > 0 && isSupabase.present) {
      add({
        level: 'warn',
        title: `Найдено политик RLS: ${rls.policies}`,
        detail: 'Система рассчитана на работу без политик — это и есть запрет доступа извне.',
        action: 'Проверьте, что политики не открывают доступ ролям anon и authenticated.',
      });
    }

    // --- 5. Справочники и владелец -------------------------------------
    const categories = await db.one<{ count: number }>(
      'SELECT count(*)::int AS count FROM categories',
    );
    if (Number(categories.count) === 0) {
      add({
        level: 'fail',
        title: 'Категории не заполнены',
        action: 'Выполните: npm run seed',
      });
    } else {
      add({ level: 'ok', title: `Категорий: ${categories.count}` });
    }

    const owners = await db.one<{ count: number }>(
      `SELECT count(*)::int AS count FROM users WHERE role = 'OWNER'`,
    );
    if (Number(owners.count) === 0) {
      add({
        level: 'fail',
        title: 'Учётная запись владельца не создана — войти в панель невозможно',
        action:
          'Выполните: npm run bootstrap:admin — либо задайте BOOTSTRAP_ON_STARTUP=true и BOOTSTRAP_ADMIN_PASSWORD.',
      });
    } else {
      add({ level: 'ok', title: `Владелец создан (учётных записей: ${owners.count})` });
    }

    // --- 6. Источники и данные -----------------------------------------
    const sources = await db.one<{ total: number; active: number; failing: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE is_active)::int AS active,
              count(*) FILTER (WHERE health = 'FAILING')::int AS failing
         FROM sources`,
    );

    if (Number(sources.total) === 0) {
      add({
        level: 'warn',
        title: 'Источники не добавлены — лента будет пустой',
        action: 'Добавьте канал в разделе «Источники». См. docs/SETUP-SOURCES.md.',
      });
    } else {
      add({
        level: Number(sources.failing) > 0 ? 'warn' : 'ok',
        title: `Источников: ${sources.total} (активных ${sources.active}, с ошибками ${sources.failing})`,
        ...(Number(sources.failing) > 0
          ? { action: 'Откройте «Источники» и посмотрите причину сбоя у проблемных каналов.' }
          : {}),
      });
    }

    const errors = await db.one<{ count: number }>(
      'SELECT count(*)::int AS count FROM processing_errors WHERE NOT is_resolved',
    );
    if (Number(errors.count) > 0) {
      add({
        level: 'warn',
        title: `Нерешённых ошибок обработки: ${errors.count}`,
        action: 'Раздел «Аналитика» → «Ошибки обработки».',
      });
    }
  }
}

// --- 7. Интерфейс и внешние сервисы -------------------------------------

const frontendPath = path.resolve(config.rootDir, config.FRONTEND_DIST_PATH, 'index.html');
try {
  await access(frontendPath);
  add({ level: 'ok', title: 'Сборка интерфейса найдена — панель отдаётся этим же процессом' });
} catch {
  add({
    level: 'warn',
    title: 'Сборка интерфейса не найдена — процесс отдаёт только API',
    detail: frontendPath,
    action: 'Выполните: npm run build — либо разместите интерфейс отдельно.',
  });
}

add({
  level: config.AI_PROVIDER === 'mock' ? 'warn' : 'ok',
  title: `Разбор новостей: ${config.AI_PROVIDER === 'mock' ? 'по правилам (модель не подключена)' : `модель ${config.AI_MODEL}`}`,
  ...(config.AI_PROVIDER === 'mock'
    ? { action: 'Система работает, но качество черновиков ниже. Подключение — docs/SETUP-AI.md.' }
    : {}),
});

const telegramReady = Boolean(config.TELEGRAM_PUBLISH_BOT_TOKEN && config.TELEGRAM_PUBLISH_CHANNEL);
add({
  level: 'ok',
  title: config.TELEGRAM_PUBLISH_DRY_RUN
    ? 'Публикация в Telegram: сухой прогон (в канал ничего не уходит)'
    : telegramReady
      ? `Публикация в Telegram: включена, канал ${config.TELEGRAM_PUBLISH_CHANNEL}`
      : 'Публикация в Telegram: не настроена',
  ...(!config.TELEGRAM_PUBLISH_DRY_RUN && !telegramReady
    ? {
        action:
          'Сухой прогон выключен, но бот не настроен — реальная отправка завершится ошибкой. См. docs/SETUP-TELEGRAM.md.',
      }
    : {}),
});

if (config.TELEGRAM_INGEST_MODE === 'none' && !config.VK_ACCESS_TOKEN) {
  add({
    level: 'warn',
    title: 'Ни один тип источников не настроен',
    action: 'Задайте TELEGRAM_INGEST_MODE=public-preview либо VK_ACCESS_TOKEN.',
  });
}

// --- Вывод --------------------------------------------------------------

const failed = checks.filter((c) => c.level === 'fail');
const warned = checks.filter((c) => c.level === 'warn');

process.stdout.write('\nПроверка установки\n\n');

for (const check of checks) {
  process.stdout.write(`${MARK[check.level]} ${check.title}\n`);
  if (check.detail) process.stdout.write(`      ${check.detail}\n`);
  if (check.action && check.level !== 'ok') {
    process.stdout.write(`      → ${check.action}\n`);
  }
}

process.stdout.write('\n');

if (failed.length > 0) {
  process.stdout.write(
    `Блокирующих проблем: ${failed.length}. Система не заработает, пока они не устранены.\n\n`,
  );
} else if (warned.length > 0) {
  process.stdout.write(
    `Блокирующих проблем нет. Замечаний: ${warned.length} — система работоспособна.\n\n`,
  );
} else {
  process.stdout.write('Всё готово к работе.\n\n');
}

if (db) await db.close();
process.exit(failed.length > 0 ? 1 : 0);
