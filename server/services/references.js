import { APP_CONFIG } from '../config.js';
import { db } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import { clean, optionalUuid, toBoolean } from '../lib/validation.js';
import { normalizeTemplateQuestions, toSource, toTemplate, toVacancy } from './mappers.js';
import { getResponsibles } from './users.js';

const TEMPLATE_SELECT = `
  SELECT t.*, v.name AS vacancy_name
  FROM interview_templates t
  JOIN vacancies v ON v.id = t.vacancy_id
`;

// Записи, доступные для выбора в формах: не в архиве и не в корзине.
const ACTIVE = 'archived_at IS NULL AND deleted_at IS NULL';

// ---------- Вакансии ----------

export async function getVacancies() {
  const rows = await db.many(`SELECT * FROM vacancies WHERE ${ACTIVE} ORDER BY number`);
  return rows.map(toVacancy);
}

// Переходы между статусами вакансии (кнопки в таблице и на форме).
export const VACANCY_STATUS_TRANSITIONS = Object.freeze({
  'Открыта': ['На паузе', 'Закрыта'],
  'На паузе': ['Открыта', 'Закрыта'],
  'Закрыта': ['Открыта']
});

// Карточка вакансии: только название. Новая вакансия создаётся открытой,
// статус меняется кнопками перехода (setVacancyStatus).
export async function saveVacancy(input = {}) {
  const name = clean(input.name);
  const id = optionalUuid(input.id, 'Вакансия не найдена.');

  if (!name) {
    fail('Название вакансии обязательно.');
  }

  // Дополнительно гарантируется уникальным индексом vacancies_name_active_uq.
  const duplicate = await db.one(
    `SELECT number FROM vacancies
     WHERE lower(btrim(name)) = lower($1) AND deleted_at IS NULL AND id IS DISTINCT FROM $2`,
    [name, id]
  );

  if (duplicate) {
    fail(`Вакансия с названием «${name}» уже существует (№${duplicate.number}).`, 409);
  }

  const row = id
    ? await db.one(
        'UPDATE vacancies SET name = $2, updated_at = now() WHERE id = $1 RETURNING *',
        [id, name]
      )
    : await db.one(
        `INSERT INTO vacancies (name, status) VALUES ($1, 'Открыта') RETURNING *`,
        [name]
      );

  if (!row) {
    fail('Вакансия не найдена.', 404);
  }

  return { ok: true, vacancy: toVacancy(row) };
}

export async function setVacancyStatus(input = {}) {
  const id = optionalUuid(input.id, 'Вакансия не найдена.');
  const status = clean(input.status);
  const vacancy = id ? await db.one('SELECT * FROM vacancies WHERE id = $1', [id]) : null;

  if (!vacancy) {
    fail('Вакансия не найдена.', 404);
  }

  if (vacancy.archived_at || vacancy.deleted_at) {
    fail('Вакансия в архиве — сначала верните её.');
  }

  if (!(VACANCY_STATUS_TRANSITIONS[vacancy.status] || []).includes(status)) {
    fail(`Переход «${vacancy.status}» → «${status}» не разрешён.`);
  }

  const row = await db.one(
    'UPDATE vacancies SET status = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [id, status]
  );

  return { ok: true, vacancy: toVacancy(row) };
}

// ---------- Источники ----------

export async function getSources() {
  const rows = await db.many(`SELECT * FROM sources WHERE ${ACTIVE} ORDER BY number`);
  return rows.map(toSource);
}

export async function saveSource(input = {}) {
  const name = clean(input.name);
  const id = optionalUuid(input.id, 'Источник не найден.');

  if (!name) {
    fail('Название источника обязательно.');
  }

  // Дубликаты дополнительно ловит уникальный индекс sources_name_active_uq.
  const row = id
    ? await db.one(
        'UPDATE sources SET name = $2, updated_at = now() WHERE id = $1 RETURNING *',
        [id, name]
      )
    : await db.one('INSERT INTO sources (name) VALUES ($1) RETURNING *', [name]);

  if (!row) {
    fail('Источник не найден.', 404);
  }

  return { ok: true, source: toSource(row) };
}

// ---------- Шаблоны интервью ----------

