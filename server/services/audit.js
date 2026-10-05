// Журнал изменений (audit_log): кто, когда, какое поле, было → стало — для всех сущностей.
// Для каждой сущности описаны отслеживаемые поля: из них строится diff при сохранении
// и по ним же выполняется откат («Вернуть»), который тоже записывается в журнал.
//
// old_value / new_value — снимок колонок поля ({column: value}); display — текст для людей
// на момент изменения (имена вакансий и пользователей, а не id).
import { db, transaction } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import { richToText } from '../lib/richtext.js';
import { isUuid } from '../lib/validation.js';
import { formatDateTime } from '../lib/dates.js';
import { userDisplayName } from './mappers.js';
import {
  SALARY_UNREADABLE,
  canViewSalary,
  decryptSalary,
  decryptSalaryText,
  encryptSalaryText,
  requireSalaryAccess
} from '../lib/salary.js';
import { SCOPES } from '../lib/scopes.js';

// ---------- Отображение значений ----------

const EMPTY = '—';
const truncate = (text, max = 300) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

const DISPLAY = {
  text: value => (value === null || value === undefined || value === '' ? EMPTY : String(value)),
  html: value => truncate(richToText(value || '').replace(/\s+/g, ' ').trim()) || EMPTY,
  money: value =>
    value === null || value === undefined || value === '' ? EMPTY : Number(value).toLocaleString('ru-RU').replace(/\u00a0/g, ' '),
  bool: value => (value ? 'Да' : 'Нет'),
  scopes: value =>
    Array.isArray(value) && value.length
      ? value.map(key => (SCOPES.find(scope => scope.key === key) || { label: key }).label).join(', ')
      : EMPTY,
  list: value => (Array.isArray(value) && value.length ? value.join(', ') : EMPTY),
  links: value =>
    Array.isArray(value) && value.length
      ? truncate(value.map(link => (link.name || link.title ? `${link.name || link.title} (${link.url})` : link.url)).join('; '))
      : EMPTY,
  tags: value => (Array.isArray(value) && value.length ? value.map(tag => tag.name).join(', ') : EMPTY),
  questions: value => {
    const items = Array.isArray(value) ? value : [];
    if (!items.length) return EMPTY;
    return truncate(`${items.length} вопр.: ` + items.map(item => (typeof item === 'string' ? item : item.text)).join('; '));
  },
  answers: value => {
    const items = Array.isArray(value) ? value : [];
    if (!items.length) return EMPTY;
    return truncate(items.map(item => `${item.question}: ${richToText(item.answer || '') || (item.skipped ? 'пропущен' : EMPTY)}`).join('; '));
  },
  icon: value => {
    if (!value) return EMPTY;
    if (value.icon_png) return 'Своя картинка';
    return value.icon_key ? `Значок «${value.icon_key}»` : 'Автоматически';
  }
};

// Поля, доступные по scope (field.secret): значение хранится зашифрованным, подписи в журнале
// («было → стало») тоже шифруются и расшифровываются только для пользователя со scope.
const HIDDEN = 'скрыто';
const SECRETS = {
  salary: {
    canView: canViewSalary,
    require: requireSalaryAccess,
    plain: value => decryptSalary(value && value.salary_expectation_enc),
    display: amount => (amount === undefined ? SALARY_UNREADABLE : DISPLAY.money(amount)),
    sealText: encryptSalaryText,
    openText: stored => (stored ? decryptSalaryText(stored) ?? SALARY_UNREADABLE : '')
  }
};

// Ссылочные поля показываются именами.
const REF_QUERIES = {
  vacancy: { sql: 'SELECT number, name FROM vacancies WHERE id = $1', label: row => `№${row.number} · ${row.name}` },
  source: { sql: 'SELECT name FROM sources WHERE id = $1', label: row => row.name },
  user: { sql: 'SELECT * FROM users WHERE id = $1', label: row => userDisplayName(row) }
};

async function refDisplay(executor, ref, id) {
  if (!id) return EMPTY;
  const query = REF_QUERIES[ref];
  const row = isUuid(id) ? await executor.one(query.sql, [id]) : null;
  return row ? query.label(row) : 'Удалённая запись';
}

// ---------- Описание сущностей ----------
// field: { key, label, columns?: [..] (по умолчанию [key]), display, ref?, revertable?, bytea?: [..] }

const f = (key, label, display = 'text', extra = {}) => ({ key, label, display, columns: [key], revertable: true, ...extra });

