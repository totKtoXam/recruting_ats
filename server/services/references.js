import { APP_CONFIG } from '../config.js';
import { db, transaction } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import { clean, optionalUuid, toBoolean, validateHttpUrl } from '../lib/validation.js';
import {
  normalizeTemplateQuestions,
  normalizeTemplateTags,
  TEMPLATE_TAG_COLORS,
  toSource,
  toTemplate,
  toVacancy,
  toVacancyPreset
} from './mappers.js';
import { getResponsibles } from './users.js';
import { recordChanges, recordEvent } from './audit.js';
import { keepPreviousAttachments, resolveAttachments } from './attachments.js';

const TEMPLATE_SELECT = `
  SELECT t.*,
         (SELECT count(*)::int FROM vacancy_templates vt
          JOIN vacancies v ON v.id = vt.vacancy_id
          WHERE vt.template_id = t.id AND v.deleted_at IS NULL) AS usage,
         (SELECT count(*)::int FROM vacancy_preset_templates pt
          JOIN vacancy_presets p ON p.id = pt.preset_id
          WHERE pt.template_id = t.id AND p.deleted_at IS NULL) AS preset_usage
  FROM interview_templates t
`;

// Этапы воронки как SQL-массив — для сортировки по порядку этапов.
const STAGES_ARRAY_SQL =
  'ARRAY[' + APP_CONFIG.PIPELINE_STATUSES.map(stage => `'${stage.replaceAll("'", "''")}'`).join(', ') + ']::text[]';

