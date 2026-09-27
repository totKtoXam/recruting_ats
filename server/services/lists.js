// Серверные таблицы: фильтрация, сортировка и пагинация выполняются в PostgreSQL.
// Фронтенд передаёт { page, pageSize, sort: { key, dir }, filters: { key: value } };
// ключи сортировки и фильтров сверяются с белым списком колонок, поэтому в SQL
// попадают только заранее описанные выражения, а значения — только параметрами.
import { APP_CONFIG } from '../config.js';
import { db } from '../db/pool.js';
import { clean } from '../lib/validation.js';
import { toPublicUser, toSource, toVacancy } from './mappers.js';
import { NOTIFICATION_LOG } from './notifications.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const like = value => '%' + value.replace(/[\\%_]/g, char => '\\' + char) + '%';

// Состояние записи: активные (по умолчанию), архив, корзина или все.
// Корзину видят только администраторы, поэтому для остальных «все» — без корзины.
const STATES = ['active', 'archived', 'deleted', 'all'];

function stateClause(alias, state, isAdmin) {
  if (state === 'archived') return `${alias}.archived_at IS NOT NULL AND ${alias}.deleted_at IS NULL`;
  if (state === 'deleted') return `${alias}.deleted_at IS NOT NULL`;
  if (state === 'all') return isAdmin ? 'TRUE' : `${alias}.deleted_at IS NULL`;
  return `${alias}.archived_at IS NULL AND ${alias}.deleted_at IS NULL`;
}

// Количество записей в каждом состоянии с учётом остальных фильтров (для переключателя).
function stateCountsSql(alias, isAdmin) {
  const a = alias;
  return `count(*) FILTER (WHERE ${a}.archived_at IS NULL AND ${a}.deleted_at IS NULL)::int AS active,
          count(*) FILTER (WHERE ${a}.archived_at IS NOT NULL AND ${a}.deleted_at IS NULL)::int AS archived,
          count(*) FILTER (WHERE ${a}.deleted_at IS NOT NULL)::int AS deleted,
          count(*) FILTER (WHERE ${isAdmin ? 'TRUE' : `${a}.deleted_at IS NULL`})::int AS "all"`;
}

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

