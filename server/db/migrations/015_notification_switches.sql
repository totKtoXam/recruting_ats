-- Общие выключатели уведомлений пользователя: канал целиком (app, email, telegram) и вид целиком.
-- Матрица «вид × канал» (notification_preferences) при этом не меняется: включили канал обратно —
-- действуют прежние отметки.
ALTER TABLE users
  ADD COLUMN notify_muted_channels text[] NOT NULL DEFAULT '{}',
  ADD COLUMN notify_muted_kinds    text[] NOT NULL DEFAULT '{}';
