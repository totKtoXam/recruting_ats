-- OAuth 2.1 для MCP: Claude и другие MCP-клиенты подключаются к ATS от имени пользователя
-- (кнопка «Connect» / «Authenticate» в клиенте -> вход в ATS -> согласие -> токен).

-- Клиенты регистрируются сами (Dynamic Client Registration, RFC 7591). Только публичные
-- клиенты: секрета нет, код защищён PKCE (S256).
CREATE TABLE oauth_clients (
  id             text PRIMARY KEY,
  name           text NOT NULL DEFAULT '',
  redirect_uris  text[] NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Одноразовые коды авторизации (живут 10 минут). Хранится только SHA-256 кода.
CREATE TABLE oauth_codes (
  code_hash       text PRIMARY KEY,
  client_id       text NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  redirect_uri    text NOT NULL,
  code_challenge  text NOT NULL,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Подключение (grant): одна строка на выданный доступ. Access- и refresh-токены
-- ротируются внутри строки; хранятся только их SHA-256. Отзыв — revoked_at.
CREATE TABLE oauth_grants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           text NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  access_token_hash   text NOT NULL UNIQUE,
  access_expires_at   timestamptz NOT NULL,
  refresh_token_hash  text NOT NULL UNIQUE,
  refresh_expires_at  timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz,
  revoked_at          timestamptz
);

CREATE INDEX oauth_grants_user_idx ON oauth_grants (user_id) WHERE revoked_at IS NULL;
