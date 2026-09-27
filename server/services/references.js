import { APP_CONFIG } from '../config.js';
import { db, transaction } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import { clean, optionalUuid, toBoolean, validateHttpUrl } from '../lib/validation.js';
import { normalizeTemplateQuestions, toSource, toTemplate, toVacancy } from './mappers.js';
import { getResponsibles } from './users.js';
import { recordChanges, recordEvent } from './audit.js';

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

// Публикации вакансии: [{ url, name }] — ссылки на hh, Telegram, LinkedIn и т.д.
const MAX_VACANCY_LINKS = 20;

function normalizeVacancyLinks(links) {
  const seen = new Set();
  const result = [];
  for (const link of Array.isArray(links) ? links : []) {
    const url = validateHttpUrl(link && link.url);
    if (!url || seen.has(url.toLowerCase())) continue;
    seen.add(url.toLowerCase());
    result.push({ url, name: clean(link && link.name).slice(0, 120) });
  }
  if (result.length > MAX_VACANCY_LINKS) {
    fail(`Не больше ${MAX_VACANCY_LINKS} ссылок на публикации.`);
  }
  return result;
}

// Карточка вакансии: название и ссылки на публикации. Новая вакансия создаётся открытой,
// статус меняется кнопками перехода (setVacancyStatus).
export async function saveVacancy(input = {}, actor) {
  const name = clean(input.name);
  const id = optionalUuid(input.id, 'Вакансия не найдена.');
  const links = input.links === undefined ? undefined : normalizeVacancyLinks(input.links);

  if (!name) {
    fail('Название вакансии обязательно.');
  }

  return transaction(async tx => {
    // Дополнительно гарантируется уникальным индексом vacancies_name_active_uq.
    const duplicate = await tx.one(
      `SELECT number FROM vacancies
       WHERE lower(btrim(name)) = lower($1) AND deleted_at IS NULL AND id IS DISTINCT FROM $2`,
      [name, id]
    );

    if (duplicate) {
      fail(`Вакансия с названием «${name}» уже существует (№${duplicate.number}).`, 409);
    }

    const before = id ? await tx.one('SELECT * FROM vacancies WHERE id = $1 FOR UPDATE', [id]) : null;

    if (id && !before) {
      fail('Вакансия не найдена.', 404);
    }

    const row = before
      ? await tx.one(
          'UPDATE vacancies SET name = $2, links = COALESCE($3::jsonb, links), updated_at = now() WHERE id = $1 RETURNING *',
          [id, name, links === undefined ? null : JSON.stringify(links)]
        )
      : await tx.one(
          `INSERT INTO vacancies (name, status, links) VALUES ($1, 'Открыта', $2) RETURNING *`,
          [name, JSON.stringify(links || [])]
        );

    if (before) {
      await recordChanges(tx, 'vacancy', before, row, actor);
    } else {
      await recordEvent(tx, { entityType: 'vacancy', entityId: row.id, action: 'create', newDisplay: row.name, actor });
    }

    return { ok: true, vacancy: toVacancy(row) };
  });
}

export async function setVacancyStatus(input = {}, actor) {
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

  const row = await transaction(async tx => {
    const updated = await tx.one(
      'UPDATE vacancies SET status = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [id, status]
    );
    await recordEvent(tx, {
      entityType: 'vacancy', entityId: id, action: 'status', field: 'status', fieldLabel: 'Статус',
      oldDisplay: vacancy.status, newDisplay: status, actor
    });
    return updated;
  });

  return { ok: true, vacancy: toVacancy(row) };
}

// ---------- Источники ----------

export async function getSources() {
  const rows = await db.many(`SELECT * FROM sources WHERE ${ACTIVE} ORDER BY number`);
  return rows.map(toSource);
}

