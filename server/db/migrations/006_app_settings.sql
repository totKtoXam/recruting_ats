-- Настройки интеграций, которые администратор меняет в интерфейсе (вход через Google, SMTP, Telegram).
-- Значение здесь важнее переменной окружения; нет строки — действует .env.
-- Секреты (пароли, токены) хранятся зашифрованными (AES-256-GCM, server/lib/secretbox.js).
CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  encrypted  boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);
