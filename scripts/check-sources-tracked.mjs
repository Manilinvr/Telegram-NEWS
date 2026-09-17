/**
 * Проверка: все ли исходники попали в Git.
 *
 * Написана после реального отказа сборки. Правило `.gitignore` без
 * ведущего слэша («storage/») совпало с папкой исходников
 * packages/backend/src/modules/storage/. Локально сборка проходила —
 * файл лежал на диске, — а на чистом клоне падала: файла там не было.
 *
 * Такую ошибку нельзя заметить глазами: она видна только на машине,
 * которая клонирует репозиторий заново. Поэтому проверка выполняется
 * вместе с типами, до того как сборка уедет на хостинг.
 */
import { execFileSync } from 'node:child_process';

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|css|sql|json)$/;

// Каталоги, где лежит код. Шаблон вида `packages/*/src` git здесь
// не раскрывает, поэтому спрашиваем каталоги целиком и отбираем сами.
const ROOTS = ['packages', 'scripts', 'supabase'];

const IN_SOURCE_TREE = /^(packages\/[^/]+\/(src|tests)\/|scripts\/|supabase\/migrations\/)/;

// Файлы, которые лежат в дереве исходников, но не отслеживаются Git.
const untracked = git('ls-files', '--others', '--ignored', '--exclude-standard', '--', ...ROOTS)
  .filter((file) => !file.includes('node_modules/'))
  .filter((file) => IN_SOURCE_TREE.test(file))
  .filter((file) => SOURCE.test(file));

if (untracked.length > 0) {
  process.stderr.write(
    '\nИсходники не попадают в Git из-за правил .gitignore:\n\n' +
      untracked.map((file) => `  ${file}`).join('\n') +
      '\n\nЛокальная сборка пройдёт, а на чистом клоне — упадёт.\n' +
      'Проверьте правило: git check-ignore -v <файл>\n' +
      'Обычная причина — шаблон без ведущего слэша.\n\n',
  );
  process.exit(1);
}

process.stdout.write(`Исходники в Git: пропусков нет (проверено правил .gitignore)\n`);
