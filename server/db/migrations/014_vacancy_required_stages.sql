-- Обязательные этапы вакансии: при переходе на такой этап нужен итог (результат), а если к этапу
-- привязан шаблон — ещё и ответы на его вопросы. Этап может быть обязательным и без шаблона.
-- vacancy_templates.required остаётся и совпадает с этим списком для этапов с шаблоном.
ALTER TABLE vacancies ADD COLUMN required_stages text[] NOT NULL DEFAULT '{}';

UPDATE vacancies v
SET required_stages = sub.stages
FROM (
  SELECT vacancy_id, array_agg(DISTINCT stage ORDER BY stage) AS stages
  FROM vacancy_templates
  WHERE required
  GROUP BY vacancy_id
) sub
WHERE sub.vacancy_id = v.id;
