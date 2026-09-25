// Серверные таблицы: фильтрация, сортировка и пагинация выполняются в PostgreSQL.
// Фронтенд передаёт { page, pageSize, sort: { key, dir }, filters: { key: value } };
// ключи сортировки и фильтров сверяются с белым списком колонок, поэтому в SQL
// попадают только заранее описанные выражения, а значения — только параметрами.
import { APP_CONFIG } from '../config.js';
import { db } from '../db/pool.js';
import { clean } from '../lib/validation.js';
import { toResponsible, toSource, toVacancy } from './mappers.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const like = value => '%' + value.replace(/[\\%_]/g, char => '\\' + char) + '%';

// Типы фильтров: text — подстрока без учёта регистра, eq — точное совпадение,
// number — точное число, arrayContains — элемент text[].
function filterClause(filter, value, param) {
  switch (filter.type) {
    case 'text':
      return { sql: `${filter.sql} ILIKE ${param()}`, value: like(value) };
    case 'eq':
      return { sql: `${filter.sql} = ${param()}`, value };
    case 'number': {
      const number = Number(value);
      return Number.isInteger(number) ? { sql: `${filter.sql} = ${param()}`, value: number } : null;
    }
    case 'arrayContains':
      return { sql: `${param()} = ANY(${filter.sql})`, value };
    default:
      return null;
  }
}

async function queryList(definition, input = {}) {
  const pageSize = Math.min(
    Math.max(Number.parseInt(input.pageSize, 10) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE
  );
  const requestedPage = Math.max(Number.parseInt(input.page, 10) || 1, 1);

  const params = [];
  const param = () => `$${params.length + 1}`;
  const where = [...(definition.where || [])];

  for (const [key, rawValue] of Object.entries(input.filters || {})) {
    const filter = definition.filters[key];
    const value = clean(rawValue);

    if (!filter || !value) {
      continue;
    }

    if (filter.allowed && !filter.allowed.includes(value)) {
      continue;
    }

    const clause = filterClause(filter, value, param);

    if (clause) {
      where.push(clause.sql);
      params.push(clause.value);
    }
  }

  const sortKey = input.sort && definition.sorts[input.sort.key] ? input.sort.key : definition.defaultSort.key;
  const sortDir =
    input.sort && definition.sorts[input.sort.key]
      ? input.sort.dir === 'desc' ? 'DESC' : 'ASC'
      : definition.defaultSort.dir;

  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  const { total } = await db.one(
    `SELECT count(*)::int AS total FROM ${definition.from}${whereSql}`,
    params
  );

  // Если после фильтрации страниц стало меньше — отдаём последнюю существующую.
  const lastPage = Math.max(Math.ceil(total / pageSize), 1);
  const page = Math.min(requestedPage, lastPage);

  const rows = await db.many(
    `SELECT ${definition.select} FROM ${definition.from}${whereSql}
     ORDER BY ${definition.sorts[sortKey]} ${sortDir} NULLS LAST, ${definition.tieBreaker}
     LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params
  );

  return {
    items: rows.map(definition.map),
    total,
    page,
    pageSize,
    sort: { key: sortKey, dir: sortDir.toLowerCase() }
  };
}

const VACANCIES = {
  select: `v.*,
    (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'number', t.number, 'name', t.name, 'stage', t.stage, 'required', t.required
      ) ORDER BY t.number), '[]'::jsonb)
     FROM interview_templates t
     WHERE t.vacancy_id = v.id AND t.deleted_at IS NULL) AS templates`,
  from: 'vacancies v',
  where: ['v.deleted_at IS NULL'],
  filters: {
    number: { type: 'number', sql: 'v.number' },
    name: { type: 'text', sql: 'v.name' },
    status: { type: 'eq', sql: 'v.status', allowed: APP_CONFIG.VACANCY_STATUSES },
    comment: { type: 'text', sql: 'v.comment' }
  },
  sorts: {
    number: 'v.number',
    name: 'lower(v.name)',
    status: `array_position(ARRAY['Открыта', 'На паузе', 'Закрыта'], v.status)`,
    templates:
      '(SELECT count(*) FROM interview_templates t WHERE t.vacancy_id = v.id AND t.deleted_at IS NULL)',
    createdAt: 'v.created_at',
    updatedAt: 'v.updated_at'
  },
  defaultSort: { key: 'number', dir: 'DESC' },
  tieBreaker: 'v.id',
  map: row => ({ ...toVacancy(row), templates: row.templates || [] })
};

const SOURCES = {
  select: 's.*',
  from: 'sources s',
  where: ['s.deleted_at IS NULL'],
  filters: {
    number: { type: 'number', sql: 's.number' },
    name: { type: 'text', sql: 's.name' }
  },
  sorts: {
    number: 's.number',
    name: 'lower(s.name)',
    createdAt: 's.created_at'
  },
  defaultSort: { key: 'name', dir: 'ASC' },
  tieBreaker: 's.id',
  map: toSource
};

const RESPONSIBLES = {
  select: `r.*, u.email AS user_email, u.full_name AS user_full_name`,
  from: 'responsibles r LEFT JOIN users u ON u.id = r.user_id',
  where: ['r.deleted_at IS NULL'],
  filters: {
    number: { type: 'number', sql: 'r.number' },
    lastName: { type: 'text', sql: 'r.last_name' },
    firstName: { type: 'text', sql: 'r.first_name' },
    middleName: { type: 'text', sql: 'r.middle_name' },
    email: { type: 'text', sql: 'r.email' },
    user: { type: 'text', sql: `concat_ws(' ', u.full_name, u.email)` },
    stage: { type: 'arrayContains', sql: 'r.stages', allowed: APP_CONFIG.PIPELINE_STATUSES }
  },
  sorts: {
    number: 'r.number',
    lastName: 'lower(r.last_name)',
    firstName: 'lower(r.first_name)',
    middleName: 'lower(r.middle_name)',
    email: 'lower(r.email)',
    user: `lower(coalesce(nullif(u.full_name, ''), u.email))`,
    stages: 'cardinality(r.stages)'
  },
  defaultSort: { key: 'lastName', dir: 'ASC' },
  tieBreaker: 'r.id',
  map: row => ({
    ...toResponsible(row),
    'Пользователь': row.user_id
      ? [row.user_full_name, row.user_email].filter(Boolean).join(' · ')
      : ''
  })
};

export const listVacancies = input => queryList(VACANCIES, input);
export const listSources = input => queryList(SOURCES, input);
export const listResponsibles = input => queryList(RESPONSIBLES, input);
