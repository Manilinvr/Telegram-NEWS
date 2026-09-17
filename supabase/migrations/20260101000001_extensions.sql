-- ВНИМАНИЕ: файл создаётся автоматически. Не редактируйте его.
-- Источник: packages/backend/src/db/migrations/001_extensions.sql
-- Пересборка: npm run build:supabase

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
