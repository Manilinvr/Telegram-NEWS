-- ВНИМАНИЕ: файл создаётся автоматически. Не редактируйте его.
-- Источник: packages/backend/src/db/migrations/003_sources.sql
-- Пересборка: npm run build:supabase

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