async function queryList(definition, input = {}, user = null) {
  const isAdmin = Boolean(user && user.is_admin);
  const pageSize = Math.min(
    Math.max(Number.parseInt(input.pageSize, 10) || DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE
  );
  const requestedPage = Math.max(Number.parseInt(input.page, 10) || 1, 1);

  // Параметры, на которые ссылается definition.where ($1, $2, …).
  const params = [...(definition.params || [])];
  const param = () => `$${params.length + 1}`;
  const baseWhere = [...(definition.where || [])];
  const where = [];
  const filters = input.filters || {};
  let state = STATES.includes(filters.state) ? filters.state : 'active';
  if (state === 'deleted' && !isAdmin) state = 'active';

  for (const [key, rawValue] of Object.entries(filters)) {
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

  // Счётчики по состояниям — с теми же фильтрами, но без условия состояния.
  const filterWhere = [...baseWhere, ...where];
  let counts = null;
  if (!definition.stateless) {
    const countsWhere = filterWhere.length ? ' WHERE ' + filterWhere.join(' AND ') : '';
    counts = await db.one(`SELECT ${stateCountsSql(definition.alias, isAdmin)} FROM ${definition.from}${countsWhere}`, params);
    if (!isAdmin) delete counts.deleted;
    where.push(stateClause(definition.alias, state, isAdmin));
  }

  const allWhere = [...baseWhere, ...where];
  const whereSql = allWhere.length ? ' WHERE ' + allWhere.join(' AND ') : '';

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
    state,
    counts,
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
     WHERE t.vacancy_id = v.id AND t.archived_at IS NULL AND t.deleted_at IS NULL) AS templates,
    (SELECT count(*)::int FROM candidates c WHERE c.vacancy_id = v.id AND c.deleted_at IS NULL) AS candidate_count`,
  from: 'vacancies v',
  alias: 'v',
  filters: {
    number: { type: 'number', sql: 'v.number' },
    name: { type: 'text', sql: 'v.name' },
    status: { type: 'eq', sql: 'v.status', allowed: APP_CONFIG.VACANCY_STATUSES }
  },
  sorts: {
    number: 'v.number',
    name: 'lower(v.name)',
    status: `array_position(ARRAY['Открыта', 'На паузе', 'Закрыта'], v.status)`,
    templates:
      '(SELECT count(*) FROM interview_templates t WHERE t.vacancy_id = v.id AND t.archived_at IS NULL AND t.deleted_at IS NULL)',
    candidates: '(SELECT count(*) FROM candidates c WHERE c.vacancy_id = v.id AND c.deleted_at IS NULL)',
    createdAt: 'v.created_at',
    updatedAt: 'v.updated_at',
    deletedAt: 'v.deleted_at'
  },
  defaultSort: { key: 'number', dir: 'DESC' },
  tieBreaker: 'v.id',
  map: row => ({ ...toVacancy(row), templates: row.templates || [], candidateCount: row.candidate_count })
};

const SOURCES = {
  select: 's.*',
  from: 'sources s',
  alias: 's',
  filters: {
    number: { type: 'number', sql: 's.number' },
    name: { type: 'text', sql: 's.name' }
  },
  sorts: {
    number: 's.number',
    name: 'lower(s.name)',
    createdAt: 's.created_at',
    deletedAt: 's.deleted_at'
  },
  defaultSort: { key: 'name', dir: 'ASC' },
  tieBreaker: 's.id',
  map: toSource
};

const USER_STATUS_SQL = `CASE WHEN u.is_active THEN 'active'
  WHEN u.access_granted_at IS NOT NULL THEN 'disabled' ELSE 'pending' END`;

const USERS = {
  select: 'u.*',
  from: 'users u',
  alias: 'u',
  filters: {
    email: { type: 'text', sql: 'u.email' },
    name: { type: 'text', sql: `concat_ws(' ', u.last_name, u.first_name, u.middle_name, u.full_name)` },
    lastName: { type: 'text', sql: 'u.last_name' },
    firstName: { type: 'text', sql: 'u.first_name' },
    middleName: { type: 'text', sql: 'u.middle_name' },
    stage: { type: 'arrayContains', sql: 'u.stages', allowed: APP_CONFIG.PIPELINE_STATUSES },
    responsible: {
      type: 'eq',
      sql: `CASE WHEN cardinality(u.stages) > 0 THEN 'yes' ELSE 'no' END`,
      allowed: ['yes', 'no']
    },
    status: { type: 'eq', sql: USER_STATUS_SQL, allowed: ['active', 'pending', 'disabled'] },
    admin: { type: 'eq', sql: `CASE WHEN u.is_admin THEN 'yes' ELSE 'no' END`, allowed: ['yes', 'no'] }
  },
  sorts: {
    email: 'lower(u.email)',
    name: `lower(nullif(concat_ws(' ', nullif(u.last_name, ''), nullif(u.first_name, '')), ''))`,
    lastName: `lower(nullif(u.last_name, ''))`,
    firstName: `lower(nullif(u.first_name, ''))`,
    middleName: `lower(nullif(u.middle_name, ''))`,
    stages: 'cardinality(u.stages)',
    deletedAt: 'u.deleted_at',
    // Сначала ожидающие доступа — им нужно решение администратора.
    status: `array_position(ARRAY['pending', 'active', 'disabled'], ${USER_STATUS_SQL})`,
    admin: 'u.is_admin',
    lastLogin: 'u.last_login_at',
    requested: 'u.access_requested_at',
    createdAt: 'u.created_at'
  },
  defaultSort: { key: 'status', dir: 'ASC' },
  tieBreaker: 'u.email',
  map: toPublicUser
};

export const listVacancies = (input, user) => queryList(VACANCIES, input, user);
export const listUsers = (input, user) => queryList(USERS, input, user);
export const listSources = (input, user) => queryList(SOURCES, input, user);

// Журнал уведомлений: только свои.
export const listNotificationLog = (input, user) =>
  queryList({ ...NOTIFICATION_LOG, where: ['n.user_id = $1'], params: [user.id] }, input);
