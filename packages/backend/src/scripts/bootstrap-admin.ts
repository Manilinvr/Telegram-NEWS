/**
 * Первоначальное создание учётной записи владельца (ТЗ §21).
 *
 * Пароль НЕ хранится в коде, README, SQL и не коммитится в репозиторий.
 * Он либо берётся из переменной окружения BOOTSTRAP_ADMIN_PASSWORD (для
 * автоматизированного развёртывания через secret manager), либо
 * генерируется и печатается в консоль ОДИН раз.
 *
 * Скрипт идемпотентен: повторный запуск не пересоздаёт владельца и не
 * сбрасывает существующий пароль.
 */
import { getConfig } from '../config/env.js';
import { createDatabase } from '../db/pool.js';
import { generateReadablePassword, hashPassword } from '../lib/crypto.js';
import { validatePasswordPolicy } from '../modules/auth/service.js';
import { UsersRepository } from '../repositories/users.js';

const config = getConfig();
const db = createDatabase(config);

try {
  const users = new UsersRepository(db);
  const email = config.BOOTSTRAP_ADMIN_EMAIL;

  const existing = await users.findByEmailWithSecrets(email);
  if (existing) {
    process.stdout.write(
      `Владелец «${email}» уже существует — изменений не внесено.\n` +
        'Для сброса пароля используйте смену пароля в интерфейсе или отдельную процедуру восстановления.\n',
    );
    await db.close();
    process.exit(0);
  }

  const provided = config.BOOTSTRAP_ADMIN_PASSWORD;
  const generated = provided ? null : generateReadablePassword(24);
  const password = provided ?? (generated as string);

  const policyError = validatePasswordPolicy(password);
  if (policyError) {
    process.stderr.write(`Пароль не соответствует политике: ${policyError}\n`);
    await db.close();
    process.exit(1);
  }

  const user = await users.create({
    email,
    passwordHash: await hashPassword(password),
    displayName: 'Владелец',
    role: 'OWNER',
    // Если пароль сгенерирован автоматически, его нужно сменить при
    // первом входе; переданный из secret manager считается постоянным.
    mustChangePassword: generated !== null,
  });

  process.stdout.write(`\nУчётная запись владельца создана.\n  email: ${user.email}\n`);

  if (generated) {
    process.stdout.write(
      '\n  ВРЕМЕННЫЙ ПАРОЛЬ (показывается один раз, сохраните его сейчас):\n' +
        `\n      ${generated}\n\n` +
        '  При первом входе система потребует сменить пароль.\n' +
        '  Этот пароль нигде не сохранён в открытом виде.\n\n',
    );
  } else {
    process.stdout.write('  Пароль взят из BOOTSTRAP_ADMIN_PASSWORD.\n\n');
  }

  await db.close();
  process.exit(0);
} catch (error) {
  process.stderr.write(`Не удалось создать владельца: ${(error as Error).message}\n`);
  await db.close();
  process.exit(1);
}
