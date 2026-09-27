-- 004: ответственные становятся пользователями, архив/корзина для всех сущностей,
-- комментарии с реакциями, форматированный текст (HTML) в многострочных полях.

-- Экранирование обычного текста в безопасный HTML (для переноса старых данных).
CREATE FUNCTION pg_temp.text_to_html(value text) RETURNS text AS $$
  SELECT CASE
    WHEN value IS NULL OR btrim(value) = '' THEN ''
    ELSE '<p>' || replace(
      replace(replace(replace(btrim(value), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
      E'\n', '<br>'
    ) || '</p>'
  END
$$ LANGUAGE sql IMMUTABLE;


-- =====================================================================
-- 1. Пользователи: раздельное ФИО, этапы ответственного, архив/корзина
-- =====================================================================
ALTER TABLE users
  ADD COLUMN last_name    text NOT NULL DEFAULT '',
  ADD COLUMN first_name   text NOT NULL DEFAULT '',
  ADD COLUMN middle_name  text NOT NULL DEFAULT '',
  -- Этапы, за которые пользователь отвечает; непустой список = «ответственный».
  ADD COLUMN stages       text[] NOT NULL DEFAULT '{}',
  ADD COLUMN archived_at  timestamptz,
  ADD COLUMN deleted_at   timestamptz;

-- Прежнее ФИО одной строкой: «Фамилия Имя Отчество».
UPDATE users SET
  last_name   = coalesce((regexp_split_to_array(btrim(full_name), '\s+'))[1], ''),
  first_name  = coalesce((regexp_split_to_array(btrim(full_name), '\s+'))[2], ''),
  middle_name = coalesce(array_to_string((regexp_split_to_array(btrim(full_name), '\s+'))[3:], ' '), '')
WHERE full_name <> '' AND full_name <> email;


-- =====================================================================
-- 2. Ответственные → пользователи
-- =====================================================================
CREATE TEMP TABLE responsible_user_map (
  responsible_id uuid PRIMARY KEY,
  user_id        uuid NOT NULL
) ON COMMIT DROP;

INSERT INTO responsible_user_map
SELECT id, user_id FROM responsibles WHERE user_id IS NOT NULL;

INSERT INTO responsible_user_map
SELECT r.id, u.id
FROM responsibles r
JOIN users u ON lower(u.email) = lower(btrim(r.email))
WHERE r.user_id IS NULL AND btrim(r.email) <> ''
ON CONFLICT DO NOTHING;

-- Ответственным без пользователя создаются пользователи без доступа в ATS.
-- У кого не было email, получает временный адрес — его нужно заменить в «Пользователях».
DO $$
DECLARE
  r record;
  target_email text;
  target_id uuid;
BEGIN
  FOR r IN
    SELECT * FROM responsibles
    WHERE id NOT IN (SELECT responsible_id FROM responsible_user_map)
    ORDER BY number
  LOOP
    target_email := coalesce(
      nullif(lower(btrim(r.email)), ''),
      'responsible-' || r.number || '@no-email.invalid'
    );

    SELECT id INTO target_id FROM users WHERE lower(email) = target_email;

    IF target_id IS NULL THEN
      INSERT INTO users (email, full_name, last_name, first_name, middle_name,
                         is_active, created_at, archived_at, deleted_at)
      VALUES (target_email,
              btrim(concat_ws(' ', r.last_name, r.first_name, nullif(r.middle_name, ''))),
              r.last_name, r.first_name, r.middle_name,
              false, r.created_at, r.deleted_at, r.deleted_at)
      RETURNING id INTO target_id;
    END IF;

    INSERT INTO responsible_user_map VALUES (r.id, target_id);
  END LOOP;
END $$;

-- ФИО из карточки ответственного считается основным (его вели вручную).
UPDATE users u SET
  last_name = r.last_name, first_name = r.first_name, middle_name = r.middle_name
FROM responsible_user_map m
JOIN responsibles r ON r.id = m.responsible_id
WHERE u.id = m.user_id AND r.deleted_at IS NULL;

UPDATE users u SET stages = sub.stages
FROM (
  SELECT m.user_id, array_agg(DISTINCT stage) AS stages
  FROM responsible_user_map m
  JOIN responsibles r ON r.id = m.responsible_id AND r.deleted_at IS NULL,
  unnest(r.stages) AS stage
  GROUP BY m.user_id
) sub
WHERE u.id = sub.user_id;

-- Ссылки на ответственных теперь указывают на пользователей.
ALTER TABLE candidates
  DROP CONSTRAINT candidates_recruiter_id_fkey,
  DROP CONSTRAINT candidates_hr_responsible_id_fkey,
  DROP CONSTRAINT candidates_tech_interviewer_id_fkey,
  DROP CONSTRAINT candidates_rejected_by_responsible_id_fkey;
ALTER TABLE interviews DROP CONSTRAINT interviews_responsible_id_fkey;
ALTER TABLE candidate_status_log DROP CONSTRAINT candidate_status_log_responsible_id_fkey;

UPDATE candidates c SET recruiter_id = m.user_id
FROM responsible_user_map m WHERE m.responsible_id = c.recruiter_id;
UPDATE candidates c SET hr_responsible_id = m.user_id
FROM responsible_user_map m WHERE m.responsible_id = c.hr_responsible_id;
UPDATE candidates c SET tech_interviewer_id = m.user_id
FROM responsible_user_map m WHERE m.responsible_id = c.tech_interviewer_id;
UPDATE candidates c SET rejected_by_responsible_id = m.user_id
FROM responsible_user_map m WHERE m.responsible_id = c.rejected_by_responsible_id;
UPDATE interviews i SET responsible_id = m.user_id
FROM responsible_user_map m WHERE m.responsible_id = i.responsible_id;

ALTER TABLE candidate_status_log DISABLE TRIGGER candidate_status_log_no_update_delete;
UPDATE candidate_status_log l SET responsible_id = m.user_id
FROM responsible_user_map m WHERE m.responsible_id = l.responsible_id;
ALTER TABLE candidate_status_log ENABLE TRIGGER candidate_status_log_no_update_delete;

ALTER TABLE candidates
  ADD CONSTRAINT candidates_recruiter_id_fkey FOREIGN KEY (recruiter_id) REFERENCES users (id),
  ADD CONSTRAINT candidates_hr_responsible_id_fkey FOREIGN KEY (hr_responsible_id) REFERENCES users (id),
  ADD CONSTRAINT candidates_tech_interviewer_id_fkey FOREIGN KEY (tech_interviewer_id) REFERENCES users (id),
  ADD CONSTRAINT candidates_rejected_by_responsible_id_fkey
    FOREIGN KEY (rejected_by_responsible_id) REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE interviews ADD CONSTRAINT interviews_responsible_id_fkey
  FOREIGN KEY (responsible_id) REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE candidate_status_log ADD CONSTRAINT candidate_status_log_responsible_id_fkey
  FOREIGN KEY (responsible_id) REFERENCES users (id) ON DELETE SET NULL;

DROP TABLE responsibles;


-- =====================================================================
-- 3. Жизненный цикл: активный → архив → корзина (30 дней) → удаление из БД
-- =====================================================================
ALTER TABLE vacancies           ADD COLUMN archived_at timestamptz;
ALTER TABLE sources             ADD COLUMN archived_at timestamptz;
ALTER TABLE interview_templates ADD COLUMN archived_at timestamptz;
ALTER TABLE interviews          ADD COLUMN archived_at timestamptz;
ALTER TABLE candidates          ADD COLUMN deleted_at  timestamptz;

-- Раньше удаление было сразу мягким: такие записи считаются архивными и лежащими в корзине.
UPDATE vacancies           SET archived_at = deleted_at WHERE deleted_at IS NOT NULL;
UPDATE sources             SET archived_at = deleted_at WHERE deleted_at IS NOT NULL;
UPDATE interview_templates SET archived_at = deleted_at WHERE deleted_at IS NOT NULL;
UPDATE interviews          SET archived_at = deleted_at WHERE deleted_at IS NOT NULL;

-- В корзину попадает только архивная запись.
ALTER TABLE vacancies           ADD CONSTRAINT vacancies_deleted_archived CHECK (deleted_at IS NULL OR archived_at IS NOT NULL);
ALTER TABLE sources             ADD CONSTRAINT sources_deleted_archived CHECK (deleted_at IS NULL OR archived_at IS NOT NULL);
ALTER TABLE interview_templates ADD CONSTRAINT templates_deleted_archived CHECK (deleted_at IS NULL OR archived_at IS NOT NULL);
ALTER TABLE interviews          ADD CONSTRAINT interviews_deleted_archived CHECK (deleted_at IS NULL OR archived_at IS NOT NULL);
ALTER TABLE candidates          ADD CONSTRAINT candidates_deleted_archived CHECK (deleted_at IS NULL OR archived_at IS NOT NULL);
ALTER TABLE users               ADD CONSTRAINT users_deleted_archived CHECK (deleted_at IS NULL OR archived_at IS NOT NULL);

-- Окончательное удаление: зависимые записи удаляются каскадом или отвязываются.
ALTER TABLE candidate_drafts
  DROP CONSTRAINT candidate_drafts_candidate_id_fkey,
  ADD CONSTRAINT candidate_drafts_candidate_id_fkey
    FOREIGN KEY (candidate_id) REFERENCES candidates (id) ON DELETE SET NULL;
ALTER TABLE candidate_resumes
  DROP CONSTRAINT candidate_resumes_candidate_id_fkey,
  ADD CONSTRAINT candidate_resumes_candidate_id_fkey
    FOREIGN KEY (candidate_id) REFERENCES candidates (id) ON DELETE CASCADE;
ALTER TABLE candidate_status_log
  DROP CONSTRAINT candidate_status_log_candidate_id_fkey,
  ADD CONSTRAINT candidate_status_log_candidate_id_fkey
    FOREIGN KEY (candidate_id) REFERENCES candidates (id) ON DELETE CASCADE,
  DROP CONSTRAINT candidate_status_log_changed_by_user_id_fkey,
  ADD CONSTRAINT candidate_status_log_changed_by_user_id_fkey
    FOREIGN KEY (changed_by_user_id) REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE interviews
  DROP CONSTRAINT interviews_candidate_id_fkey,
  ADD CONSTRAINT interviews_candidate_id_fkey
    FOREIGN KEY (candidate_id) REFERENCES candidates (id) ON DELETE CASCADE,
  DROP CONSTRAINT interviews_template_id_fkey,
  ADD CONSTRAINT interviews_template_id_fkey
    FOREIGN KEY (template_id) REFERENCES interview_templates (id) ON DELETE SET NULL;
ALTER TABLE candidates
  DROP CONSTRAINT candidates_source_id_fkey,
  ADD CONSTRAINT candidates_source_id_fkey
    FOREIGN KEY (source_id) REFERENCES sources (id) ON DELETE SET NULL;
ALTER TABLE interview_templates
  DROP CONSTRAINT interview_templates_vacancy_id_fkey,
  ADD CONSTRAINT interview_templates_vacancy_id_fkey
    FOREIGN KEY (vacancy_id) REFERENCES vacancies (id) ON DELETE CASCADE;
ALTER TABLE users
  DROP CONSTRAINT users_access_granted_by_fkey,
  ADD CONSTRAINT users_access_granted_by_fkey
    FOREIGN KEY (access_granted_by) REFERENCES users (id) ON DELETE SET NULL;

-- Журнал по-прежнему нельзя менять, кроме окончательного удаления из корзины
-- (оно выполняется с SET LOCAL ats.purge = 'on').
CREATE OR REPLACE FUNCTION candidate_status_log_append_only() RETURNS trigger AS $$
BEGIN
  IF current_setting('ats.purge', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'candidate_status_log is append-only';
END;
$$ LANGUAGE plpgsql;


-- =====================================================================
-- 4. Комментарии и реакции
-- =====================================================================
CREATE TABLE comments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  text NOT NULL CHECK (entity_type IN ('candidate', 'vacancy', 'interview')),
  entity_id    uuid NOT NULL,
  parent_id    uuid REFERENCES comments (id) ON DELETE CASCADE,
  author_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Имя на момент написания: остаётся, даже если пользователь удалён.
  author_name  text NOT NULL DEFAULT '',
  body_html    text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz
);

CREATE INDEX comments_entity_idx ON comments (entity_type, entity_id, created_at);

CREATE TABLE comment_reactions (
  comment_id  uuid NOT NULL REFERENCES comments (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  emoji       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id, emoji)
);

-- Прежние однострочные комментарии переносятся в ленту.
INSERT INTO comments (entity_type, entity_id, author_name, body_html, created_at)
SELECT 'candidate', id, 'Перенесено из старой версии', pg_temp.text_to_html(comment), created_at
FROM candidates WHERE btrim(comment) <> '';

INSERT INTO comments (entity_type, entity_id, author_name, body_html, created_at)
SELECT 'vacancy', id, 'Перенесено из старой версии', pg_temp.text_to_html(comment), created_at
FROM vacancies WHERE btrim(comment) <> '';

INSERT INTO comments (entity_type, entity_id, author_name, body_html, created_at)
SELECT 'interview', id,
       coalesce(nullif(btrim(concat_ws(' ', interviewer_last_name, interviewer_first_name)), ''),
                'Перенесено из старой версии'),
       pg_temp.text_to_html(comment), created_at
FROM interviews WHERE btrim(comment) <> '';

ALTER TABLE candidates DROP COLUMN comment;
ALTER TABLE vacancies  DROP COLUMN comment;
ALTER TABLE interviews DROP COLUMN comment;


-- =====================================================================
-- 5. Многострочные поля хранят HTML (форматированный текст)
-- =====================================================================
UPDATE interviews SET result = pg_temp.text_to_html(result) WHERE result NOT LIKE '<%';

UPDATE interviews i SET answers = coalesce((
  SELECT jsonb_agg(
           jsonb_build_object(
             'question', a->>'question',
             'answer', CASE WHEN coalesce(a->>'answer', '') LIKE '<%'
                            THEN a->>'answer'
                            ELSE pg_temp.text_to_html(a->>'answer') END
           ) ORDER BY ord)
  FROM jsonb_array_elements(i.answers) WITH ORDINALITY AS e(a, ord)
), '[]'::jsonb);

UPDATE candidates SET rejection_comment = pg_temp.text_to_html(rejection_comment)
WHERE rejection_comment <> '' AND rejection_comment NOT LIKE '<%';
