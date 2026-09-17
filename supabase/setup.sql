-- =====================================================================
-- УСТАНОВКА СХЕМЫ: система мониторинга новостей Новороссийска
--
-- Файл создаётся автоматически из supabase/migrations.
-- Не редактируйте его: правьте исходные миграции и выполните
-- `npm run build:setup-sql`.
--
-- Как применить: откройте SQL Editor в Supabase, вставьте файл
-- ЦЕЛИКОМ и выполните один раз. На вопрос про Row Level Security
-- отвечайте «Run without RLS» — RLS включает сама эта установка,
-- в самом конце, и без политик, что означает запрет доступа извне.
-- =====================================================================

-- Защита от повторного запуска: иначе PostgreSQL выдал бы неочевидную
-- ошибку «relation already exists» на середине файла.
DO $install_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'events') THEN
    RAISE EXCEPTION
      'Схема уже установлена: таблица events существует. Повторный запуск не требуется. Чтобы установить заново, сначала очистите схему public.';
  END IF;
END
$install_guard$;

-- Журнал миграций создаётся сразу, до самой схемы: миграция 008
-- включает RLS обходом всех таблиц схемы public, и этот журнал
-- должен попасть под ту же защиту, а не остаться открытым.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------
-- 20260101000001_extensions.sql
-- ---------------------------------------------------------------------

-- Расширения, общие функции и типы.

-- pg_trgm — нечёткий поиск по названиям источников и заголовкам.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- unaccent — нормализация диакритики в полнотекстовом поиске.
CREATE EXTENSION IF NOT EXISTS unaccent;

-- pgvector необязателен. Если расширения нет (managed-хостинг, стандартная
-- сборка PostgreSQL), система продолжает работать: эмбеддинги хранятся в
-- real[], а косинусное расстояние считается в приложении на предварительно
-- суженной выборке. pgvector даёт ANN-индекс и нужен на больших объёмах.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
    RAISE NOTICE 'pgvector подключён: доступен ANN-поиск похожих публикаций';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'pgvector недоступен (%): используется режим real[] + досчёт в приложении', SQLERRM;
  END;
END $$;

-- Единая функция автообновления updated_at. Вешается триггером на таблицы,
-- у которых это поле есть, чтобы приложение не могло о нём «забыть».
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Конфигурация полнотекстового поиска для русского языка с приведением
-- регистра и снятием диакритики. Используется во всех поисковых индексах.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'ru_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION ru_unaccent (COPY = russian);
    ALTER TEXT SEARCH CONFIGURATION ru_unaccent
      ALTER MAPPING FOR hword, hword_part, word
      WITH unaccent, russian_stem;
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 20260101000002_auth.sql
-- ---------------------------------------------------------------------

-- Пользователи, сессии и защита от перебора пароля.

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 text NOT NULL,
  -- Нормализованный email для регистронезависимой уникальности.
  email_normalized      text GENERATED ALWAYS AS (lower(btrim(email))) STORED,
  display_name          text NOT NULL DEFAULT '',
  -- Хэш пароля вместе с параметрами KDF и солью. Открытый пароль
  -- не хранится и не логируется нигде в системе.
  password_hash         text NOT NULL,
  role                  text NOT NULL DEFAULT 'VIEWER'
                          CHECK (role IN ('OWNER', 'ADMIN', 'VIEWER')),
  is_active             boolean NOT NULL DEFAULT true,
  -- Заготовка под 2FA (ТЗ §20): секрет TOTP хранится зашифрованным.
  two_factor_enabled    boolean NOT NULL DEFAULT false,
  two_factor_secret     text,
  two_factor_recovery   text[],
  -- Счётчик неудачных попыток и блокировка (ТЗ §20).
  failed_login_attempts integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  last_login_ip         text,
  -- Требование смены пароля после первичной выдачи.
  must_change_password  boolean NOT NULL DEFAULT false,
  password_changed_at   timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_normalized_key ON users (email_normalized);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Серверные сессии. В cookie уходит только случайный идентификатор,
-- в БД хранится его хэш: утечка дампа БД не даёт угнать активную сессию.
CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,
  csrf_token_hash text NOT NULL,
  ip_address      text,
  user_agent      text,
  expires_at      timestamptz NOT NULL,
  -- Для «скользящего» таймаута простоя.
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