export const AUDIT_ENTITIES = {
  candidate: {
    table: 'candidates',
    label: 'Кандидат',
    touch: true,
    fields: [
      f('last_name', 'Фамилия'),
      f('first_name', 'Имя'),
      f('middle_name', 'Отчество'),
      f('vacancy_id', 'Вакансия', 'text', { ref: 'vacancy' }),
      f('phone', 'Телефон'),
      f('email', 'Email'),
      { ...f('telegram', 'Telegram'), columns: ['telegram', 'telegram_url'] },
      f('linkedin', 'LinkedIn'),
      f('github', 'GitHub'),
      f('source_id', 'Источник', 'text', { ref: 'source' }),
      { ...f('salary_expectation', 'ЗП ожидания', 'money'), columns: ['salary_expectation_enc'], secret: 'salary' },
      f('links', 'Иные ссылки', 'links'),
      f('recruiter_id', 'Рекрутер', 'text', { ref: 'user' }),
      f('hr_responsible_id', 'Ответственный HR', 'text', { ref: 'user' }),
      f('tech_interviewer_id', 'Проф. интервьювер', 'text', { ref: 'user' })
    ]
  },
  vacancy: {
    table: 'vacancies',
    label: 'Вакансия',
    touch: true,
    fields: [f('name', 'Название'), f('links', 'Публикации', 'links')]
  },
  source: {
    table: 'sources',
    label: 'Источник',
    touch: true,
    fields: [
      f('name', 'Название'),
      { key: 'icon', label: 'Иконка', display: 'icon', columns: ['icon_key', 'icon_png'], bytea: ['icon_png'], revertable: true }
    ]
  },
  template: {
    table: 'interview_templates',
    label: 'Шаблон вопросов',
    touch: true,
    fields: [
      f('name', 'Название'),
      f('tags', 'Теги', 'tags'),
      f('questions', 'Вопросы', 'questions')
    ]
  },
  // Этапы шаблона вакансии пишутся отдельным событием «Этапы» (без отката), как у вакансии.
  vacancy_preset: {
    table: 'vacancy_presets',
    label: 'Шаблон вакансии',
    touch: true,
    fields: [f('name', 'Название')]
  },
  interview: {
    table: 'interviews',
    label: 'Результат интервью',
    touch: true,
    fields: [f('result', 'Результат', 'html'), f('answers', 'Ответы', 'answers')]
  },
  user: {
    table: 'users',
    label: 'Пользователь',
    touch: false,
    adminOnly: true,
    fields: [
      f('last_name', 'Фамилия'),
      f('first_name', 'Имя'),
      f('middle_name', 'Отчество'),
      f('email', 'Email'),
      { ...f('telegram_username', 'Telegram'), columns: ['telegram_username'] },
      f('stages', 'Этапы', 'list'),
      f('is_admin', 'Администратор', 'bool'),
      f('scopes', 'Доступ к данным', 'scopes')
    ]
  }
};

function entityFor(type) {
  const entity = AUDIT_ENTITIES[type];
  if (!entity) fail('Неизвестный тип записи.');
  return entity;
}

