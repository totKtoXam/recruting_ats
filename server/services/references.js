import { APP_CONFIG } from '../config.js';
import { db, transaction } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import {
  clean,
  composeFullName,
  normalizeNamePart,
  optionalUuid,
  toBoolean,
  validateEmail
} from '../lib/validation.js';
import { toResponsible, toSource, toTemplate, toVacancy } from './mappers.js';

const TEMPLATE_SELECT = `
  SELECT t.*, v.name AS vacancy_name
  FROM interview_templates t
  JOIN vacancies v ON v.id = t.vacancy_id
`;

// ---------- Вакансии ----------

export async function getVacancies() {
  const rows = await db.many(
    'SELECT * FROM vacancies WHERE deleted_at IS NULL ORDER BY number'
  );
  return rows.map(toVacancy);
}

export async function saveVacancy(input = {}) {
  const name = clean(input.name);
  const status = clean(input.status);
  const comment = clean(input.comment);
  const id = optionalUuid(input.id, 'Вакансия не найдена.');

  if (!name) {
    fail('Название вакансии обязательно.');
  }

  if (!APP_CONFIG.VACANCY_STATUSES.includes(status)) {
    fail('Некорректный статус вакансии.');
  }

  const row = id
    ? await db.one(
        `UPDATE vacancies
         SET name = $2, status = $3, comment = $4, updated_at = now(), deleted_at = NULL
         WHERE id = $1
         RETURNING *`,
        [id, name, status, comment]
      )
    : await db.one(
        `INSERT INTO vacancies (name, status, comment) VALUES ($1, $2, $3) RETURNING *`,
        [name, status, comment]
      );

  if (!row) {
    fail('Вакансия не найдена.', 404);
  }

  return { ok: true, vacancy: toVacancy(row) };
}

export async function deleteVacancy(id) {
  const vacancyId = optionalUuid(id, 'Запись не найдена.');

  return transaction(async tx => {
    const row = await tx.one(
      `UPDATE vacancies SET deleted_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [vacancyId]
    );

    if (!row) {
      fail('Запись не найдена.', 404);
    }

    await tx.query(
      `UPDATE interview_templates SET deleted_at = now(), updated_at = now()
       WHERE vacancy_id = $1 AND deleted_at IS NULL`,
      [vacancyId]
    );

    return { ok: true, entity: toVacancy(row) };
  });
}

// ---------- Источники ----------

export async function getSources() {
  const rows = await db.many(
    'SELECT * FROM sources WHERE deleted_at IS NULL ORDER BY number'
  );
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
        `UPDATE sources SET name = $2, updated_at = now(), deleted_at = NULL
         WHERE id = $1 RETURNING *`,
        [id, name]
      )
    : await db.one('INSERT INTO sources (name) VALUES ($1) RETURNING *', [name]);

  if (!row) {
    fail('Источник не найден.', 404);
  }

  return { ok: true, source: toSource(row) };
}

export async function deleteSource(id) {
  const row = await db.one(
    `UPDATE sources SET deleted_at = now(), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [optionalUuid(id, 'Запись не найдена.')]
  );

  if (!row) {
    fail('Запись не найдена.', 404);
  }

  return { ok: true, entity: toSource(row) };
}

// ---------- Ответственные ----------

export async function getResponsibles() {
  const rows = await db.many(
    'SELECT * FROM responsibles WHERE deleted_at IS NULL ORDER BY number'
  );
  return rows.map(toResponsible);
}

export async function saveResponsible(input = {}) {
  const id = optionalUuid(input.id, 'Ответственный не найден.');
  const lastName = normalizeNamePart(input.lastName);
  const firstName = normalizeNamePart(input.firstName);
  const middleName = normalizeNamePart(input.middleName);
  const email = validateEmail(input.email);
  const userId = optionalUuid(input.userId, 'Выбранный пользователь не найден.');
  const stages = Array.isArray(input.stages) ? input.stages.map(clean) : [];

  if (!lastName || !firstName) {
    fail('Фамилия и имя ответственного обязательны.');
  }

  if (!stages.length) {
    fail('Выберите хотя бы один доступный этап.');
  }

  const invalid = stages.filter(stage => !APP_CONFIG.PIPELINE_STATUSES.includes(stage));

  if (invalid.length) {
    fail('Некорректные этапы ответственного: ' + invalid.join(', '));
  }

  if (userId) {
    const user = await db.one('SELECT id FROM users WHERE id = $1', [userId]);

    if (!user) {
      fail('Выбранный пользователь не найден.');
    }

    const linked = await db.one(
      `SELECT last_name, first_name, middle_name FROM responsibles
       WHERE user_id = $1 AND deleted_at IS NULL AND id IS DISTINCT FROM $2`,
      [userId, id]
    );

    if (linked) {
      fail(
        'Этот пользователь уже привязан к ответственному "' +
          composeFullName(linked.last_name, linked.first_name, linked.middle_name) +
          '".'
      );
    }
  }

  const params = [lastName, firstName, middleName, email, userId, stages];

  const row = id
    ? await db.one(
        `UPDATE responsibles
         SET last_name = $2, first_name = $3, middle_name = $4, email = $5,
             user_id = $6, stages = $7, updated_at = now(), deleted_at = NULL
         WHERE id = $1 RETURNING *`,
        [id, ...params]
      )
    : await db.one(
        `INSERT INTO responsibles (last_name, first_name, middle_name, email, user_id, stages)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        params
      );

  if (!row) {
    fail('Ответственный не найден.', 404);
  }

  return { ok: true, responsible: toResponsible(row) };
}

export async function deleteResponsible(id) {
  const row = await db.one(
    `UPDATE responsibles SET deleted_at = now(), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [optionalUuid(id, 'Запись не найдена.')]
  );

  if (!row) {
    fail('Запись не найдена.', 404);
  }

  return { ok: true, entity: toResponsible(row) };
}

// ---------- Шаблоны интервью ----------

export async function getInterviewTemplates(executor = db) {
  const rows = await executor.many(
    TEMPLATE_SELECT + ' WHERE t.deleted_at IS NULL ORDER BY t.number'
  );
  return rows.map(toTemplate);
}

export async function getTemplatesFor(vacancyId, stage, executor = db) {
  const rows = await executor.many(
    TEMPLATE_SELECT +
      ' WHERE t.deleted_at IS NULL AND t.vacancy_id = $1 AND t.stage = $2 ORDER BY t.number',
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
  const questions = Array.isArray(input.questions)
    ? input.questions.map(clean).filter(Boolean)
    : [];

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

  const vacancy = await db.one(
    'SELECT id FROM vacancies WHERE id = $1 AND deleted_at IS NULL',
    [vacancyId]
  );

  if (!vacancy) {
    fail('Вакансия не найдена.');
  }

  const params = [name, vacancyId, stage, required, JSON.stringify(questions)];

  const saved = id
    ? await db.one(
        `UPDATE interview_templates
         SET name = $2, vacancy_id = $3, stage = $4, required = $5, questions = $6,
             updated_at = now(), deleted_at = NULL
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

export async function deleteInterviewTemplate(id) {
  const saved = await db.one(
    `UPDATE interview_templates SET deleted_at = now(), updated_at = now()
     WHERE id = $1 RETURNING id`,
    [optionalUuid(id, 'Запись не найдена.')]
  );

  if (!saved) {
    fail('Запись не найдена.', 404);
  }

  const row = await db.one(TEMPLATE_SELECT + ' WHERE t.id = $1', [saved.id]);

  return { ok: true, entity: toTemplate(row) };
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
    pipelineStatuses: APP_CONFIG.PIPELINE_STATUSES
  };
}
