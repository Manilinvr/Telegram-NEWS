-- Полнотекстовый поиск (ТЗ §6).
--
-- Поиск должен покрывать заголовок, исходный текст, извлечённые факты,
-- транскрипцию и название источника. Векторы вычисляются генерируемыми
-- колонками: они не могут «разъехаться» с данными, потому что поддерживаются
-- самой СУБД, а не кодом приложения.

-- +migrate Up

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

-- +migrate Down
DROP INDEX IF EXISTS transcripts_search_idx;
ALTER TABLE transcripts DROP COLUMN IF EXISTS search_vector;
DROP INDEX IF EXISTS extracted_facts_search_idx;
ALTER TABLE extracted_facts DROP COLUMN IF EXISTS search_vector;
DROP INDEX IF EXISTS events_title_trgm_idx;
DROP INDEX IF EXISTS events_search_idx;
ALTER TABLE events DROP COLUMN IF EXISTS search_vector;
DROP INDEX IF EXISTS source_posts_raw_text_trgm_idx;
DROP INDEX IF EXISTS source_posts_search_idx;
ALTER TABLE source_posts DROP COLUMN IF EXISTS search_vector;
