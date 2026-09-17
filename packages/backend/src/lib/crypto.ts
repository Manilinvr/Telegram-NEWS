import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { promisify } from 'node:util';

/**
 * promisify теряет перегрузку scrypt с параметрами стоимости, поэтому тип
 * задаётся явно — иначе N/r/p пришлось бы передавать в обход типизации.
 */
const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: ScryptOptions,
) => Promise<Buffer>;

/**
 * Криптографические примитивы аутентификации.
 *
 * Для паролей используется scrypt — memory-hard функция, входящая в состав
 * Node.js. Она не требует нативной сборки (в отличие от argon2), что делает
 * развёртывание предсказуемым, и при выбранных параметрах соответствует
 * рекомендациям OWASP. Параметры хранятся внутри самой строки хэша, поэтому
 * их можно ужесточить в будущем, не ломая уже существующие пароли.
 */

/** N — фактор стоимости. 2^16 ≈ 64 МБ памяти и ~100 мс на проверку. */
const SCRYPT_N = 1 << 16;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
/** Лимит памяти должен превышать 128 * N * r, иначе Node откажет. */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/**
 * Захэшировать пароль.
 * Результат самодостаточен: `scrypt$N$r$p$соль$хэш`.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });

  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Проверить пароль.
 *
 * Сравнение всегда выполняется за постоянное время: при неверном формате
 * хэша или отсутствии пользователя вызывающий код всё равно обязан
 * потратить сопоставимое время, иначе по задержке ответа можно определить,
 * существует ли учётная запись.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [
    string, string, string, string, string, string,
  ];

  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = Buffer.from(saltRaw, 'base64');
  const expected = Buffer.from(hashRaw, 'base64');

  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }

  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * Фиктивная проверка пароля.
 *
 * Вызывается, когда пользователь не найден или заблокирован: затраты
 * времени остаются такими же, как при реальной проверке, и по времени
 * ответа нельзя перечислить существующие учётные записи.
 */
export async function fakePasswordVerification(password: string): Promise<void> {
  await verifyPassword(password, DUMMY_HASH);
}

/** Заранее посчитанный хэш заведомо недостижимого пароля. */
const DUMMY_HASH = [
  'scrypt',
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
  Buffer.alloc(16, 7).toString('base64'),
  Buffer.alloc(SCRYPT_KEYLEN, 11).toString('base64'),
].join('$');

/**
 * Сгенерировать секрет сессии.
 * 256 бит энтропии — перебор невозможен, поэтому в БД достаточно хранить
 * быстрый SHA-256 от токена, а не медленный KDF.
 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Хэш токена для хранения в БД. Утечка дампа не даёт угнать сессию. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Сравнение строк за постоянное время (для CSRF-токенов и т. п.). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Всё равно выполняем сравнение, чтобы не выдать длину по времени.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Контрольная сумма содержимого — для дедупликации медиа. */
export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export { randomUUID };

/**
 * Сгенерировать пароль, удобный для однократной передачи владельцу.
 * Алфавит без символов, которые легко перепутать (0/O, 1/l/I).
 */
export function generateReadablePassword(length = 24): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[(bytes[i] as number) % alphabet.length];
  }
  return out;
}
