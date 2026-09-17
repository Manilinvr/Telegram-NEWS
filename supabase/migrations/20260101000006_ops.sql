-- ВНИМАНИЕ: файл создаётся автоматически. Не редактируйте его.
-- Источник: packages/backend/src/db/migrations/006_ops.sql
-- Пересборка: npm run build:supabase

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
