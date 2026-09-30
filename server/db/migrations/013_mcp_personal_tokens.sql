-- Личные токены MCP: пользователь выпускает их в профиле и передаёт клиенту в заголовке
-- Authorization: Bearer <токен>. Альтернатива OAuth, когда клиент не может найти
-- метаданные авторизации (например, прокси не пропускает /.well-known/*).
-- Хранится только SHA-256 токена; prefix — первые символы для узнавания в списке.
CREATE TABLE mcp_personal_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name          text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  token_prefix  text NOT NULL,
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

CREATE INDEX mcp_personal_tokens_user_idx ON mcp_personal_tokens (user_id) WHERE revoked_at IS NULL;
