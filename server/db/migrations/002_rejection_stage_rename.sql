-- 1. Этап «Техническое интервью» переименован в «Проф. интервью».
UPDATE candidates SET status = 'Проф. интервью' WHERE status = 'Техническое интервью';
UPDATE responsibles SET stages = array_replace(stages, 'Техническое интервью', 'Проф. интервью');
UPDATE interview_templates SET stage = 'Проф. интервью' WHERE stage = 'Техническое интервью';

UPDATE interviews SET
  stage       = replace(stage, 'Техническое интервью', 'Проф. интервью'),
  from_status = replace(from_status, 'Техническое интервью', 'Проф. интервью'),
  to_status   = replace(to_status, 'Техническое интервью', 'Проф. интервью')
WHERE 'Техническое интервью' IN (stage, from_status, to_status);

-- Журнал append-only: переименование этапа — единственная допустимая правка истории.
ALTER TABLE candidate_status_log DISABLE TRIGGER candidate_status_log_no_update_delete;
UPDATE candidate_status_log SET
  from_status = replace(from_status, 'Техническое интервью', 'Проф. интервью'),
  to_status   = replace(to_status, 'Техническое интервью', 'Проф. интервью')
WHERE 'Техническое интервью' IN (from_status, to_status);
ALTER TABLE candidate_status_log ENABLE TRIGGER candidate_status_log_no_update_delete;

UPDATE dictionaries SET value = 'Проф. интервью'
WHERE category = 'Статусы кандидата' AND value = 'Техническое интервью';
UPDATE dictionaries SET value = 'Отказано'
WHERE category = 'Статусы кандидата' AND value = 'Отказ';


-- 2. Статус «Отказано»: кем и почему отказано, с какого этапа (для возврата).
ALTER TABLE candidates
  ADD COLUMN rejected_at                timestamptz,
  ADD COLUMN rejected_from_status       text,
  ADD COLUMN rejected_by_type           text CHECK (rejected_by_type IN ('candidate', 'responsible')),
  ADD COLUMN rejected_by_responsible_id uuid REFERENCES responsibles (id),
  ADD COLUMN rejection_comment          text NOT NULL DEFAULT '';

-- Структурированные подробности перехода (например, кем и почему отказано).
ALTER TABLE candidate_status_log ADD COLUMN details jsonb;

INSERT INTO dictionaries (category, value, position) VALUES
  ('Причины отказа: компания', 'Недостаточный уровень профессиональных навыков', 1),
  ('Причины отказа: компания', 'Недостаточный уровень soft skills', 2),
  ('Причины отказа: компания', 'Не соответствует требованиям вакансии', 3),
  ('Причины отказа: компания', 'Завышенные зарплатные ожидания', 4),
  ('Причины отказа: компания', 'Не прошёл тестовое задание', 5),
  ('Причины отказа: компания', 'Не подходит по ценностям и культуре', 6),
  ('Причины отказа: компания', 'Негативные рекомендации или проверка', 7),
  ('Причины отказа: компания', 'Выбран другой кандидат', 8),
  ('Причины отказа: компания', 'Вакансия закрыта или заморожена', 9),
  ('Причины отказа: компания', 'Не выходит на связь', 10),
  ('Причины отказа: компания', 'Другое', 99),
  ('Причины отказа: кандидат', 'Принял другое предложение', 1),
  ('Причины отказа: кандидат', 'Не устроил уровень зарплаты', 2),
  ('Причины отказа: кандидат', 'Не устроил формат или график работы', 3),
  ('Причины отказа: кандидат', 'Не устроили задачи или технологии', 4),
  ('Причины отказа: кандидат', 'Остался на текущем месте работы', 5),
  ('Причины отказа: кандидат', 'Долгий процесс найма', 6),
  ('Причины отказа: кандидат', 'Негативное впечатление о компании', 7),
  ('Причины отказа: кандидат', 'Личные обстоятельства или релокация', 8),
  ('Причины отказа: кандидат', 'Перестал выходить на связь', 9),
  ('Причины отказа: кандидат', 'Другое', 99)
ON CONFLICT (category, value) DO NOTHING;


-- 3. Названия вакансий уникальны (без учёта регистра и пробелов по краям) среди неудалённых.
--    Существующие дубликаты получают суффикс « (2)», « (3)»…
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY lower(btrim(name)) ORDER BY number) AS rn
  FROM vacancies
  WHERE deleted_at IS NULL
)
UPDATE vacancies v
SET name = btrim(v.name) || ' (' || ranked.rn || ')', updated_at = now()
FROM ranked
WHERE ranked.id = v.id AND ranked.rn > 1;

CREATE UNIQUE INDEX vacancies_name_active_uq
  ON vacancies (lower(btrim(name))) WHERE deleted_at IS NULL;


-- 4. Вопросы шаблонов: строки → объекты { text, answers } с вероятными ответами.
UPDATE interview_templates t
SET questions = (
  SELECT coalesce(jsonb_agg(
           CASE jsonb_typeof(q)
             WHEN 'string' THEN jsonb_build_object('text', q #>> '{}', 'answers', '[]'::jsonb)
             ELSE q
           END
           ORDER BY ord), '[]'::jsonb)
  FROM jsonb_array_elements(t.questions) WITH ORDINALITY AS e(q, ord)
)
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(t.questions) q WHERE jsonb_typeof(q) = 'string');
