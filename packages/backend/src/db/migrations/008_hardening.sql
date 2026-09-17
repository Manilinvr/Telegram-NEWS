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

-- +migrate Up

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

-- +migrate Down

DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', target.tablename);
  END LOOP;
END $$;
