-- Теги шаблонов вопросов: [{ name, color }], цвет — ключ палитры (см. TEMPLATE_TAG_COLORS).
ALTER TABLE interview_templates ADD COLUMN tags jsonb NOT NULL DEFAULT '[]';

-- На этапе вакансии теперь не больше одного шаблона. Если их было несколько, остаётся
-- обязательный, иначе — с наименьшим номером.
DELETE FROM vacancy_templates vt
USING (
  SELECT x.vacancy_id, x.stage, x.template_id,
         row_number() OVER (PARTITION BY x.vacancy_id, x.stage ORDER BY x.required DESC, t.number) AS rn
  FROM vacancy_templates x
  JOIN interview_templates t ON t.id = x.template_id
) d
WHERE d.rn > 1
  AND vt.vacancy_id = d.vacancy_id AND vt.stage = d.stage AND vt.template_id = d.template_id;

DROP INDEX vacancy_templates_required_uq;
ALTER TABLE vacancy_templates DROP CONSTRAINT vacancy_templates_pkey;
ALTER TABLE vacancy_templates ADD PRIMARY KEY (vacancy_id, stage);
