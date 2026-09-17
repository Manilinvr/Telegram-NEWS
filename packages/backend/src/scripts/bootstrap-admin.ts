/**
 * Первоначальное создание учётной записи владельца (ТЗ §21).
 *
 * Пароль НЕ хранится в коде, README, SQL и не коммитится в репозиторий.
 * Он либо берётся из BOOTSTRAP_ADMIN_PASSWORD (для автоматизированного
 * развёртывания через secret manager), либо генерируется и печатается
 * в консоль ОДИН раз.
 *
 * Скрипт идемпотентен: повторный запуск не пересоздаёт владельца и не
 * сбрасывает существующий пароль.
 */
import { getConfig } from '../config/env.js';
import { createDatabase } from '../db/pool.js';
import { bootstrapOwner } from '../modules/auth/bootstrap.js';

const config = getConfig();
const db = createDatabase(config);

try {
  const result = await bootstrapOwner(db, config, { allowGenerate: true });

  process.stdout.write(`\n${result.message}\n  email: ${result.email}\n`);

  if (result.generatedPassword) {
    process.stdout.write(
      '\n  ВРЕМЕННЫЙ ПАРОЛЬ (показывается один раз, сохраните его сейчас):\n' +
        `\n      ${result.generatedPassword}\n\n` +
        '  При первом входе система потребует сменить пароль.\n' +
        '  Этот пароль нигде не сохранён в открытом виде.\n\n',
    );
  } else if (result.created) {
    process.stdout.write('  Пароль взят из BOOTSTRAP_ADMIN_PASSWORD.\n\n');
  }

  await db.close();
  process.exit(0);
} catch (error) {
  process.stderr.write(`Не удалось создать владельца: ${(error as Error).message}\n`);
  await db.close();
  process.exit(1);
}