// Снимок колонок поля в JSON (bytea — base64).
function snapshot(field, row) {
  const value = {};
  for (const column of field.columns) {
    const raw = row ? row[column] : null;
    value[column] =
      field.bytea && field.bytea.includes(column) && raw
        ? Buffer.from(raw).toString('base64')
        : raw === undefined
          ? null
          : raw instanceof Date
            ? raw.toISOString()
            : raw;
  }
  return value;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Шифротекст каждый раз разный — секретные поля сравниваются по расшифрованному значению.
const sameValue = (field, a, b) =>
  field.secret ? SECRETS[field.secret].plain(a) === SECRETS[field.secret].plain(b) : same(a, b);

async function displayValue(executor, field, value) {
  if (field.secret) {
    const secret = SECRETS[field.secret];
    return secret.sealText(secret.display(secret.plain(value)));
  }
  const main = value ? value[field.columns[0]] : null;
  if (field.ref) return refDisplay(executor, field.ref, main);
  if (field.display === 'icon') return DISPLAY.icon(value);
  return (DISPLAY[field.display] || DISPLAY.text)(main);
}

const actorName = actor => (actor ? userDisplayName(actor) : 'Система');

async function insertEntry(executor, entry) {
  await executor.query(
    `INSERT INTO audit_log
       (entity_type, entity_id, action, field, field_label, old_value, new_value,
        old_display, new_display, reverted_from, actor_id, actor_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      entry.entityType,
      entry.entityId,
      entry.action,
      entry.field || '',
      entry.fieldLabel || '',
      entry.oldValue === undefined ? null : JSON.stringify(entry.oldValue),
      entry.newValue === undefined ? null : JSON.stringify(entry.newValue),
      entry.oldDisplay || '',
      entry.newDisplay || '',
      entry.revertedFrom || null,
      entry.actor ? entry.actor.id : null,
      actorName(entry.actor)
    ]
  );
}

// Изменения полей между двумя строками таблицы. Возвращает подписи изменённых полей.
export async function recordChanges(executor, entityType, before, after, actor) {
  const entity = entityFor(entityType);
  const changed = [];

  for (const field of entity.fields) {
    const oldValue = snapshot(field, before);
    const newValue = snapshot(field, after);
    if (sameValue(field, oldValue, newValue)) continue;

    await insertEntry(executor, {
      entityType,
      entityId: after.id,
      action: 'update',
      field: field.key,
      fieldLabel: field.label,
      oldValue,
      newValue,
      oldDisplay: await displayValue(executor, field, oldValue),
      newDisplay: await displayValue(executor, field, newValue),
      actor
    });
    changed.push(field.label);
  }

  return changed;
}

// Событие без отката: создание, смена статуса, архив/корзина, загрузка файла.
export function recordEvent(executor, { entityType, entityId, action, field = '', fieldLabel = '', oldDisplay = '', newDisplay = '', actor }) {
  return insertEntry(executor, { entityType, entityId, action, field, fieldLabel, oldDisplay, newDisplay, actor });
}

// ---------- История ----------

const ACTION_LABELS = {
  create: 'Создание',
  update: 'Изменение',
  status: 'Статус',
  archive: 'В архив',
  unarchive: 'Из архива',
  delete: 'В корзину',
  restore: 'Из корзины',
  revert: 'Возврат значения'
};

// Подписи «было → стало» для пользователя: у полей по scope — расшифрованные или «скрыто».
export function entryDisplays(row, user) {
  const entity = AUDIT_ENTITIES[row.entity_type];
  const field = entity && entity.fields.find(item => item.key === row.field);
  const secret = field && field.secret ? SECRETS[field.secret] : null;
  if (!secret) return { oldDisplay: row.old_display, newDisplay: row.new_display };
  if (!secret.canView(user)) return { oldDisplay: HIDDEN, newDisplay: HIDDEN };
  return { oldDisplay: secret.openText(row.old_display), newDisplay: secret.openText(row.new_display) };
}

function toEntry(row, extra = {}) {
  return {
    id: row.id,
    action: row.action,
    actionLabel: ACTION_LABELS[row.action] || row.action,
    field: row.field,
    fieldLabel: row.field_label,
    oldDisplay: row.old_display,
    newDisplay: row.new_display,
    actorName: row.actor_name || 'Система',
    createdAt: formatDateTime(row.created_at),
    createdAtIso: new Date(row.created_at).toISOString(),
    revertedFrom: row.reverted_from || null,
    comment: row.comment || '',
    canRevert: false,
    ...extra
  };
}

export async function getHistory(input = {}, user) {
  const entityType = String(input.entityType || '');
  const entity = entityFor(entityType);
  if (entity.adminOnly && !(user && user.is_admin)) fail('Доступно только администраторам.', 403);
  if (!isUuid(input.entityId)) fail(`${entity.label}: запись не найдена.`, 404);

  const current = await db.one(`SELECT * FROM ${entity.table} WHERE id = $1`, [input.entityId]);
  const rows = await db.many(
    `SELECT * FROM audit_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at DESC LIMIT 500`,
    [entityType, input.entityId]
  );

  const fields = Object.fromEntries(entity.fields.map(field => [field.key, field]));
  const entries = rows.map(row => {
    const field = fields[row.field];
    const visible = !(field && field.secret) || SECRETS[field.secret].canView(user);
    const revertable =
      visible && Boolean(current) && !current.deleted_at && field && field.revertable &&
      (row.action === 'update' || row.action === 'revert') && row.old_value !== null;
    return toEntry(row, {
      ...entryDisplays(row, user),
      canRevert: Boolean(revertable && !sameValue(field, snapshot(field, current), row.old_value))
    });
  });

  // Переходы кандидата по этапам ведутся в отдельном журнале — показываем вместе.
  if (entityType === 'candidate') {
    const log = await db.many(
      `SELECT * FROM candidate_status_log WHERE candidate_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [input.entityId]
    );
    for (const item of log) {
      entries.push(
        toEntry(
          {
            id: 'status-' + item.id,
            action: item.from_status ? 'status' : 'create',
            field: 'status',
            field_label: 'Этап',
            old_display: item.from_status || '',
            new_display: item.to_status,
            actor_name: item.changed_by_name || item.changed_by_email,
            created_at: item.created_at,
            comment: item.comment
          },
          {}
        )
      );
    }
    entries.sort((a, b) => (a.createdAtIso < b.createdAtIso ? 1 : a.createdAtIso > b.createdAtIso ? -1 : 0));
  }

  return { entityType, entityId: input.entityId, exists: Boolean(current), entries };
}

