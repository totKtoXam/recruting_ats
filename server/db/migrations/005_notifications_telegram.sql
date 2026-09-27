-- Уведомления (в приложении, email, Telegram), подписка на кандидатов и привязка Telegram.

-- ---------- Telegram пользователя ----------
-- telegram_username — ник: либо указан администратором (не подтверждён),
-- либо получен от Telegram при привязке через бота (подтверждён, есть chat_id).
ALTER TABLE users
  ADD COLUMN telegram_username        text NOT NULL DEFAULT '',
  ADD COLUMN telegram_chat_id         bigint,
  ADD COLUMN telegram_verified_at     timestamptz,
  ADD COLUMN telegram_link_token      text,
  ADD COLUMN telegram_link_expires_at timestamptz;

CREATE UNIQUE INDEX users_telegram_chat_uq ON users (telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;
CREATE UNIQUE INDEX users_telegram_link_token_uq ON users (telegram_link_token) WHERE telegram_link_token IS NOT NULL;

-- ---------- Подписка на кандидата («Следить») ----------
CREATE TABLE candidate_watchers (
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (candidate_id, user_id)
);

CREATE INDEX candidate_watchers_user_idx ON candidate_watchers (user_id);

-- ---------- Настройки: вид уведомления × канал ----------
-- Нет строки — действует значение по умолчанию (server/services/notifications.js).
CREATE TABLE notification_preferences (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('assigned', 'candidate_changed', 'status_changed', 'stage_responsible')),
  channel    text NOT NULL CHECK (channel IN ('app', 'email', 'telegram')),
  enabled    boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, channel)
);

-- ---------- Уведомления ----------
CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('assigned', 'candidate_changed', 'status_changed', 'stage_responsible')),
  candidate_id uuid REFERENCES candidates(id) ON DELETE CASCADE,
  actor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_name   text NOT NULL DEFAULT '',
  title        text NOT NULL,
  body         text NOT NULL DEFAULT '',
  details      jsonb,
  -- Показывать в колокольчике (канал «В приложении»). В журнале видны все уведомления.
  in_app       boolean NOT NULL DEFAULT true,
  important    boolean NOT NULL DEFAULT false,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_user_created_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_user_unread_idx ON notifications (user_id) WHERE read_at IS NULL AND in_app;

-- ---------- Доставка по внешним каналам (очередь с повторами) ----------
CREATE TABLE notification_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('email', 'telegram')),
  -- pending — в очереди, sent — доставлено, failed — ошибка после всех попыток,
  -- skipped — не отправлялось (канал не настроен, нет адреса и т. п.).
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  recipient       text NOT NULL DEFAULT '',
  attempts        integer NOT NULL DEFAULT 0,
  error           text NOT NULL DEFAULT '',
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notification_id, channel)
);

CREATE INDEX notification_deliveries_queue_idx ON notification_deliveries (next_attempt_at) WHERE status = 'pending';