// Иконка источника: пресет (ключ) либо своя картинка — PNG до 64 КБ (редактор отдаёт 64×64).
export const SOURCE_ICON_KEYS = Object.freeze([
  'linkedin', 'github', 'telegram', 'instagram', 'facebook', 'whatsapp', 'hh', 'habr', 'djinni',
  'enbek', 'olx', 'indeed', 'glassdoor', 'superjob', 'jooble', 'vk', 'youtube', 'x',
  'website', 'referral', 'direct', 'internal', 'agency', 'event', 'other'
]);
const MAX_ICON_BYTES = 64 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decodeIconPng(value) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(value || ''));
  if (!match) fail('Иконка должна быть PNG-изображением.');
  const buffer = Buffer.from(match[1], 'base64');
  if (buffer.length > MAX_ICON_BYTES) fail('Иконка слишком большая (до 64 КБ).');
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) fail('Иконка должна быть PNG-изображением.');
  return buffer;
}

export async function saveSource(input = {}, actor) {
  const name = clean(input.name);
  const id = optionalUuid(input.id, 'Источник не найден.');
  const iconKey = input.iconKey === undefined ? undefined : clean(input.iconKey);
  // iconData: undefined — не менять; '' — убрать свою картинку; data URL — новая картинка.
  const iconPng = input.iconData === undefined ? undefined : input.iconData ? decodeIconPng(input.iconData) : null;

  if (!name) {
    fail('Название источника обязательно.');
  }

  if (iconKey && !SOURCE_ICON_KEYS.includes(iconKey)) {
    fail('Неизвестная иконка источника.');
  }

  return transaction(async tx => {
    const before = id ? await tx.one('SELECT * FROM sources WHERE id = $1 FOR UPDATE', [id]) : null;

    if (id && !before) {
      fail('Источник не найден.', 404);
    }

    const nextKey = iconKey === undefined ? (before ? before.icon_key : '') : iconKey;
    const nextPng = iconPng === undefined ? (before ? before.icon_png : null) : iconPng;
    const iconChanged = !before || nextKey !== before.icon_key || iconPng !== undefined;

    // Дубликаты дополнительно ловит уникальный индекс sources_name_active_uq.
    const row = before
      ? await tx.one(
          `UPDATE sources SET name = $2, icon_key = $3, icon_png = $4,
             icon_updated_at = CASE WHEN $5 THEN now() ELSE icon_updated_at END, updated_at = now()
           WHERE id = $1 RETURNING *`,
          [id, name, nextKey, nextPng, iconChanged]
        )
      : await tx.one(
          `INSERT INTO sources (name, icon_key, icon_png, icon_updated_at)
           VALUES ($1, $2, $3, CASE WHEN $3::bytea IS NOT NULL THEN now() END) RETURNING *`,
          [name, nextKey, nextPng]
        );

    if (before) {
      await recordChanges(tx, 'source', before, row, actor);
    } else {
      await recordEvent(tx, { entityType: 'source', entityId: row.id, action: 'create', newDisplay: row.name, actor });
    }

    return { ok: true, source: toSource(row) };
  });
}

// Своя картинка источника (для <img src="/source-icons/:id">).
export async function getSourceIcon(id) {
  const sourceId = optionalUuid(id, 'Источник не найден.');
  const row = sourceId ? await db.one('SELECT icon_png FROM sources WHERE id = $1', [sourceId]) : null;
  return row && row.icon_png ? row.icon_png : null;
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

export async function saveInterviewTemplate(input = {}, actor) {
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

  const saved = await transaction(async tx => {
    const before = id ? await tx.one('SELECT * FROM interview_templates WHERE id = $1 FOR UPDATE', [id]) : null;

    if (id && !before) {
      fail('Шаблон не найден.', 404);
    }

    const row = before
      ? await tx.one(
          `UPDATE interview_templates
           SET name = $2, vacancy_id = $3, stage = $4, required = $5, questions = $6, updated_at = now()
           WHERE id = $1 RETURNING *`,
          [id, ...params]
        )
      : await tx.one(
          `INSERT INTO interview_templates (name, vacancy_id, stage, required, questions)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          params
        );

    if (before) {
      await recordChanges(tx, 'template', before, row, actor);
    } else {
      await recordEvent(tx, { entityType: 'template', entityId: row.id, action: 'create', newDisplay: row.name, actor });
    }

    return row;
  });

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
    sourceIconKeys: SOURCE_ICON_KEYS,
    trashRetentionDays: APP_CONFIG.TRASH_RETENTION_DAYS
  };
}

export { getResponsibles };
