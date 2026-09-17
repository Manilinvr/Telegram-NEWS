/**
 * Сборка миграций в формате Supabase.
 *
 * Источник правды один — `packages/backend/src/db/migrations/*.sql`. Эти
 * файлы содержат секции `-- +migrate Up` и `-- +migrate Down` для
 * собственного раннера. Supabase (CLI и интеграция с GitHub) применяет
 * файл целиком, поэтому секцию Down нужно отрезать: иначе таблицы будут
 * созданы и тут же удалены — именно так выглядит ошибка
 * «relation ... does not exist» на следующем файле.
 *
 * Каталог `supabase/migrations` собирается скриптом и НЕ редактируется
 * вручную: правки вносятся в исходные миграции, после чего каталог
 * пересобирается. Так две копии схемы не могут разойтись.
 *
 * Запуск: npm run build:supabase
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceDir = path.join(root, 'packages/backend/src/db/migrations');
const targetDir = path.join(root, 'supabase/migrations');

const UP_MARKER = '-- +migrate Up';
const DOWN_MARKER = '-- +migrate Down';

/**
 * Версия файла для Supabase.
 *
 * Формат — 14-значная метка времени. Значения синтетические и
 * детерминированные: они обязаны быть стабильными между пересборками,
 * иначе Supabase сочтёт уже применённые миграции новыми и попытается
 * применить их повторно.
 */
function versionFor(index) {
  return `202601010000${String(index).padStart(2, '0')}`;
}

const files = (await readdir(sourceDir)).filter((name) => name.endsWith('.sql')).sort();

if (files.length === 0) {
  throw new Error(`В каталоге ${sourceDir} не найдено миграций`);
}

await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });

let index = 0;
for (const filename of files) {
  index += 1;

  const raw = await readFile(path.join(sourceDir, filename), 'utf8');
  const upStart = raw.indexOf(UP_MARKER);
  if (upStart === -1) {
    throw new Error(`В файле ${filename} нет секции "${UP_MARKER}"`);
  }

  const downStart = raw.indexOf(DOWN_MARKER);
  const header = raw.slice(0, upStart).trim();
  const body = (downStart === -1
    ? raw.slice(upStart + UP_MARKER.length)
    : raw.slice(upStart + UP_MARKER.length, downStart)
  ).trim();

  if (body.length === 0) {
    throw new Error(`В файле ${filename} секция Up пуста`);
  }
  // Защита от ошибки, ради которой скрипт и существует.
  if (body.includes(DOWN_MARKER) || /^\s*DROP\s+TABLE/im.test(body)) {
    throw new Error(`В секции Up файла ${filename} остались удаляющие операции`);
  }

  // `001_extensions.sql` → `extensions`
  const name = filename.replace(/^\d+_/, '').replace(/\.sql$/, '');
  const target = path.join(targetDir, `${versionFor(index)}_${name}.sql`);

  const content = [
    '-- ВНИМАНИЕ: файл создаётся автоматически. Не редактируйте его.',
    `-- Источник: packages/backend/src/db/migrations/${filename}`,
    '-- Пересборка: npm run build:supabase',
    '',
    header,
    '',
    body,
    '',
  ].join('\n');

  await writeFile(target, content, 'utf8');
  process.stdout.write(`  ${filename} → supabase/migrations/${path.basename(target)}\n`);
}

process.stdout.write(`\nГотово: ${index} миграций собрано в supabase/migrations/\n`);
