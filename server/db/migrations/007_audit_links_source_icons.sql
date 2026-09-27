-- 007: журнал изменений полей (с откатом), публикации вакансий,
-- иконки источников и стартовый набор источников.

-- =====================================================================
-- 1. Журнал изменений: кто, когда, какое поле, было → стало
-- =====================================================================
-- old_value / new_value — значения колонок поля ({column: value}), по ним выполняется
-- откат; *_display — человекочитаемый текст на момент изменения (имена, а не id).
CREATE TABLE audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   text NOT NULL CHECK (entity_type IN ('candidate', 'vacancy', 'source', 'template', 'interview', 'user')),
  entity_id     uuid NOT NULL,
  action        text NOT NULL CHECK (action IN ('create', 'update', 'status', 'archive', 'unarchive', 'delete', 'restore', 'revert')),
  field         text NOT NULL DEFAULT '',
  field_label   text NOT NULL DEFAULT '',
  old_value     jsonb,
  new_value     jsonb,
  old_display   text NOT NULL DEFAULT '',
  new_display   text NOT NULL DEFAULT '',
  -- Для отката: какая запись журнала была отменена.
  reverted_from uuid REFERENCES audit_log (id) ON DELETE SET NULL,
  actor_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Имя на момент изменения: остаётся, даже если пользователь удалён.
  actor_name    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, created_at DESC);


-- =====================================================================
-- 2. Публикации вакансии: ссылки на hh, Telegram, LinkedIn и т.д.
-- =====================================================================
ALTER TABLE vacancies ADD COLUMN links jsonb NOT NULL DEFAULT '[]';


-- =====================================================================
-- 3. Иконка источника: пресет (icon_key) или загруженная картинка 64×64
-- =====================================================================
-- icon_key: '' — определить по названию; иначе ключ пресета (linkedin, hh, …).
ALTER TABLE sources
  ADD COLUMN icon_key        text NOT NULL DEFAULT '',
  ADD COLUMN icon_png        bytea,
  ADD COLUMN icon_updated_at timestamptz;

ALTER TABLE sources ADD CONSTRAINT sources_icon_png_size CHECK (icon_png IS NULL OR octet_length(icon_png) <= 65536);


-- =====================================================================
-- 4. Стартовый набор источников (без дублей по названию)
-- =====================================================================
INSERT INTO sources (name, icon_key)
SELECT seed.name, seed.icon_key
FROM (VALUES
  ('hh.kz', 'hh'),
  ('LinkedIn', 'linkedin'),
  ('Telegram', 'telegram'),
  ('Instagram', 'instagram'),
  ('Facebook', 'facebook'),
  ('WhatsApp', 'whatsapp'),
  ('GitHub', 'github'),
  ('Habr Career', 'habr'),
  ('Djinni', 'djinni'),
  ('Enbek.kz', 'enbek'),
  ('OLX', 'olx'),
  ('Indeed', 'indeed'),
  ('Glassdoor', 'glassdoor'),
  ('Сайт компании', 'website'),
  ('Рекомендация', 'referral'),
  ('Прямое обращение', 'direct'),
  ('Внутренний перевод', 'internal'),
  ('Кадровое агентство', 'agency'),
  ('Карьерная ярмарка', 'event')
) AS seed (name, icon_key)
WHERE NOT EXISTS (
  SELECT 1 FROM sources s WHERE lower(btrim(s.name)) = lower(seed.name) AND s.deleted_at IS NULL
);