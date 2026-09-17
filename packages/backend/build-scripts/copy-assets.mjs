/**
 * Копирование неисполняемых файлов в сборку.
 *
 * tsc переносит только результат компиляции TypeScript. Файлы миграций —
 * обычный SQL, и без этого шага они не попадают в dist: собранный сервер
 * падает при старте с ENOENT, потому что не находит каталог миграций.
 * Ошибка проявляется только на production-сборке, поэтому шаг вынесен в
 * явный скрипт, а не спрятан в конфигурацию.
 */
import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Каталоги, копируемые из src в dist как есть. */
const ASSET_DIRS = ['db/migrations'];

for (const relative of ASSET_DIRS) {
  const from = path.join(root, 'src', relative);
  const to = path.join(root, 'dist', relative);

  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true });

  const files = await readdir(to);
  process.stdout.write(`Скопировано в dist/${relative}: файлов ${files.length}\n`);
}