// ---------- Откат ----------

// Колонки text[] (остальные массивы — jsonb).
const TEXT_ARRAY_COLUMNS = ['stages', 'scopes'];

// Проверка ссылки перед откатом: запись должна существовать и не лежать в корзине.
async function assertRefAvailable(tx, field, value) {
  const id = value && value[field.columns[0]];
  if (!field.ref || !id) return;
  const table = { vacancy: 'vacancies', source: 'sources', user: 'users' }[field.ref];
  const row = isUuid(id) ? await tx.one(`SELECT deleted_at FROM ${table} WHERE id = $1`, [id]) : null;
  if (!row || row.deleted_at) fail(`Нельзя вернуть «${field.label}»: прежнее значение удалено.`);
}

// afterRevert(tx, entityType, before, after, actor, fieldLabel) — побочные эффекты (уведомления).
export async function revertChange(input = {}, actor, { afterRevert } = {}) {
  if (!isUuid(input.id)) fail('Запись журнала не найдена.', 404);

  return transaction(async tx => {
    const entry = await tx.one('SELECT * FROM audit_log WHERE id = $1', [input.id]);
    if (!entry) fail('Запись журнала не найдена.', 404);

    const entity = entityFor(entry.entity_type);
    if (entity.adminOnly && !(actor && actor.is_admin)) fail('Доступно только администраторам.', 403);

    const field = entity.fields.find(item => item.key === entry.field);
    if (!field || !field.revertable || !['update', 'revert'].includes(entry.action) || entry.old_value === null) {
      fail('Это изменение нельзя вернуть.');
    }
    if (field.secret) SECRETS[field.secret].require(actor);

    const before = await tx.one(`SELECT * FROM ${entity.table} WHERE id = $1 FOR UPDATE`, [entry.entity_id]);
    if (!before) fail(`${entity.label}: запись не найдена.`, 404);
    if (before.deleted_at) fail(`${entity.label} в корзине — сначала восстановите запись.`);

    const target = entry.old_value;
    if (sameValue(field, snapshot(field, before), target)) fail('Поле уже содержит это значение.');
    await assertRefAvailable(tx, field, target);

    if (entry.entity_type === 'user' && field.key === 'is_admin' && before.is_admin && !target.is_admin) {
      if (before.id === actor.id) fail('Нельзя снять права администратора с самого себя.');
      const { count } = await tx.one(
        'SELECT count(*)::int AS count FROM users WHERE is_admin AND is_active AND id <> $1',
        [before.id]
      );
      if (!count) fail('Нельзя снять права с последнего администратора.');
    }

    const sets = [];
    const params = [before.id];
    for (const column of field.columns) {
      let value = target[column] ?? null;
      if (field.bytea && field.bytea.includes(column) && value) value = Buffer.from(value, 'base64');
      else if (value !== null && typeof value === 'object' && !Array.isArray(value)) value = JSON.stringify(value);
      else if (Array.isArray(value) && !TEXT_ARRAY_COLUMNS.includes(column)) value = JSON.stringify(value);
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
    if (field.key === 'icon') sets.push('icon_updated_at = now()');
    if (entity.touch) sets.push('updated_at = now()');

    const after = await tx.one(`UPDATE ${entity.table} SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);

    const oldValue = snapshot(field, before);
    await insertEntry(tx, {
      entityType: entry.entity_type,
      entityId: before.id,
      action: 'revert',
      field: field.key,
      fieldLabel: field.label,
      oldValue,
      newValue: target,
      oldDisplay: await displayValue(tx, field, oldValue),
      newDisplay: await displayValue(tx, field, target),
      revertedFrom: entry.id,
      actor
    });

    if (afterRevert) await afterRevert(tx, entry.entity_type, before, after, actor, field.label);

    return { ok: true, entityType: entry.entity_type, entityId: before.id };
  });
}

// Окончательное удаление записей: журнал уходит вместе с ними.
export function purgeAudit(executor, entityType, ids) {
  if (!ids.length) return null;
  return executor.query('DELETE FROM audit_log WHERE entity_type = $1 AND entity_id = ANY($2)', [entityType, ids]);
}

