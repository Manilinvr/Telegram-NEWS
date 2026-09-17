-- Пользователи, сессии и защита от перебора пароля.

-- +migrate Up

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

-- +migrate Down
DROP TABLE IF EXISTS login_attempts;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
