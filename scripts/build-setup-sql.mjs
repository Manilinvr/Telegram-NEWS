/**
 * Сборка единого установочного SQL-файла.
 *
 * Применять восемь файлов по очереди — источник ошибок: достаточно
 * перепутать порядок или пропустить один, и появляется «relation … does
 * not exist». Этот скрипт склеивает их в один файл, который вставляется
 * в SQL-редактор Supabase ОДИН раз.
 *
 * Файл выполняется целиком: PostgreSQL оборачивает одиночный запрос в
 * транзакцию, поэтому при ошибке не остаётся наполовину созданной схемы.
 *
 * Собирается из supabase/migrations, то есть из того же источника, что и
 * обычные миграции. Пересборка: npm run build:setup-sql
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceDir = path.join(root, 'supabase/migrations');
const migrationSourceDir = path.join(root, 'packages/backend/src/db/migrations');
const targetFile = path.join(root, 'supabase/setup.sql');

const files = (await readdir(sourceDir)).filter((f) => f.endsWith('.sql')).sort();
if (files.length === 0) {
  throw new Error('Сначала выполните npm run build:supabase');
}

const parts = [
  '-- =====================================================================',
  '-- УСТАНОВКА СХЕМЫ: система мониторинга новостей Новороссийска',
  '--',
  '-- Файл создаётся автоматически из supabase/migrations.',
  '-- Не редактируйте его: правьте исходные миграции и выполните',
  '-- `npm run build:setup-sql`.',
  '--',
  '-- Как применить: откройте SQL Editor в Supabase, вставьте файл',
  '-- ЦЕЛИКОМ и выполните один раз. На вопрос про Row Level Security',
  '-- отвечайте «Run without RLS» — RLS включает сама эта установка,',
  '-- в самом конце, и без политик, что означает запрет доступа извне.',
  '-- =====================================================================',
  '',
  '-- Защита от повторного запуска: иначе PostgreSQL выдал бы неочевидную',
  '-- ошибку «relation already exists» на середине файла.',
  'DO $install_guard$',
  'BEGIN',
  "  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'events') THEN",
  '    RAISE EXCEPTION',
  "      'Схема уже установлена: таблица events существует. Повторный запуск не требуется. "
    + "Чтобы установить заново, сначала очистите схему public.';",
  '  END IF;',
  'END',
  '$install_guard$;',
  '',
  '-- Журнал миграций создаётся сразу, до самой схемы: миграция 008',
  '-- включает RLS обходом всех таблиц схемы public, и этот журнал',
  '-- должен попасть под ту же защиту, а не остаться открытым.',
  'CREATE TABLE IF NOT EXISTS schema_migrations (',
  '  id          text PRIMARY KEY,',
  '  checksum    text NOT NULL,',
  '  applied_at  timestamptz NOT NULL DEFAULT now()',
  ');',
  '',
];

for (const filename of files) {
  const raw = await readFile(path.join(sourceDir, filename), 'utf8');

  // Убираем служебную шапку сгенерированного файла — она относится
  // к отдельному файлу и в общей установке только мешает читать.
  const body = raw
    .split('\n')
    .filter((line) => !line.startsWith('-- ВНИМАНИЕ: файл создаётся автоматически'))
    .filter((line) => !line.startsWith('-- Источник: packages/backend'))
    .filter((line) => !line.startsWith('-- Пересборка:'))
    .join('\n')
    .trim();

  parts.push(
    '',
    '-- ---------------------------------------------------------------------',
    `-- ${filename}`,
    '-- ---------------------------------------------------------------------',
    '',
    body,
    '',
  );
}

// Отмечаем миграции применёнными.
//
// Без этого сервер при старте считает базу пустой и пытается создать
// уже существующие таблицы — падая с «relation "users" already exists».
// Идентификатор и контрольная сумма считаются ровно так же, как это
// делает раннер миграций (sha256 исходного файла, первые 16 символов),
// поэтому база, установленная этим файлом, неотличима от базы,
// поднятой обычной командой `npm run migrate`.
const sourceFiles = (await readdir(migrationSourceDir)).filter((f) => f.endsWith('.sql')).sort();
if (sourceFiles.length !== files.length) {
  throw new Error(
    `Миграций в исходниках ${sourceFiles.length}, а сгенерированных ${files.length}. ` +
      'Выполните npm run build:supabase.',
  );
}

const records = [];
for (const filename of sourceFiles) {
  const raw = await readFile(path.join(migrationSourceDir, filename), 'utf8');
  const checksum = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  records.push(`  ('${filename.replace(/\.sql$/, '')}', '${checksum}')`);
}

parts.push(
  '',
  '-- ---------------------------------------------------------------------',
  '-- Журнал миграций',
  '-- ---------------------------------------------------------------------',
  '',
  'INSERT INTO schema_migrations (id, checksum) VALUES',
  records.join(',\n') + '',
  'ON CONFLICT (id) DO NOTHING;',
  '',
);

parts.push(
  '',
  '-- =====================================================================',
  '-- Установка завершена.',
  '--',
  '-- Проверьте результат:',
  "--   select count(*) from pg_tables where schemaname = 'public';",
  '--     ожидается 21 (20 таблиц схемы + журнал миграций)',
  "--   select count(*) filter (where rowsecurity) from pg_tables where schemaname = 'public';",
  '--     должно совпадать с количеством таблиц',
  "--   select count(*) from pg_policies where schemaname = 'public';",
  '--     ожидается 0 — это и есть запрет доступа через публичный API',
  '-- =====================================================================',
  '',
);

await mkdir(path.dirname(targetFile), { recursive: true });
await writeFile(targetFile, parts.join('\n'), 'utf8');

const size = (parts.join('\n').length / 1024).toFixed(1);
process.stdout.write(`Готово: supabase/setup.sql (${files.length} миграций, ${size} КБ)\n`);
