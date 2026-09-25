-- Управление доступом из интерфейса: войти может любой Google-аккаунт,
-- но работать в ATS — только тот, кому администратор открыл доступ.
ALTER TABLE users
  ADD COLUMN is_admin             boolean NOT NULL DEFAULT false,
  -- Когда и кем выдан доступ; NULL у активного пользователя не бывает.
  ADD COLUMN access_granted_at    timestamptz,
  ADD COLUMN access_granted_by    uuid REFERENCES users (id),
  -- Последняя попытка входа без доступа («Ожидает доступа»).
  ADD COLUMN access_requested_at  timestamptz;

-- Администратор всегда имеет доступ.
ALTER TABLE users ADD CONSTRAINT users_admin_is_active CHECK (NOT is_admin OR is_active);

UPDATE users SET access_granted_at = created_at WHERE is_active;

-- Отклонённые при входе пользователи: их «последний вход» на самом деле был попыткой.
UPDATE users SET access_requested_at = last_login_at, last_login_at = NULL
WHERE NOT is_active;

-- До появления ролей любой активный пользователь мог управлять справочниками.
-- Чтобы никто не потерял возможности, существующие активные пользователи становятся
-- администраторами (лишних можно разжаловать в «Настройки → Пользователи»).
UPDATE users SET is_admin = true WHERE is_active;
