-- Шаблоны вопросов становятся самостоятельной сущностью, а вакансия привязывает их к этапам.
-- Раньше шаблон принадлежал одной вакансии и одному этапу (interview_templates.vacancy_id/stage/required);
-- теперь эти три поля живут в связи vacancy_templates.
CREATE TABLE vacancy_templates (
  vacancy_id  uuid NOT NULL REFERENCES vacancies (id) ON DELETE CASCADE,
  stage       text NOT NULL,
  template_id uuid NOT NULL REFERENCES interview_templates (id) ON DELETE CASCADE,
  required    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vacancy_id, stage, template_id)
);

CREATE INDEX vacancy_templates_template_idx ON vacancy_templates (template_id);

-- Для пары вакансия + этап допускается не более одного обязательного шаблона.
CREATE UNIQUE INDEX vacancy_templates_required_uq
  ON vacancy_templates (vacancy_id, stage)
  WHERE required;

INSERT INTO vacancy_templates (vacancy_id, stage, template_id, required)
SELECT vacancy_id, stage, id, required AND deleted_at IS NULL
FROM interview_templates;

ALTER TABLE interview_templates
  DROP COLUMN vacancy_id,
  DROP COLUMN stage,
  DROP COLUMN required;