export async function getInterviewTemplates(executor = db) {
  const rows = await executor.many(
    TEMPLATE_SELECT + ' WHERE t.archived_at IS NULL AND t.deleted_at IS NULL ORDER BY t.number'
  );
  return rows.map(toTemplate);
}

// Все шаблоны вакансии, включая архивные и удалённые (для админки).
export async function listVacancyTemplates(vacancyId) {
  const id = optionalUuid(vacancyId, 'Вакансия не найдена.');
  if (!id) return [];

  const rows = await db.many(TEMPLATE_SELECT + ' WHERE t.vacancy_id = $1 ORDER BY t.number', [id]);
  return rows.map(toTemplate);
}

export async function getTemplatesFor(vacancyId, stage, executor = db) {
  const rows = await executor.many(
    TEMPLATE_SELECT +
      ` WHERE t.archived_at IS NULL AND t.deleted_at IS NULL
          AND t.vacancy_id = $1 AND t.stage = $2 ORDER BY t.number`,
    [vacancyId, stage]
  );
  return rows.map(toTemplate);
}

export async function saveInterviewTemplate(input = {}) {
  const id = optionalUuid(input.id, 'Шаблон не найден.');
  const name = clean(input.name);
  const vacancyId = optionalUuid(input.vacancyId, 'Вакансия не найдена.');
  const stage = clean(input.stage);
  const required = toBoolean(input.required);
  const questions = normalizeTemplateQuestions(input.questions);

  if (!name) {
    fail('Название шаблона обязательно.');
  }

  if (!vacancyId) {
    fail('Вакансия обязательна.');
  }

  if (!APP_CONFIG.PIPELINE_STATUSES.includes(stage)) {
    fail('Выберите корректный этап.');
  }

  if (!questions.length) {
    fail('Добавьте хотя бы один вопрос.');
  }

  const vacancy = await db.one(`SELECT id FROM vacancies WHERE id = $1 AND deleted_at IS NULL`, [vacancyId]);

  if (!vacancy) {
    fail('Вакансия не найдена.');
  }

  const params = [name, vacancyId, stage, required, JSON.stringify(questions)];

  const saved = id
    ? await db.one(
        `UPDATE interview_templates
         SET name = $2, vacancy_id = $3, stage = $4, required = $5, questions = $6, updated_at = now()
         WHERE id = $1 RETURNING id`,
        [id, ...params]
      )
    : await db.one(
        `INSERT INTO interview_templates (name, vacancy_id, stage, required, questions)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        params
      );

  if (!saved) {
    fail('Шаблон не найден.', 404);
  }

  const row = await db.one(TEMPLATE_SELECT + ' WHERE t.id = $1', [saved.id]);

  return { ok: true, template: toTemplate(row) };
}

// ---------- Справочники ----------

export async function getDictionaries() {
  const rows = await db.many(
    'SELECT category, value FROM dictionaries ORDER BY category, position, value'
  );

  return rows.reduce((result, row) => {
    (result[row.category] ||= []).push(row.value);
    return result;
  }, {});
}

export async function getReferenceData() {
  const [vacancies, sources, responsibles, interviewTemplates, dictionaries] =
    await Promise.all([
      getVacancies(),
      getSources(),
      getResponsibles(),
      getInterviewTemplates(),
      getDictionaries()
    ]);

  return {
    vacancies,
    sources,
    responsibles,
    interviewTemplates,
    dictionaries,
    transitions: APP_CONFIG.TRANSITIONS,
    pipelineStatuses: APP_CONFIG.PIPELINE_STATUSES,
    rejectedStatus: APP_CONFIG.REJECTED_STATUS,
    profInterviewStatus: APP_CONFIG.PROF_INTERVIEW_STATUS,
    rejectionReasons: {
      candidate: dictionaries[APP_CONFIG.REJECTION_REASON_CATEGORIES.candidate] || [],
      responsible: dictionaries[APP_CONFIG.REJECTION_REASON_CATEGORIES.responsible] || []
    },
    otherReason: APP_CONFIG.OTHER_REASON,
    vacancyStatusTransitions: VACANCY_STATUS_TRANSITIONS,
    trashRetentionDays: APP_CONFIG.TRASH_RETENTION_DAYS
  };
}

export { getResponsibles };
