import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Загрузка и строгая валидация конфигурации.
 *
 * Принципы:
 *  - секреты приходят ТОЛЬКО из окружения, значений по умолчанию у них нет;
 *  - в production отсутствие критичного секрета — фатальная ошибка старта,
 *    а не «тихий» фолбэк на небезопасное значение;
 *  - конфигурация валидируется один раз при старте процесса.
 */

const rootDir = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

// В тестах .env не подхватываем, чтобы окружение было воспроизводимым.
if (process.env.NODE_ENV !== 'test') {
  loadDotenv({ path: path.join(rootDir, '.env') });
}

const bool = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? defaultValue : v === 'true' || v === '1'));

const int = (defaultValue: number) =>
  z.coerce.number().int().optional().transform((v) => v ?? defaultValue);

const num = (defaultValue: number) =>
  z.coerce.number().optional().transform((v) => v ?? defaultValue);

/** Пустая строка трактуется как «не задано». */
const optionalStr = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

/**
 * Модель по умолчанию — от Anthropic. Значение вынесено в константу,
 * чтобы проверка конфигурации могла отличить «оставлено по умолчанию»
 * от осознанно выбранного названия.
 */
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    LOG_PRETTY: bool(false),

    API_HOST: z.string().default('0.0.0.0'),
    API_PORT: int(4000),
    PUBLIC_WEB_ORIGIN: z.string().default('http://localhost:5173'),
    TRUST_PROXY: bool(false),
    /**
     * Путь к собранному интерфейсу относительно корня проекта.
     * Если сборки нет, процесс отдаёт только API.
     */
    FRONTEND_DIST_PATH: z.string().default('packages/frontend/dist'),
    /**
     * Запускать ли воркер внутри процесса API.
     *
     * Для личной установки с десятком источников это разумно: один
     * процесс вместо двух. При росте нагрузки воркер выносится отдельно,
     * чтобы транскрипция и обращения к модели не конкурировали
     * с обслуживанием интерфейса.
     */
    RUN_WORKER_IN_API: bool(false),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL обязателен'),
    DATABASE_POOL_MAX: int(10),
    DATABASE_SSL: bool(false),
    /**
     * Корневой сертификат для проверки подлинности сервера БД.
     *
     * Пулер Supabase предъявляет собственную цепочку, которой нет в
     * списке доверенных у Node, — без этого сертификата подключение
     * обрывается с SELF_SIGNED_CERT_IN_CHAIN. Сертификат скачивается в
     * панели Supabase: Settings → Database → SSL Configuration.
     *
     * Принимается как содержимое PEM, так и путь к файлу.
     */
    DATABASE_SSL_CA: optionalStr,
    /**
     * Проверять ли подлинность сервера БД.
     *
     * Выключение оставляет шифрование, но перестаёт подтверждать, что на
     * том конце именно ваша база. Это запасной путь для случая, когда
     * сертификат получить не удалось; правильное решение —
     * DATABASE_SSL_CA.
     */
    DATABASE_SSL_REJECT_UNAUTHORIZED: bool(true),
    /**
     * Лимит времени запроса, мс. 0 отключает его вместе с
     * idle_in_transaction_session_timeout — нужно для пулеров в режиме
     * транзакций, отклоняющих эти параметры при подключении.
     */
    DATABASE_STATEMENT_TIMEOUT_MS: int(30_000),
    /**
     * Применять ли миграции при старте API.
     *
     * Отключается, когда схемой управляет внешний механизм — например,
     * интеграция Supabase с GitHub, которая применяет миграции сама и
     * ведёт собственный учёт. Иначе раннер попытается создать уже
     * существующие таблицы, и приложение не запустится.
     */
    MIGRATE_ON_STARTUP: bool(true),

    SESSION_SECRET: optionalStr,
    CSRF_SECRET: optionalStr,
    SESSION_TTL_MINUTES: int(720),
    SESSION_IDLE_TIMEOUT_MINUTES: int(120),
    COOKIE_SECURE: bool(false),
    COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
    COOKIE_DOMAIN: optionalStr,

    /**
     * Требовать ли повторный ввод пароля при изменении критичных
     * настроек (публикация, безопасность, фильтр лексики, дедупликация).
     *
     * По умолчанию требуется: в общей редакции сессия может остаться
     * открытой на чужом устройстве, и подтверждение — единственное, что
     * отделяет случайного человека от настройки публикации в канал.
     *
     * Личной установке с одним владельцем это мешает, не добавляя
     * защиты: отключается значением false. Вход, права и запись в журнал
     * действий остаются в любом случае.
     */
    SETTINGS_REQUIRE_PASSWORD: bool(true),

    AUTH_MAX_FAILED_ATTEMPTS: int(5),
    AUTH_LOCKOUT_MINUTES: int(15),
    RATE_LIMIT_MAX: int(300),
    RATE_LIMIT_WINDOW_MINUTES: int(1),
    AUTH_RATE_LIMIT_MAX: int(10),

    BOOTSTRAP_ADMIN_EMAIL: z.string().default('efimenkodaniil151@gmail.ru'),
    BOOTSTRAP_ADMIN_PASSWORD: optionalStr,
    /**
     * Создавать владельца при старте, если его ещё нет.
     *
     * Нужно для хостингов, где неудобно выполнять разовые команды.
     * Требует заданного BOOTSTRAP_ADMIN_PASSWORD. Действие идемпотентно:
     * существующая учётная запись не пересоздаётся и пароль не
     * сбрасывается. После первого входа переменную с паролем следует
     * удалить из окружения.
     */
    BOOTSTRAP_ON_STARTUP: bool(false),

    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_PATH: z.string().default('./storage/media'),
    MEDIA_MAX_FILE_MB: int(200),
    MEDIA_ALLOWED_MIME: z
      .string()
      .default(
        'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/ogg,audio/mp4',
      ),

    S3_ENDPOINT: optionalStr,
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().default('nnm-media'),
    S3_ACCESS_KEY_ID: optionalStr,
    S3_SECRET_ACCESS_KEY: optionalStr,
    S3_FORCE_PATH_STYLE: bool(true),

    WORKER_CONCURRENCY: int(4),
    WORKER_POLL_INTERVAL_MS: int(750),
    WORKER_MAX_ATTEMPTS: int(5),
    SOURCE_POLL_INTERVAL_SECONDS: int(60),

    /**
     * Способ чтения Telegram-каналов.
     *
     *  • public-preview — публичная страница t.me/s/<канал>, без ключей;
     *  • bot — бот, добавленный в канал администратором (нужен токен);
     *  • mtproto — пользовательский клиент (не реализован, см. LIMITATIONS);
     *  • none — Telegram-источники отключены.
     *
     * Значение public-preview обязано быть в списке: адаптер для него
     * реализован, и без него документированный режим не запускался.
     */
    TELEGRAM_INGEST_MODE: z.enum(['bot', 'mtproto', 'public-preview', 'none']).default('none'),
    TELEGRAM_BOT_TOKEN: optionalStr,
    TELEGRAM_API_ID: optionalStr,
    TELEGRAM_API_HASH: optionalStr,
    TELEGRAM_SESSION_STRING: optionalStr,

    TELEGRAM_PUBLISH_BOT_TOKEN: optionalStr,
    TELEGRAM_PUBLISH_CHANNEL: optionalStr,
    TELEGRAM_PUBLISH_DRY_RUN: bool(true),

    VK_ACCESS_TOKEN: optionalStr,
    VK_API_VERSION: z.string().default('5.199'),

    /**
     * Откуда берётся разбор новостей.
     *
     *  • mock — по правилам, без модели: текст источника очищается, но
     *    не переписывается;
     *  • anthropic — модель Anthropic;
     *  • openai-compatible — любая служба с интерфейсом OpenAI, включая
     *    бесплатные тарифы и локальные модели. Адрес задаётся в
     *    AI_BASE_URL, название модели — в AI_MODEL.
     */
    AI_PROVIDER: z.enum(['anthropic', 'openai-compatible', 'mock']).default('mock'),
    ANTHROPIC_API_KEY: optionalStr,
    /** Адрес службы с интерфейсом OpenAI, до /chat/completions. */
    AI_BASE_URL: optionalStr,
    /** Ключ этой службы. Локальной модели ключ обычно не нужен. */
    AI_API_KEY: optionalStr,
    AI_MODEL: z.string().default(DEFAULT_ANTHROPIC_MODEL),
    AI_MAX_OUTPUT_TOKENS: int(4096),
    AI_TIMEOUT_MS: int(60_000),
    AI_TEMPERATURE: num(0.2),

    EMBEDDING_PROVIDER: z.enum(['local', 'voyage']).default('local'),
    EMBEDDING_DIMENSIONS: int(512),
    VOYAGE_API_KEY: optionalStr,
    VOYAGE_MODEL: z.string().default('voyage-3'),

    TRANSCRIPTION_PROVIDER: z
      .enum(['none', 'whisper-cpp', 'openai-compatible', 'mock'])
      .default('none'),
    WHISPER_CPP_BIN: optionalStr,
    WHISPER_CPP_MODEL: optionalStr,
    TRANSCRIPTION_API_URL: optionalStr,
    TRANSCRIPTION_API_KEY: optionalStr,
    TRANSCRIPTION_MODEL: z.string().default('whisper-1'),
    TRANSCRIPTION_LANGUAGE: z.string().default('ru'),
    FFMPEG_PATH: optionalStr,
    FFPROBE_PATH: optionalStr,
    TRANSCRIPTION_MAX_DURATION_SECONDS: int(900),

    DEDUP_TIME_WINDOW_HOURS: int(36),
    DEDUP_MERGE_THRESHOLD: num(0.78),
    DEDUP_REVIEW_THRESHOLD: num(0.62),


    BACKUP_DIR: z.string().default('./backups'),
    BACKUP_RETENTION_DAYS: int(14),
  })
  .superRefine((value, ctx) => {
    const isProd = value.NODE_ENV === 'production';

    // В production секреты обязаны быть заданы и быть достаточно длинными.
    if (isProd) {
      for (const key of ['SESSION_SECRET', 'CSRF_SECRET'] as const) {
        const secret = value[key];
        if (!secret || secret.length < 32) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} обязателен в production и должен быть не короче 32 символов. Сгенерируйте: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`,
          });
        }
      }
      if (!value.COOKIE_SECURE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['COOKIE_SECURE'],
          message: 'COOKIE_SECURE обязан быть true в production (требуется HTTPS).',
        });
      }
    }

    if (value.STORAGE_DRIVER === 's3') {
      if (!value.S3_ACCESS_KEY_ID || !value.S3_SECRET_ACCESS_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['S3_ACCESS_KEY_ID'],
          message: 'Для STORAGE_DRIVER=s3 нужны S3_ACCESS_KEY_ID и S3_SECRET_ACCESS_KEY.',
        });
      }
    }

    if (value.AI_PROVIDER === 'anthropic' && !value.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ANTHROPIC_API_KEY'],
        message: 'Для AI_PROVIDER=anthropic нужен ANTHROPIC_API_KEY.',
      });
    }

    if (value.EMBEDDING_PROVIDER === 'voyage' && !value.VOYAGE_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['VOYAGE_API_KEY'],
        message: 'Для EMBEDDING_PROVIDER=voyage нужен VOYAGE_API_KEY.',
      });
    }

    // Название модели по умолчанию — от Anthropic, и другой службе оно
    // ничего не говорит: запрос отклоняется с «model not found», а система
    // молча уходит на разбор по правилам. Поэтому название требуется явно.
    if (value.AI_PROVIDER === 'openai-compatible' && value.AI_MODEL === DEFAULT_ANTHROPIC_MODEL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AI_MODEL'],
        message:
          'Для AI_PROVIDER=openai-compatible укажите AI_MODEL — название модели в выбранной службе, например deepseek-chat.',
      });
    }

    if (value.AI_PROVIDER === 'openai-compatible' && !value.AI_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AI_BASE_URL'],
        message:
          'Для AI_PROVIDER=openai-compatible нужен AI_BASE_URL — адрес службы, например https://api.groq.com/openai/v1.',
      });
    }

    // Адрес службы проверяется на разбираемость здесь, а не при запросе.
    // Потерянный при копировании «https:» давал отказ на КАЖДОМ обращении
    // с сообщением «Failed to parse URL» — установка при этом считалась
    // рабочей и просто разбирала новости правилами.
    if (value.AI_BASE_URL) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(value.AI_BASE_URL);
      } catch {
        parsed = null;
      }

      if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AI_BASE_URL'],
          message:
            `AI_BASE_URL должен быть полным адресом с http:// или https:// — сейчас «${value.AI_BASE_URL}». ` +
            'Например: https://generativelanguage.googleapis.com/v1beta/openai',
        });
      } else if (/\/chat\/completions\/?$/.test(parsed.pathname)) {
        // Этот путь система добавляет сама, и с ним в адресе запрос
        // уходит на /chat/completions/chat/completions.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AI_BASE_URL'],
          message:
            'AI_BASE_URL указывается БЕЗ /chat/completions — этот путь добавляется автоматически.',
        });
      }
    }

    if (value.TELEGRAM_INGEST_MODE === 'bot' && !value.TELEGRAM_BOT_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TELEGRAM_BOT_TOKEN'],
        message:
          'Для TELEGRAM_INGEST_MODE=bot нужен TELEGRAM_BOT_TOKEN. Используйте `none`, чтобы отключить Telegram-источники.',
      });
    }

    if (value.TELEGRAM_INGEST_MODE === 'mtproto' && (!value.TELEGRAM_API_ID || !value.TELEGRAM_API_HASH)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TELEGRAM_API_ID'],
        message: 'Для TELEGRAM_INGEST_MODE=mtproto нужны TELEGRAM_API_ID и TELEGRAM_API_HASH.',
      });
    }

    if (value.DEDUP_REVIEW_THRESHOLD > value.DEDUP_MERGE_THRESHOLD) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DEDUP_REVIEW_THRESHOLD'],
        message: 'DEDUP_REVIEW_THRESHOLD не может быть больше DEDUP_MERGE_THRESHOLD.',
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema> & {
  rootDir: string;
  isProduction: boolean;
  isTest: boolean;
  mediaAllowedMimeList: string[];
};

let cached: AppConfig | null = null;

/** Разобрать конфигурацию. В production ошибки валидации останавливают старт. */
export function loadConfig(overrides: NodeJS.ProcessEnv = process.env): AppConfig {
  // Render, Railway, Fly и Heroku сами назначают порт и передают его
  // в PORT, ожидая, что процесс слушает именно его. Свой API_PORT
  // остаётся главным, но если задан только PORT — слушаем его,
  // иначе платформа не дождётся ответа и пометит развёртывание упавшим.
  const source: NodeJS.ProcessEnv =
    overrides.API_PORT === undefined && overrides.PORT !== undefined
      ? { ...overrides, API_PORT: overrides.PORT }
      : overrides;

  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Некорректная конфигурация окружения:\n${details}`);
  }

  const value = parsed.data;

  return {
    ...value,
    rootDir,
    isProduction: value.NODE_ENV === 'production',
    isTest: value.NODE_ENV === 'test',
    mediaAllowedMimeList: value.MEDIA_ALLOWED_MIME.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** Конфигурация процесса (singleton). */
export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

/** Только для тестов: сбросить кэш конфигурации. */
export function resetConfigCache(): void {
  cached = null;
}
