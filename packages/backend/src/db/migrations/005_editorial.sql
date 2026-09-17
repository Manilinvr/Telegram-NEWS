-- AI-черновики, очередь модерации и публикации.

-- +migrate Up

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

-- +migrate Down
DROP TABLE IF EXISTS publications;
DROP TABLE IF EXISTS moderation_queue;
DROP TABLE IF EXISTS ai_drafts;