// Шаблон вакансии с этапами в том же виде, что у таблицы вакансий: шаблоны вопросов в корзине
// скрыты, архивные помечены; vacancy_count — сколько вакансий (не в корзине) создано из шаблона.
export const PRESET_COLUMNS = `p.*,
  (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'number', t.number, 'name', t.name, 'stage', pt.stage, 'required', pt.required,
      'archived', t.archived_at IS NOT NULL
    ) ORDER BY array_position(${STAGES_ARRAY_SQL}, pt.stage), t.number), '[]'::jsonb)
   FROM vacancy_preset_templates pt
   JOIN interview_templates t ON t.id = pt.template_id
   WHERE pt.preset_id = p.id AND t.deleted_at IS NULL) AS templates,
  (SELECT count(*)::int FROM vacancies v WHERE v.preset_id = p.id AND v.deleted_at IS NULL) AS vacancy_count`;

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
// presetId — шаблон вакансии: если templates не передан, этапы копируются из шаблона (один раз,
// дальше вакансия и шаблон независимы); у новой вакансии запоминается, из какого шаблона она создана.
export async function saveVacancy(input = {}, actor) {
  const name = clean(input.name);
  const id = optionalUuid(input.id, 'Вакансия не найдена.');
  const presetId = optionalUuid(input.presetId, 'Шаблон вакансии не найден.');
  const links = input.links === undefined ? undefined : normalizeVacancyLinks(input.links);
  const bindings = input.templates === undefined ? undefined : normalizeTemplateBindings(input.templates);

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

    const preset = presetId ? await tx.one('SELECT * FROM vacancy_presets WHERE id = $1', [presetId]) : null;
    // Этапы берутся из шаблона, только если templates не передан; иначе presetId — лишь ссылка
    // «откуда создана», и шаблон, ушедший в архив или корзину, сохранению не мешает.
    const copyFromPreset = Boolean(presetId && !bindings);

    if (copyFromPreset && (!preset || preset.deleted_at)) {
      fail('Шаблон вакансии не найден.', 404);
    }

    if (copyFromPreset && preset.archived_at) {
      fail(`Шаблон вакансии «${preset.name}» в архиве — сначала верните его.`);
    }

    const row = before
      ? await tx.one(
          'UPDATE vacancies SET name = $2, links = COALESCE($3::jsonb, links), updated_at = now() WHERE id = $1 RETURNING *',
          [id, name, links === undefined ? null : JSON.stringify(links)]
        )
      : await tx.one(
          `INSERT INTO vacancies (name, status, links, preset_id) VALUES ($1, 'Открыта', $2, $3) RETURNING *`,
          [name, JSON.stringify(links || []), preset ? preset.id : null]
        );

    if (before) {
      await recordChanges(tx, 'vacancy', before, row, actor);
    } else {
      await recordEvent(tx, { entityType: 'vacancy', entityId: row.id, action: 'create', newDisplay: row.name, actor });
    }

    if (preset && !before) {
      await recordEvent(tx, {
        entityType: 'vacancy', entityId: row.id, action: 'update', field: 'preset',
        fieldLabel: 'Шаблон вакансии', oldDisplay: '—', newDisplay: `№${preset.number} · ${preset.name}`, actor
      });
    }

    let stages = bindings;
    let skippedStages = [];

    if (copyFromPreset) {
      ({ bindings: stages, skipped: skippedStages } = copyableStageBindings(await loadStages(tx, STAGE_OWNERS.preset, preset.id)));
    }

    if (stages) {
      await replaceStages(tx, STAGE_OWNERS.vacancy, row.id, stages, actor);
    }

    // Перечитываем: обязательные этапы обновляются вместе с привязками шаблонов.
    return {
      ok: true,
      vacancy: toVacancy(await tx.one('SELECT * FROM vacancies WHERE id = $1', [row.id])),
      ...(copyFromPreset ? { skippedStages } : {})
    };
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
// Шаблон — набор вопросов сам по себе. К вакансии он привязывается по этапам (vacancy_templates):
// «на этапе X вакансии Y используется шаблон Z, обязательный или нет».

// Активные шаблоны — для выпадающего списка в вакансии.
export async function getActiveTemplates(executor = db) {
  const rows = await executor.many(
    TEMPLATE_SELECT + ' WHERE t.archived_at IS NULL AND t.deleted_at IS NULL ORDER BY t.number'
  );
  return rows.map(toTemplate);
}

// Привязки «вакансия + этап + шаблон» (по одной записи на привязку) — доска подбирает по ним вопросы перехода.
export async function getInterviewTemplates(executor = db) {
  const rows = await executor.many(
    `SELECT t.*, vt.vacancy_id, vt.stage, vt.required
     FROM vacancy_templates vt
     JOIN interview_templates t ON t.id = vt.template_id
     JOIN vacancies v ON v.id = vt.vacancy_id AND v.deleted_at IS NULL
     WHERE t.archived_at IS NULL AND t.deleted_at IS NULL
     ORDER BY t.number`
  );
  return rows.map(toTemplate);
}

// Шаблоны вакансии на этапе: привязка (этап, обязательность) подмешана в шаблон.
export async function getTemplatesFor(vacancyId, stage, executor = db) {
  const rows = await executor.many(
    `SELECT t.*, vt.stage, vt.required
     FROM vacancy_templates vt
     JOIN interview_templates t ON t.id = vt.template_id
     WHERE vt.vacancy_id = $1 AND vt.stage = $2 AND t.archived_at IS NULL AND t.deleted_at IS NULL
     ORDER BY t.number`,
    [vacancyId, stage]
  );
  return rows.map(toTemplate);
}

export async function saveInterviewTemplate(input = {}, actor) {
  const id = optionalUuid(input.id, 'Шаблон не найден.');
  const name = clean(input.name);
  const questions = normalizeTemplateQuestions(input.questions);
  const tags = normalizeTemplateTags(input.tags);

  if (!name) {
    fail('Название шаблона обязательно.');
  }

  if (!questions.length) {
    fail('Добавьте хотя бы один вопрос.');
  }

  const saved = await transaction(async tx => {
    const before = id ? await tx.one('SELECT * FROM interview_templates WHERE id = $1 FOR UPDATE', [id]) : null;

    if (id && !before) {
      fail('Шаблон не найден.', 404);
    }

    // Вопрос без files (клиент вложения не передаёт) сохраняет прежние вложения вопроса с тем же текстом.
    const withFiles = await resolveAttachments(
      tx,
      keepPreviousAttachments(questions, before ? normalizeTemplateQuestions(before.questions) : [], question => question.text)
    );
    const params = [name, JSON.stringify(withFiles), JSON.stringify(tags)];

    const row = before
      ? await tx.one(
          `UPDATE interview_templates SET name = $2, questions = $3, tags = $4, updated_at = now()
           WHERE id = $1 RETURNING *`,
          [id, ...params]
        )
      : await tx.one(
          `INSERT INTO interview_templates (name, questions, tags) VALUES ($1, $2, $3) RETURNING *`,
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

// Этапы вакансии: [{ stage, templateId, required }] — на этапе не больше одного шаблона.
// Обязательный этап требует итог при переходе, а с шаблоном — ещё и ответы; обязательным
// этап бывает и без шаблона. Необязательный этап без шаблона не хранится.
export function normalizeTemplateBindings(bindings) {
  if (!Array.isArray(bindings)) fail('Некорректный список этапов вакансии.');

  const seen = new Set();

  return bindings
    .map(item => {
      const stage = clean(item && item.stage);
      const templateId = optionalUuid(item && item.templateId, 'Шаблон не найден.');
      const required = toBoolean(item && item.required);

      if (!APP_CONFIG.PIPELINE_STATUSES.includes(stage)) {
        fail('Выберите этап для каждого шаблона.');
      }

      if (seen.has(stage)) {
        fail(`На этапе «${stage}» может быть только один шаблон.`);
      }
      seen.add(stage);

      return templateId || required ? { stage, templateId: templateId || '', required } : null;
    })
    .filter(Boolean);
}

// ---------- Этапы вакансии и шаблона вакансии ----------
// Этапы устроены одинаково: привязки шаблонов вопросов (не больше одного на этап) у владельца
// плюс список обязательных этапов в его строке. Имена таблиц — только из этих констант.
const STAGE_OWNERS = Object.freeze({
  vacancy: { table: 'vacancies', bindings: 'vacancy_templates', column: 'vacancy_id', entityType: 'vacancy' },
  preset: { table: 'vacancy_presets', bindings: 'vacancy_preset_templates', column: 'preset_id', entityType: 'vacancy_preset' }
});

// Этапы для журнала: «этап: шаблон (обязательный)» в порядке воронки.
export function describeVacancyStages(rows, requiredStages) {
  const byStage = new Map(rows.map(row => [row.stage, row]));
  return APP_CONFIG.PIPELINE_STATUSES.map(stage => {
    const row = byStage.get(stage);
    const required = requiredStages.includes(stage);
    if (!row && !required) return '';
    return `${stage}: ${row ? row.name : 'без шаблона'}${required ? ' (обязательный)' : ''}`;
  })
    .filter(Boolean)
    .join('; ');
}

// Текущие этапы владельца: привязки (с состоянием шаблона вопросов) и обязательные этапы.
async function loadStages(executor, owner, id) {
  const [rows, row] = await Promise.all([
    executor.many(
      `SELECT b.stage, b.template_id, b.required, t.name, t.number,
              t.archived_at IS NOT NULL AS archived, t.deleted_at IS NOT NULL AS deleted
       FROM ${owner.bindings} b JOIN interview_templates t ON t.id = b.template_id
       WHERE b.${owner.column} = $1
       ORDER BY array_position($2::text[], b.stage), t.number`,
      [id, APP_CONFIG.PIPELINE_STATUSES]
    ),
    executor.one(`SELECT required_stages FROM ${owner.table} WHERE id = $1`, [id])
  ]);
  return { rows, requiredStages: (row && row.required_stages) || [] };
}

// Этапы для копирования (шаблон вакансии → вакансия и обратно). Шаблон вопросов в архиве или
// в корзине не переносится: этап остаётся с прежней обязательностью, но без вопросов, —
// такие этапы возвращаются в skipped. Обязательность берётся и из привязки: так её хранят
// импортированные данные.
export function copyableStageBindings({ rows, requiredStages }) {
  const byStage = new Map(rows.map(row => [row.stage, row]));
  const bindings = [];
  const skipped = [];

  for (const stage of APP_CONFIG.PIPELINE_STATUSES) {
    const row = byStage.get(stage);
    const required = requiredStages.includes(stage) || Boolean(row && row.required);
    const usable = Boolean(row && !row.archived && !row.deleted);

    if (row && !usable) {
      skipped.push({ stage, number: row.number, name: row.name });
    }

    if (usable || required) {
      bindings.push({ stage, templateId: usable ? row.template_id : '', required });
    }
  }

  return { bindings, skipped };
}

// Заменяет этапы владельца (привязки шаблонов и обязательные этапы); пишет в его журнал,
// если они изменились.
async function replaceStages(tx, owner, ownerId, bindings, actor) {
  const describe = ({ rows, requiredStages }) => describeVacancyStages(rows, requiredStages);

  const before = await loadStages(tx, owner, ownerId);
  const existingKeys = new Set(before.rows.map(row => `${row.stage}|${row.template_id}`));

  const withTemplate = bindings.filter(binding => binding.templateId);
  const requiredStages = APP_CONFIG.PIPELINE_STATUSES.filter(stage =>
    bindings.some(binding => binding.stage === stage && binding.required)
  );

  // Уже привязанный архивный шаблон остаётся; новые привязки — только к активным шаблонам.
  for (const binding of withTemplate) {
    if (existingKeys.has(`${binding.stage}|${binding.templateId}`)) continue;

    const template = await tx.one(
      'SELECT archived_at, deleted_at FROM interview_templates WHERE id = $1',
      [binding.templateId]
    );

    if (!template || template.deleted_at || template.archived_at) {
      fail(`Шаблон вопросов на этапе «${binding.stage}» не найден или в архиве — выберите другой.`);
    }
  }

  await tx.query(`DELETE FROM ${owner.bindings} WHERE ${owner.column} = $1`, [ownerId]);

  for (const binding of withTemplate) {
    await tx.query(
      `INSERT INTO ${owner.bindings} (${owner.column}, stage, template_id, required) VALUES ($1, $2, $3, $4)`,
      [ownerId, binding.stage, binding.templateId, binding.required]
    );
  }

  await tx.query(`UPDATE ${owner.table} SET required_stages = $2 WHERE id = $1`, [ownerId, requiredStages]);

  const oldDisplay = describe(before);
  const newDisplay = describe(await loadStages(tx, owner, ownerId));

  if (oldDisplay !== newDisplay) {
    await recordEvent(tx, {
      entityType: owner.entityType, entityId: ownerId, action: 'update', field: 'templates',
      fieldLabel: 'Этапы', oldDisplay: oldDisplay || '—', newDisplay: newDisplay || '—', actor
    });
  }
}

// ---------- Шаблоны вакансий ----------
// Шаблон вакансии — готовый набор этапов: шаблон вопросов и обязательность на каждом этапе.

// Активные шаблоны вакансий — для выбора в форме вакансии.
export async function getActivePresets(executor = db) {
  const rows = await executor.many(
    `SELECT ${PRESET_COLUMNS} FROM vacancy_presets p WHERE p.archived_at IS NULL AND p.deleted_at IS NULL ORDER BY p.number`
  );
  return rows.map(toVacancyPreset);
}

// Создание и изменение шаблона вакансии. templates — этапы целиком, как у saveVacancy;
// fromVacancyId (если templates не передан) — взять этапы из вакансии.
export async function saveVacancyPreset(input = {}, actor) {
  const name = clean(input.name);
  const id = optionalUuid(input.id, 'Шаблон вакансии не найден.');
  const fromVacancyId = optionalUuid(input.fromVacancyId, 'Вакансия не найдена.');
  const bindings = input.templates === undefined ? undefined : normalizeTemplateBindings(input.templates);

  if (!name) {
    fail('Название шаблона вакансии обязательно.');
  }

  return transaction(async tx => {
    // Дополнительно гарантируется уникальным индексом vacancy_presets_name_active_uq.
    const duplicate = await tx.one(
      `SELECT number FROM vacancy_presets
       WHERE lower(btrim(name)) = lower($1) AND deleted_at IS NULL AND id IS DISTINCT FROM $2`,
      [name, id]
    );

    if (duplicate) {
      fail(`Шаблон вакансии с названием «${name}» уже существует (№${duplicate.number}).`, 409);
    }

    const before = id ? await tx.one('SELECT * FROM vacancy_presets WHERE id = $1 FOR UPDATE', [id]) : null;

    if (id && !before) {
      fail('Шаблон вакансии не найден.', 404);
    }

    if (before && before.deleted_at) {
      fail('Шаблон вакансии в корзине — сначала восстановите его.');
    }

    let stages = bindings;
    let skippedStages = [];
    const copyFromVacancy = Boolean(fromVacancyId && !bindings);

    if (copyFromVacancy) {
      const vacancy = await tx.one('SELECT deleted_at FROM vacancies WHERE id = $1', [fromVacancyId]);

      if (!vacancy || vacancy.deleted_at) {
        fail('Вакансия не найдена.', 404);
      }

      ({ bindings: stages, skipped: skippedStages } = copyableStageBindings(await loadStages(tx, STAGE_OWNERS.vacancy, fromVacancyId)));
    }

    const row = before
      ? await tx.one('UPDATE vacancy_presets SET name = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, name])
      : await tx.one('INSERT INTO vacancy_presets (name) VALUES ($1) RETURNING *', [name]);

    if (before) {
      await recordChanges(tx, 'vacancy_preset', before, row, actor);
    } else {
      await recordEvent(tx, { entityType: 'vacancy_preset', entityId: row.id, action: 'create', newDisplay: row.name, actor });
    }

    if (stages) {
      await replaceStages(tx, STAGE_OWNERS.preset, row.id, stages, actor);
    }

    const saved = await tx.one(`SELECT ${PRESET_COLUMNS} FROM vacancy_presets p WHERE p.id = $1`, [row.id]);

    return { ok: true, preset: toVacancyPreset(saved), ...(copyFromVacancy ? { skippedStages } : {}) };
  });
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
  const [vacancies, sources, responsibles, interviewTemplates, templates, vacancyPresets, dictionaries] =
    await Promise.all([
      getVacancies(),
      getSources(),
      getResponsibles(),
      getInterviewTemplates(),
      getActiveTemplates(),
      getActivePresets(),
      getDictionaries()
    ]);

  return {
    vacancies,
    sources,
    responsibles,
    interviewTemplates,
    templates,
    vacancyPresets,
    templateTagColors: TEMPLATE_TAG_COLORS,
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
