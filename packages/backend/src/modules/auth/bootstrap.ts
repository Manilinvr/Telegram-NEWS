import type { AppConfig } from '../../config/env.js';
import type { Database } from '../../db/pool.js';
import { generateReadablePassword, hashPassword } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { UsersRepository } from '../../repositories/users.js';
import { validatePasswordPolicy } from './service.js';

export interface BootstrapResult {
  created: boolean;
  email: string;
  /** Пароль возвращается ТОЛЬКО если был сгенерирован здесь. */
  generatedPassword: string | null;
  message: string;
}

/**
 * Создание учётной записи владельца (ТЗ §21).
 *
 * Идемпотентно: существующая запись не пересоздаётся и пароль не
 * сбрасывается. Пароль никогда не сохраняется в открытом виде — либо
 * приходит из окружения, либо генерируется и показывается один раз.
 */
export async function bootstrapOwner(
  db: Database,
  config: AppConfig,
  options: { allowGenerate: boolean },
): Promise<BootstrapResult> {
  const users = new UsersRepository(db);
  const email = config.BOOTSTRAP_ADMIN_EMAIL;

  const existing = await users.findByEmailWithSecrets(email);
  if (existing) {
    return {
      created: false,
      email,
      generatedPassword: null,
      message: `Владелец «${email}» уже существует — изменений не внесено.`,
    };
  }

  const provided = config.BOOTSTRAP_ADMIN_PASSWORD;

  if (!provided && !options.allowGenerate) {
    return {
      created: false,
      email,
      generatedPassword: null,
      message:
        'Владелец не создан: не задан BOOTSTRAP_ADMIN_PASSWORD. ' +
        'Задайте переменную либо выполните `npm run bootstrap:admin`, ' +
        'чтобы пароль был сгенерирован и показан.',
    };
  }

  const generated = provided ? null : generateReadablePassword(24);
  const password = provided ?? (generated as string);

  const policyError = validatePasswordPolicy(password);
  if (policyError) {
    // Длина указывается намеренно: без неё невозможно отличить
    // «задан короткий пароль» от «переменная окружения не обновилась».
    // Сам пароль в журнал не попадает.
    const source = provided
      ? `значение BOOTSTRAP_ADMIN_PASSWORD длиной ${password.length} симв.`
      : 'сгенерированный пароль';
    throw new Error(`Пароль не соответствует политике (${source}): ${policyError}`);
  }

  await users.create({
    email,
    passwordHash: await hashPassword(password),
    displayName: 'Владелец',
    role: 'OWNER',
    // Сгенерированный пароль временный и подлежит смене при первом входе.
    mustChangePassword: generated !== null,
  });

  logger.info({ email }, 'Создана учётная запись владельца');

  return {
    created: true,
    email,
    generatedPassword: generated,
    message: `Учётная запись владельца «${email}» создана.`,
  };
}