-- Журнал попыток входа: и по email, и по IP — для лимитов и расследований.
CREATE TABLE login_attempts (
  id         bigserial PRIMARY KEY,
  email      text,
  ip_address text,
  successful boolean NOT NULL,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX login_attempts_email_idx ON login_attempts (lower(email), created_at DESC);
CREATE INDEX login_attempts_ip_idx ON login_attempts (ip_address, created_at DESC);


-- ---------------------------------------------------------------------
-- 20260101000003_sources.sql
-- ---------------------------------------------------------------------

-- Категории, источники, сырые публикации и медиа.

CREATE TABLE categories (
  slug               text PRIMARY KEY,
  title              text NOT NULL,
  color              text NOT NULL DEFAULT '#94a3b8',
  emoji              text NOT NULL DEFAULT '📰',
  default_importance text NOT NULL DEFAULT 'MEDIUM'
                       CHECK (default_importance IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  -- Ключевые слова для быстрой эвристической предклассификации и как
  -- fallback, когда AI недоступен (ТЗ §24).
  keywords           text[] NOT NULL DEFAULT '{}',
  sort_order         integer NOT NULL DEFAULT 100,
  is_active          boolean NOT NULL DEFAULT true,
  -- Системные категории нельзя удалить (например, `other` — обязательный
  -- fallback, на который AI всегда может сослаться).
  is_system          boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER categories_set_updated_at
  BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sources (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type                     text NOT NULL CHECK (type IN ('TELEGRAM','VK')),
  title                    text NOT NULL,
  username                 text,
  external_id              text,
  url                      text NOT NULL,
  is_active                boolean NOT NULL DEFAULT true,
  health                   text NOT NULL DEFAULT 'UNKNOWN'
                             CHECK (health IN ('HEALTHY','DEGRADED','FAILING','DISABLED','UNKNOWN')),
  poll_interval_seconds    integer NOT NULL DEFAULT 60 CHECK (poll_interval_seconds >= 15),
  -- Курсор инкрементальной загрузки: последний обработанный ID публикации.
  last_external_id         text,
  last_sync_at             timestamptz,
  last_successful_sync_at  timestamptz,
  last_post_at             timestamptz,
  posts_fetched            integer NOT NULL DEFAULT 0,
  consecutive_failures     integer NOT NULL DEFAULT 0,
  last_error               text,
  last_error_at            timestamptz,
  -- Технические настройки подключения. Секретов здесь нет: токены живут
  -- только в переменных окружения (ТЗ: «не хранить секреты в коде/БД»).
  config                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Один и тот же канал нельзя завести дважды.
CREATE UNIQUE INDEX sources_type_username_key
  ON sources (type, lower(username)) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX sources_type_external_id_key
  ON sources (type, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX sources_active_idx ON sources (is_active, health);
CREATE INDEX sources_title_trgm_idx ON sources USING gin (title gin_trgm_ops);

CREATE TRIGGER sources_set_updated_at
  BEFORE UPDATE ON sources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE source_posts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id         uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id       text NOT NULL,
  url               text,
  posted_at         timestamptz NOT NULL,
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  -- Исходный текст. НИКОГДА не перезаписывается после AI-обработки (ТЗ §2):
  -- это первичное доказательство происхождения каждого факта.
  raw_text          text NOT NULL DEFAULT '',
  -- Нормализованный текст для анализа и поиска.
  normalized_text   text,
  is_forward        boolean NOT NULL DEFAULT false,
  forward_from      text,
  status            text NOT NULL DEFAULT 'NEW'
                      CHECK (status IN ('NEW','PROCESSING','PROCESSED','NEEDS_REVIEW',
                                        'APPROVED','PUBLISHED','REJECTED','ERROR')),
  event_id          uuid,
  -- Предварительная категория из эвристики/AI-классификации публикации.
  category_slug     text REFERENCES categories(slug) ON DELETE SET NULL,
  importance        text CHECK (importance IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  -- Извлечённые сущности (топонимы, организации) — сигнал для дедупликации.
  entities          text[] NOT NULL DEFAULT '{}',
  -- Признак мата в ИСХОДНОМ тексте. Сам текст сохраняется как есть для
  -- аудита, но флаг позволяет сразу видеть, что материал требует внимания.
  raw_has_profanity boolean NOT NULL DEFAULT false,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Ключевая гарантия идемпотентности: повторный опрос источника не создаёт
-- дублей одной и той же публикации.
CREATE UNIQUE INDEX source_posts_source_external_key ON source_posts (source_id, external_id);
CREATE INDEX source_posts_posted_at_idx ON source_posts (posted_at DESC);
CREATE INDEX source_posts_status_idx ON source_posts (status, posted_at DESC);
CREATE INDEX source_posts_event_idx ON source_posts (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX source_posts_source_idx ON source_posts (source_id, posted_at DESC);
CREATE INDEX source_posts_entities_idx ON source_posts USING gin (entities);

CREATE TRIGGER source_posts_set_updated_at
  BEFORE UPDATE ON source_posts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE media (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_post_id  uuid NOT NULL REFERENCES source_posts(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('PHOTO','VIDEO','AUDIO','DOCUMENT','ANIMATION')),
  -- Ключ в объектном хранилище. Бакет приватный; наружу отдаются только
  -- короткоживущие presigned-ссылки (ТЗ §22).
  storage_key     text,
  original_url    text,
  mime_type       text,
  size_bytes      bigint,
  width           integer,
  height          integer,
  duration_seconds numeric(10,3),
  caption         text,
  thumbnail_key   text,
  has_audio       boolean,
  download_status text NOT NULL DEFAULT 'NEW'
                    CHECK (download_status IN ('NEW','PROCESSING','PROCESSED','ERROR')),
  download_error  text,
  -- Контрольная сумма: одинаковые фото у разных источников — сильный
  -- сигнал того, что это перепечатка, а не независимое подтверждение.
  checksum        text,
  position        integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX media_source_post_idx ON media (source_post_id, position);
CREATE INDEX media_type_idx ON media (type);
CREATE INDEX media_checksum_idx ON media (checksum) WHERE checksum IS NOT NULL;
CREATE INDEX media_pending_download_idx ON media (download_status) WHERE download_status = 'NEW';


-- ---------------------------------------------------------------------
-- 20260101000004_events.sql
-- ---------------------------------------------------------------------

-- События, связь публикаций с событиями, факты, транскрипции, эмбеддинги.

CREATE TABLE events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                    text NOT NULL,
  summary                  text NOT NULL DEFAULT '',
  category_slug            text REFERENCES categories(slug) ON DELETE SET NULL,
  importance               text NOT NULL DEFAULT 'MEDIUM'
                             CHECK (importance IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status                   text NOT NULL DEFAULT 'NEW'
                             CHECK (status IN ('NEW','PROCESSING','PROCESSED','NEEDS_REVIEW',
                                               'APPROVED','PUBLISHED','REJECTED','ERROR')),
  -- Подтверждённость НЕ выводится из числа перепечаток (ТЗ §28): считается
  -- по независимым источникам, собственным медиа и совпадению фактов.
  confirmation_status      text NOT NULL DEFAULT 'UNCONFIRMED'
                             CHECK (confirmation_status IN ('UNCONFIRMED','PARTIALLY_CONFIRMED','CONFIRMED')),
  confidence               numeric(4,3) NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  -- Время самого происшествия (может отличаться от времени публикации).
  occurred_at              timestamptz,
  first_reported_at        timestamptz NOT NULL,
  last_reported_at         timestamptz NOT NULL,
  location_text            text,
  latitude                 double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude                double precision CHECK (longitude BETWEEN -180 AND 180),
  independent_source_count integer NOT NULL DEFAULT 0,
  source_post_count        integer NOT NULL DEFAULT 0,
  -- Событие, в которое это было слито при обнаружении дубля. Записи не
  -- удаляются: история объединений сохраняется для аудита.
  merged_into_event_id     uuid REFERENCES events(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX events_occurred_at_idx ON events (COALESCE(occurred_at, first_reported_at) DESC);
CREATE INDEX events_first_reported_idx ON events (first_reported_at DESC);
CREATE INDEX events_status_idx ON events (status, first_reported_at DESC);
CREATE INDEX events_category_idx ON events (category_slug, first_reported_at DESC);
CREATE INDEX events_importance_idx ON events (importance, first_reported_at DESC);
CREATE INDEX events_geo_idx ON events (latitude, longitude)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
CREATE INDEX events_active_idx ON events (first_reported_at DESC) WHERE merged_into_event_id IS NULL;

CREATE TRIGGER events_set_updated_at
  BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Теперь можно замкнуть внешний ключ публикации на событие.
ALTER TABLE source_posts
  ADD CONSTRAINT source_posts_event_id_fkey
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL;

-- Связь «событие ↔ публикация» со всей метаинформацией об объединении.
CREATE TABLE event_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  source_post_id  uuid NOT NULL REFERENCES source_posts(id) ON DELETE CASCADE,
  source_id       uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  -- Первая публикация, по которой создано событие.
  is_primary      boolean NOT NULL DEFAULT false,
  -- Независимый ли это источник или перепечатка: определяет вклад в
  -- подтверждённость события.
  is_independent  boolean NOT NULL DEFAULT true,
  similarity      numeric(4,3),
  -- Разбор оценки по сигналам (время, гео, сущности, семантика) — чтобы
  -- решение о слиянии можно было объяснить и перепроверить.
  match_signals   jsonb NOT NULL DEFAULT '{}'::jsonb,
  attached_by     text NOT NULL DEFAULT 'SYSTEM' CHECK (attached_by IN ('SYSTEM','AI','HUMAN')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX event_sources_unique ON event_sources (event_id, source_post_id);
CREATE INDEX event_sources_event_idx ON event_sources (event_id);
CREATE INDEX event_sources_post_idx ON event_sources (source_post_id);
CREATE UNIQUE INDEX event_sources_primary_idx ON event_sources (event_id) WHERE is_primary;

CREATE TABLE extracted_facts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  text           text NOT NULL,
  is_confirmed   boolean NOT NULL DEFAULT false,
  -- Предположение против факта: AI обязан их разделять (ТЗ §8).
  is_assumption  boolean NOT NULL DEFAULT false,
  -- Происхождение факта: из какой именно публикации он извлечён.
  source_post_id uuid REFERENCES source_posts(id) ON DELETE SET NULL,
  attribution    text,
  confidence     numeric(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  position       integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX extracted_facts_event_idx ON extracted_facts (event_id, position);

CREATE TABLE transcripts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id              uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  status                text NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING','PROCESSING','COMPLETED','UNAVAILABLE','FAILED','SKIPPED')),
  -- Полная транскрипция доступна только в админке и не обязана попадать
  -- в Telegram-пост (ТЗ §9).
  full_text             text,
  language              text,
  -- Сегменты с таймкодами и говорящими; неразборчивое помечается флагом
  -- unclear, слова НЕ додумываются.
  segments              jsonb NOT NULL DEFAULT '[]'::jsonb,
  unclear_segment_count integer NOT NULL DEFAULT 0,
  provider              text,
  duration_seconds      numeric(10,3),
  error                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX transcripts_media_key ON transcripts (media_id);
CREATE INDEX transcripts_status_idx ON transcripts (status);

CREATE TRIGGER transcripts_set_updated_at
  BEFORE UPDATE ON transcripts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Эмбеддинги публикаций для семантической дедупликации.
-- Вектор всегда хранится в real[] — это работает на любой установке
-- PostgreSQL. Колонка типа vector и ANN-индекс добавляются отдельно,
-- только если расширение pgvector доступно.
CREATE TABLE post_embeddings (
  source_post_id uuid PRIMARY KEY REFERENCES source_posts(id) ON DELETE CASCADE,
  provider       text NOT NULL,
  dimensions     integer NOT NULL,
  embedding      real[] NOT NULL,
  -- Хэш текста: позволяет не пересчитывать эмбеддинг для того же текста.
  text_hash      text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX post_embeddings_text_hash_idx ON post_embeddings (text_hash);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    ALTER TABLE post_embeddings ADD COLUMN embedding_vec vector;
    -- HNSW-индекс строится позже, когда известна фактическая размерность:
    -- см. ensureVectorIndex() в модуле дедупликации.
    RAISE NOTICE 'post_embeddings.embedding_vec добавлена (pgvector доступен)';
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 20260101000005_editorial.sql
-- ---------------------------------------------------------------------

-- AI-черновики, очередь модерации и публикации.

CREATE TABLE ai_drafts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  -- Версии не перезаписываются: история правок сохраняется целиком,
  -- текущая помечена флагом is_current.
  version           integer NOT NULL DEFAULT 1,
  title             text NOT NULL,
  body              text NOT NULL,
  -- Итоговый текст поста ровно в том виде, в каком уйдёт в Telegram.
  -- Именно он показывается в preview и именно он проверяется перед отправкой.
  telegram_text     text NOT NULL,
  category_slug     text REFERENCES categories(slug) ON DELETE SET NULL,
  importance        text NOT NULL DEFAULT 'MEDIUM'
                      CHECK (importance IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  location_text     text,
  witness_quotes    jsonb NOT NULL DEFAULT '[]'::jsonb,
  uncertainties     jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_claims     jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence        numeric(4,3) NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  -- Обязательная проверка лексики (ТЗ §7, §30). Черновик не может быть
  -- опубликован, пока profanity_checked = false или profanity_passed = false.
  profanity_checked boolean NOT NULL DEFAULT false,
  profanity_passed  boolean NOT NULL DEFAULT false,
  profanity_report  jsonb,
  created_by        text NOT NULL DEFAULT 'AI' CHECK (created_by IN ('AI','HUMAN')),
  created_by_user   uuid REFERENCES users(id) ON DELETE SET NULL,
  model             text,
  -- Сырой ответ модели — для расследования, если черновик вышел странным.
  raw_response      jsonb,
  is_current        boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ai_drafts_event_version_key ON ai_drafts (event_id, version);
-- У события ровно один текущий черновик.
CREATE UNIQUE INDEX ai_drafts_current_key ON ai_drafts (event_id) WHERE is_current;
CREATE INDEX ai_drafts_event_idx ON ai_drafts (event_id, version DESC);

CREATE TABLE moderation_queue (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  draft_id         uuid REFERENCES ai_drafts(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','IN_REVIEW','APPROVED','REJECTED','PUBLISHED','BLOCKED')),
  priority         text NOT NULL DEFAULT 'MEDIUM'
                     CHECK (priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  assigned_to      uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Причина блокировки, например найденная запрещённая лексика.
  blocked_reason   text,
  reviewed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at      timestamptz,
  rejection_reason text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Одно событие — одна запись в очереди модерации.
CREATE UNIQUE INDEX moderation_queue_event_key ON moderation_queue (event_id);
CREATE INDEX moderation_queue_status_idx ON moderation_queue (status, created_at DESC);
CREATE INDEX moderation_queue_pending_idx ON moderation_queue (priority, created_at)
  WHERE status IN ('PENDING','IN_REVIEW');

CREATE TRIGGER moderation_queue_set_updated_at
  BEFORE UPDATE ON moderation_queue
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE publications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  draft_id            uuid NOT NULL REFERENCES ai_drafts(id) ON DELETE RESTRICT,
  channel             text NOT NULL,
  telegram_message_id text,
  -- Текст ровно в том виде, в каком он ушёл в канал.
  published_text      text NOT NULL,
  media_ids           uuid[] NOT NULL DEFAULT '{}',
  -- Пользователь, подтвердивший публикацию (ТЗ §31).
  published_by        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  published_at        timestamptz NOT NULL DEFAULT now(),
  dry_run             boolean NOT NULL DEFAULT false,
  -- Отчёт финальной проверки лексики, выполненной непосредственно перед
  -- отправкой, — сохраняется как доказательство прохождения контроля.
  final_check_report  jsonb,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX publications_event_idx ON publications (event_id, published_at DESC);
CREATE INDEX publications_published_at_idx ON publications (published_at DESC);
CREATE INDEX publications_success_idx ON publications (published_at DESC) WHERE error IS NULL;


-- ---------------------------------------------------------------------
-- 20260101000006_ops.sql
-- ---------------------------------------------------------------------

-- Очередь задач, ошибки, аудит, история обработки и настройки.

-- Очередь задач на PostgreSQL. Отдельный брокер не нужен: воркеры берут
-- задачи через FOR UPDATE SKIP LOCKED, что даёт корректную конкурентную
-- выдачу без гонок и лишней инфраструктуры.
CREATE TABLE processing_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL,
  status        text NOT NULL DEFAULT 'QUEUED'
                  CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED','DEAD','CANCELLED')),
  stage         text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Ключ дедупликации: не даёт поставить в очередь одну и ту же работу дважды.
  dedupe_key    text,
  priority      integer NOT NULL DEFAULT 100,
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 5,
  -- Время, начиная с которого задачу можно брать (экспоненциальный backoff).
  run_at        timestamptz NOT NULL DEFAULT now(),
  locked_by     text,
  locked_at     timestamptz,
  started_at    timestamptz,
  finished_at   timestamptz,
  last_error    text,
  result        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Основной индекс выборки задач воркером.
CREATE INDEX processing_jobs_claim_idx ON processing_jobs (status, run_at, priority)
  WHERE status = 'QUEUED';
CREATE INDEX processing_jobs_status_idx ON processing_jobs (status, created_at DESC);
CREATE INDEX processing_jobs_type_idx ON processing_jobs (type, status);
-- Одна незавершённая задача на ключ дедупликации.
CREATE UNIQUE INDEX processing_jobs_dedupe_key ON processing_jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED','RUNNING');
-- Поиск «зависших» задач, у которых воркер умер, не сняв блокировку.
CREATE INDEX processing_jobs_stale_idx ON processing_jobs (locked_at) WHERE status = 'RUNNING';

CREATE TRIGGER processing_jobs_set_updated_at
  BEFORE UPDATE ON processing_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Ошибки этапов обработки. Сбой одного этапа не останавливает pipeline
-- (ТЗ §24): ошибка фиксируется здесь, а обработка продолжается.
CREATE TABLE processing_errors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage       text NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid,
  source_id   uuid REFERENCES sources(id) ON DELETE CASCADE,
  job_id      uuid REFERENCES processing_jobs(id) ON DELETE SET NULL,
  message     text NOT NULL,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_resolved boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX processing_errors_unresolved_idx ON processing_errors (created_at DESC)
  WHERE NOT is_resolved;
CREATE INDEX processing_errors_stage_idx ON processing_errors (stage, created_at DESC);
CREATE INDEX processing_errors_source_idx ON processing_errors (source_id, created_at DESC);

-- История прохождения сущности по этапам pipeline — показывается
-- в карточке события (ТЗ §10) и используется для диагностики.
CREATE TABLE processing_history (
  id          bigserial PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id   uuid NOT NULL,
  stage       text NOT NULL,
  status      text NOT NULL,
  message     text,
  duration_ms integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX processing_history_entity_idx ON processing_history (entity_type, entity_id, created_at);

-- Журнал административных действий (ТЗ §20). Записи неизменяемы:
-- UPDATE/DELETE запрещены триггером ниже.
CREATE TABLE audit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity_type text,
  entity_id   uuid,
  ip_address  text,
  user_agent  text,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_user_idx ON audit_logs (user_id, created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);

-- Аудит должен быть доказательством, а не редактируемой таблицей.
CREATE OR REPLACE FUNCTION audit_logs_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Записи audit_logs неизменяемы (попытка %)', TG_OP;
END;
$$;

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

-- Настройки системы (ТЗ §32). Хранятся как JSON по ключам-разделам.
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  -- Критичные настройки требуют повторного подтверждения при изменении.
  is_critical boolean NOT NULL DEFAULT false,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER settings_set_updated_at
  BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ---------------------------------------------------------------------
-- 20260101000007_search.sql
-- ---------------------------------------------------------------------

-- Полнотекстовый поиск (ТЗ §6).
--
-- Поиск должен покрывать заголовок, исходный текст, извлечённые факты,
-- транскрипцию и название источника. Векторы вычисляются генерируемыми
-- колонками: они не могут «разъехаться» с данными, потому что поддерживаются
-- самой СУБД, а не кодом приложения.

-- Публикации: исходный + нормализованный текст.
ALTER TABLE source_posts
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('ru_unaccent'::regconfig, coalesce(raw_text, '') || ' ' || coalesce(normalized_text, ''))
  ) STORED;

CREATE INDEX source_posts_search_idx ON source_posts USING gin (search_vector);
-- Триграммный индекс — для поиска по подстроке и опечаткам.
CREATE INDEX source_posts_raw_text_trgm_idx ON source_posts USING gin (raw_text gin_trgm_ops);

-- События: заголовок весом A, описание — B, место — C. Веса влияют
-- на ранжирование: совпадение в заголовке важнее совпадения в описании.
ALTER TABLE events
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('ru_unaccent'::regconfig, coalesce(title, '')), 'A') ||
    setweight(to_tsvector('ru_unaccent'::regconfig, coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('ru_unaccent'::regconfig, coalesce(location_text, '')), 'C')
  ) STORED;

CREATE INDEX events_search_idx ON events USING gin (search_vector);
CREATE INDEX events_title_trgm_idx ON events USING gin (title gin_trgm_ops);

-- Извлечённые факты.
ALTER TABLE extracted_facts
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('ru_unaccent'::regconfig, coalesce(text, ''))) STORED;

CREATE INDEX extracted_facts_search_idx ON extracted_facts USING gin (search_vector);

-- Транскрипции видео.
ALTER TABLE transcripts
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('ru_unaccent'::regconfig, coalesce(full_text, ''))) STORED;

CREATE INDEX transcripts_search_idx ON transcripts USING gin (search_vector);


-- ---------------------------------------------------------------------
-- 20260101000008_hardening.sql
-- ---------------------------------------------------------------------

-- Ограничение доступа к данным на уровне БД.
--
-- Нужно прежде всего для Supabase. Supabase автоматически публикует REST API
-- (PostgREST) над всеми таблицами схемы `public` и выдаёт браузеру анонимный
-- ключ. Без явного запрета вся приватная база — публикации, черновики,
-- журнал аудита — становится читаемой любым, кто открыл страницу и взял
-- ключ из исходного кода.
--
-- На обычном PostgreSQL ролей `anon` и `authenticated` нет, поэтому блок
-- их проверяет: миграция одинаково применяется и локально, и в Supabase.
--
-- Приложение подключается владельцем таблиц, а владелец обходит RLS, —
-- поэтому включение RLS не мешает работе backend, но закрывает доступ
-- через публичный API.

-- Включаем RLS на всех таблицах схемы. Политики НЕ создаются намеренно:
-- отсутствие политик при включённом RLS означает «запрещено всем», кроме
-- владельца. Это именно то, что нужно закрытой системе.
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target.tablename);
  END LOOP;
END $$;

-- Отзываем права у ролей, доступных снаружи через Supabase API.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
    REVOKE USAGE ON SCHEMA public FROM anon;
    -- Таблицы, созданные позже, не должны оказаться открытыми.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
    RAISE NOTICE 'Доступ роли anon к схеме public отозван';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
    REVOKE USAGE ON SCHEMA public FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;
    RAISE NOTICE 'Доступ роли authenticated к схеме public отозван';
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- Журнал миграций
-- ---------------------------------------------------------------------

INSERT INTO schema_migrations (id, checksum) VALUES
  ('001_extensions', '3731354b8a041940'),
  ('002_auth', 'b80f7567342d1f9c'),
  ('003_sources', '99eb57e9c146d370'),
  ('004_events', 'ff9f668a17aaa6e0'),
  ('005_editorial', '0699f6ea6a0baa0a'),
  ('006_ops', '31a83458b198c4b2'),
  ('007_search', 'd7f501617245043a'),
  ('008_hardening', 'b0b301460f58d29d')
ON CONFLICT (id) DO NOTHING;


-- =====================================================================
-- Установка завершена.
--
-- Проверьте результат:
--   select count(*) from pg_tables where schemaname = 'public';
--     ожидается 21 (20 таблиц схемы + журнал миграций)
--   select count(*) filter (where rowsecurity) from pg_tables where schemaname = 'public';
--     должно совпадать с количеством таблиц
--   select count(*) from pg_policies where schemaname = 'public';
--     ожидается 0 — это и есть запрет доступа через публичный API
-- =====================================================================
