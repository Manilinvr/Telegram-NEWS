-- События, связь публикаций с событиями, факты, транскрипции, эмбеддинги.

-- +migrate Up

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

-- +migrate Down
DROP TABLE IF EXISTS post_embeddings;
DROP TABLE IF EXISTS transcripts;
DROP TABLE IF EXISTS extracted_facts;
DROP TABLE IF EXISTS event_sources;
ALTER TABLE source_posts DROP CONSTRAINT IF EXISTS source_posts_event_id_fkey;
DROP TABLE IF EXISTS events;
