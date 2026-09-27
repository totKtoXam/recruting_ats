// Уведомления о кандидатах.
//
// Кто получает: назначенные в карточке (рекрутер, HR, проф. интервьювер) и те, кто нажал
// «Следить». Автор изменения уведомление о своём действии не получает.
//
// Виды:
//   assigned          — вас назначили в карточку кандидата;
//   candidate_changed — любые изменения в карточке (поля, резюме, комментарии, архив и т. п.);
//   status_changed    — перенос карточки (смена статуса);
//   stage_responsible — кандидат перешёл на этап, за который отвечаете вы.
// Для каждого получателя выбирается один, самый точный вид, включённый в его настройках
// (например, назначенный рекрутер получит «назначение», а не «изменения в карточке»).
//
// Каналы: app — колокольчик в приложении, email — SMTP, telegram — бот.
// Уведомление и строки доставки создаются в той же транзакции, что и изменение;
// отправка идёт после коммита фоновой очередью (notification-delivery.js).
import { config } from '../config.js';
import { db, transaction } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import { richToText } from '../lib/richtext.js';
import { composeFullName, optionalUuid } from '../lib/validation.js';
import { isoOrEmpty as toIso } from '../lib/dates.js';
import { userDisplayName } from './mappers.js';
import { runtime } from './settings.js';

export const KINDS = [
  {
    key: 'assigned',
    label: 'Назначение карточки',
    description: 'Вас назначили рекрутером, HR или проф. интервьювером кандидата.'
  },
  {
    key: 'candidate_changed',
    label: 'Изменения в карточке',
    description: 'Любые изменения карточки кандидата: поля, резюме, комментарии, архив.'
  },
  {
    key: 'status_changed',
    label: 'Перенос карточки',
    description: 'Кандидат перешёл на другой статус.'
  },
  {
    key: 'stage_responsible',
    label: 'Переход на ваш этап',
    description: 'Кандидат перешёл на этап, за который в карточке отвечаете вы.'
  }
];

export const CHANNELS = [
  { key: 'app', label: 'В приложении' },
  { key: 'email', label: 'Эл. почта' },
  { key: 'telegram', label: 'Telegram' }
];

const KIND_KEYS = KINDS.map(kind => kind.key);
const CHANNEL_KEYS = CHANNELS.map(channel => channel.key);

// Значения по умолчанию: в приложении — всё; по внешним каналам «изменения в карточке»
// выключены, чтобы почта не превращалась в поток писем на каждое сохранение.
const DEFAULTS = {
  assigned: { app: true, email: true, telegram: true },
  candidate_changed: { app: true, email: false, telegram: false },
  status_changed: { app: true, email: true, telegram: true },
  stage_responsible: { app: true, email: true, telegram: true }
};

export const smtpConfigured = () => {
  const smtp = runtime.smtp();
  return Boolean(smtp.host && smtp.from);
};
export const telegramConfigured = () => Boolean(runtime.telegram().botToken);

const ROLE_LABELS = {
  recruiter_id: 'Рекрутер',
  hr_responsible_id: 'Ответственный HR',
  tech_interviewer_id: 'Проф. интервьювер'
};

// ---------- Настройки ----------

async function loadPreferences(executor, userIds) {
  const result = new Map(
    userIds.map(id => [id, structuredClone(DEFAULTS)])
  );

  if (!userIds.length) return result;

  const rows = await executor.many(
    'SELECT user_id, kind, channel, enabled FROM notification_preferences WHERE user_id = ANY($1)',
    [userIds]
  );

  for (const row of rows) {
    const prefs = result.get(row.user_id);
    if (prefs && prefs[row.kind]) prefs[row.kind][row.channel] = row.enabled;
  }

  return result;
}

const enabledChannels = prefs => CHANNEL_KEYS.filter(channel => prefs[channel]);

export function candidateLink(candidateId) {
  return `${config.publicUrl}/#/candidate/${encodeURIComponent(candidateId)}`;
}

// ---------- Создание ----------

// Состояние канала доставки для конкретного пользователя: null — доставлять, строка — причина пропуска.
function skipReason(channel, user) {
  if (channel === 'email') {
    if (!smtpConfigured()) return 'SMTP не настроен';
    if (!user.email || user.email.endsWith('.invalid')) return 'Нет email';
    return null;
  }

  if (channel === 'telegram') {
    if (!telegramConfigured()) return 'Telegram-бот не настроен';
    if (!user.telegram_chat_id) return 'Telegram не привязан';
    return null;
  }

  return null;
}

async function insertNotification(tx, user, kind, channels, message, context) {
  const notification = await tx.one(
    `INSERT INTO notifications
       (user_id, kind, candidate_id, actor_id, actor_name, title, body, details, in_app)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      user.id,
      kind,
      context.candidateId,
      context.actor ? context.actor.id : null,
      context.actor ? userDisplayName(context.actor) : '',
      message.title,
      message.body || '',
      message.details ? JSON.stringify(message.details) : null,
      channels.includes('app')
    ]
  );

  for (const channel of channels.filter(item => item !== 'app')) {
    const reason = skipReason(channel, user);

    await tx.query(
      `INSERT INTO notification_deliveries (notification_id, channel, status, recipient, error)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        notification.id,
        channel,
        reason ? 'skipped' : 'pending',
        channel === 'email' ? user.email : user.telegram_username ? '@' + user.telegram_username : '',
        reason || ''
      ]
    );
  }

  return notification.id;
}

let deliveryHook = () => {};

// notification-delivery.js подписывается, чтобы запускать отправку сразу после изменений.
export function onNotificationsCreated(hook) {
  deliveryHook = hook;
}

// Отложенный запуск доставки: даём транзакции закоммититься.
function scheduleDelivery() {
  setTimeout(() => deliveryHook(), 50).unref?.();
}

const candidateName = row => composeFullName(row.last_name, row.first_name, row.middle_name) || 'Кандидат';

// Роли пользователя в карточке: { userId: ['Рекрутер', ...] }.
function rolesByUser(candidate) {
  const roles = new Map();
  for (const [column, label] of Object.entries(ROLE_LABELS)) {
    const id = candidate[column];
    if (!id) continue;
    if (!roles.has(id)) roles.set(id, []);
    roles.get(id).push(label);
  }
  return roles;
}

/**
 * Создаёт уведомления о событии с кандидатом. Вызывается внутри транзакции изменения.
 *
 * event:
 *   { type: 'created' }
 *   { type: 'updated', changes: ['Телефон', ...], previous: <строка кандидата до изменения> }
 *   { type: 'status', fromStatus, toStatus, stageResponsibleId, comment? }
 *   { type: 'changed', text: 'Добавлен комментарий: …' }   — прочие изменения карточки
 */
export async function notifyCandidateEvent(tx, candidateId, actor, event) {
  const candidate = await tx.one(
    `SELECT c.*, v.name AS vacancy_name FROM candidates c
     JOIN vacancies v ON v.id = c.vacancy_id WHERE c.id = $1`,
    [candidateId]
  );

  if (!candidate) return 0;

  const roles = rolesByUser(candidate);
  const watchers = await tx.many('SELECT user_id FROM candidate_watchers WHERE candidate_id = $1', [
    candidateId
  ]);

  // Аудитория «общих» видов: назначенные + следящие.
  const audience = new Set([...roles.keys(), ...watchers.map(row => row.user_id)]);

  // Кому положен «точный» вид.
  const specific = new Map();

  if (event.type === 'created') {
    for (const id of roles.keys()) specific.set(id, 'assigned');
  }

  if (event.type === 'updated' && event.previous) {
    for (const column of Object.keys(ROLE_LABELS)) {
      const id = candidate[column];
      const wasAssigned = Object.keys(ROLE_LABELS).some(key => event.previous[key] === id);
      if (id && !wasAssigned) specific.set(id, 'assigned');
    }
  }

  if (event.type === 'status' && event.stageResponsibleId) {
    specific.set(event.stageResponsibleId, 'stage_responsible');
  }

  const generalKind = event.type === 'status' ? 'status_changed' : 'candidate_changed';

  const recipientIds = [...new Set([...audience, ...specific.keys()])].filter(
    id => !actor || id !== actor.id
  );

  if (!recipientIds.length) return 0;

  const users = await tx.many(
    `SELECT * FROM users WHERE id = ANY($1) AND archived_at IS NULL AND deleted_at IS NULL`,
    [recipientIds]
  );
  const preferences = await loadPreferences(tx, users.map(user => user.id));
  const name = candidateName(candidate);
  const actorName = actor ? userDisplayName(actor) : 'Система';
  let created = 0;

  for (const user of users) {
    const prefs = preferences.get(user.id);
    const candidates = [specific.get(user.id), audience.has(user.id) ? generalKind : null].filter(Boolean);

    // Первый вид, у которого включён хотя бы один канал.
    const kind = candidates.find(item => enabledChannels(prefs[item]).length);
    if (!kind) continue;

    const message = buildMessage(kind, event, {
      name,
      candidate,
      actorName,
      roles: roles.get(user.id) || []
    });

    await insertNotification(tx, user, kind, enabledChannels(prefs[kind]), message, {
      candidateId,
      actor
    });
    created += 1;
  }

  if (created) scheduleDelivery();
  return created;
}

function buildMessage(kind, event, { name, candidate, actorName, roles }) {
  const vacancy = candidate.vacancy_name ? ' · ' + candidate.vacancy_name : '';
  const details = { actor: actorName, vacancy: candidate.vacancy_name || '', status: candidate.status };

  if (kind === 'assigned') {
    return {
      title: `Вам назначен кандидат: ${name}`,
      body: `Роль: ${roles.join(', ') || '—'}${vacancy}. Назначил(а): ${actorName}.`,
      details: { ...details, roles }
    };
  }

  if (event.type === 'status') {
    const transition = `${event.fromStatus || '—'} → ${event.toStatus}`;
    const comment = event.comment ? ` Комментарий: ${truncate(event.comment, 300)}` : '';

    return {
      title:
        kind === 'stage_responsible'
          ? `${name} перешёл(ла) на ваш этап «${event.toStatus}»`
          : `${name}: ${transition}`,
      body: `${transition}${vacancy}. Перенёс(ла): ${actorName}.${comment}`,
      details: { ...details, fromStatus: event.fromStatus || '', toStatus: event.toStatus }
    };
  }

  if (event.type === 'created') {
    return {
      title: `Новый кандидат: ${name}`,
      body: `Добавил(а): ${actorName}${vacancy}.`,
      details
    };
  }

  if (event.type === 'updated') {
    return {
      title: `Изменения в карточке: ${name}`,
      body: `Изменено: ${event.changes.join(', ')}. Автор: ${actorName}.`,
      details: { ...details, changes: event.changes }
    };
  }

  return {
    title: `Изменения в карточке: ${name}`,
    body: `${event.text} Автор: ${actorName}.`,
    details
  };
}

const truncate = (text, limit) => (text.length > limit ? text.slice(0, limit - 1) + '…' : text);

export function commentSnippet(html) {
  return truncate(richToText(html).replace(/\s+/g, ' ').trim(), 200);
}

// Поля карточки, изменения которых попадают в уведомление.
const TRACKED_FIELDS = [
  [['last_name', 'first_name', 'middle_name'], 'ФИО'],
  [['vacancy_id'], 'Вакансия'],
  [['phone'], 'Телефон'],
  [['email'], 'Email'],
  [['telegram'], 'Telegram'],
  [['linkedin'], 'LinkedIn'],
  [['github'], 'GitHub'],
  [['source_id'], 'Источник'],
  [['salary_expectation'], 'ЗП ожидания'],
  [['links'], 'Иные ссылки'],
  [['recruiter_id'], 'Рекрутер'],
  [['hr_responsible_id'], 'Ответственный HR'],
  [['tech_interviewer_id'], 'Проф. интервьювер']
];

const comparable = value =>
  value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);

export function diffCandidate(previous, next) {
  return TRACKED_FIELDS.filter(([columns]) =>
    columns.some(column => comparable(previous[column]) !== comparable(next[column]))
  ).map(([, label]) => label);
}

// ---------- Колокольчик ----------

const NOTIFICATION_SELECT = `
  SELECT n.*,
         c.last_name AS candidate_last_name, c.first_name AS candidate_first_name,
         c.middle_name AS candidate_middle_name, c.number AS candidate_number,
         c.archived_at AS candidate_archived_at, c.deleted_at AS candidate_deleted_at,
         (SELECT coalesce(jsonb_agg(jsonb_build_object(
             'channel', d.channel, 'status', d.status, 'recipient', d.recipient,
             'attempts', d.attempts, 'error', d.error, 'sentAt', d.sent_at, 'updatedAt', d.updated_at
           ) ORDER BY d.channel), '[]'::jsonb)
          FROM notification_deliveries d WHERE d.notification_id = n.id) AS deliveries
  FROM notifications n
  LEFT JOIN candidates c ON c.id = n.candidate_id
`;

export function toNotification(row) {
  const channels = [];
  if (row.in_app) channels.push({ channel: 'app', status: 'sent', recipient: '', attempts: 0, error: '', sentAt: toIso(row.created_at) });

  for (const delivery of row.deliveries || []) {
    channels.push({ ...delivery, sentAt: delivery.sentAt ? toIso(delivery.sentAt) : '' });
  }

  return {
    id: row.id,
    kind: row.kind,
    kindLabel: (KINDS.find(kind => kind.key === row.kind) || {}).label || row.kind,
    title: row.title,
    body: row.body,
    details: row.details || {},
    actorName: row.actor_name,
    candidateId: row.candidate_id || '',
    candidateNumber: row.candidate_number ?? null,
    candidateState: !row.candidate_id
      ? 'missing'
      : row.candidate_deleted_at
        ? 'deleted'
        : row.candidate_archived_at
          ? 'archived'
          : 'active',
    inApp: row.in_app,
    important: row.important,
    read: Boolean(row.read_at),
    readAt: row.read_at ? toIso(row.read_at) : '',
    createdAt: toIso(row.created_at),
    channels
  };
}

export async function getUnreadCount(user) {
  const { count } = await db.one(
    'SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL AND in_app',
    [user.id]
  );
  return count;
}

const FEED_VIEWS = {
  recent: '',
  unread: ' AND n.read_at IS NULL',
  important: ' AND n.important'
};

// Лента колокольчика: только уведомления канала «В приложении».
export async function getNotificationFeed({ view = 'recent', limit = 20, before } = {}, user) {
  const filter = FEED_VIEWS[view] ?? '';
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 50);
  const params = [user.id];
  let cursor = '';

  if (before) {
    const date = new Date(before);
    if (!Number.isNaN(date.getTime())) {
      params.push(date.toISOString());
      cursor = ` AND n.created_at < $${params.length}`;
    }
  }

  const rows = await db.many(
    `${NOTIFICATION_SELECT} WHERE n.user_id = $1 AND n.in_app${filter}${cursor}
     ORDER BY n.created_at DESC LIMIT ${size + 1}`,
    params
  );

  return {
    items: rows.slice(0, size).map(toNotification),
    hasMore: rows.length > size,
    unread: await getUnreadCount(user)
  };
}

async function ownNotification(id, user) {
  const notificationId = optionalUuid(id, 'Уведомление не найдено.');
  const row = notificationId
    ? await db.one('SELECT id FROM notifications WHERE id = $1 AND user_id = $2', [notificationId, user.id])
    : null;
  if (!row) fail('Уведомление не найдено.', 404);
  return row.id;
}

export async function getNotification(id, user) {
  const notificationId = await ownNotification(id, user);
  return toNotification(await db.one(NOTIFICATION_SELECT + ' WHERE n.id = $1', [notificationId]));
}

export async function markRead({ id, read = true } = {}, user) {
  const notificationId = await ownNotification(id, user);
  await db.query(
    `UPDATE notifications SET read_at = CASE WHEN $2 THEN coalesce(read_at, now()) ELSE NULL END WHERE id = $1`,
    [notificationId, Boolean(read)]
  );
  return { ok: true, unread: await getUnreadCount(user) };
}

export async function markAllRead(_input, user) {
  await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [user.id]);
  return { ok: true, unread: 0 };
}

export async function setImportant({ id, important = true } = {}, user) {
  const notificationId = await ownNotification(id, user);
  await db.query('UPDATE notifications SET important = $2 WHERE id = $1', [notificationId, Boolean(important)]);
  return { ok: true };
}

// ---------- Журнал (серверная таблица) ----------

export const NOTIFICATION_LOG = {
  select: `n.*,
    c.last_name AS candidate_last_name, c.first_name AS candidate_first_name,
    c.middle_name AS candidate_middle_name, c.number AS candidate_number,
    c.archived_at AS candidate_archived_at, c.deleted_at AS candidate_deleted_at,
    (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'channel', d.channel, 'status', d.status, 'recipient', d.recipient,
        'attempts', d.attempts, 'error', d.error, 'sentAt', d.sent_at, 'updatedAt', d.updated_at
      ) ORDER BY d.channel), '[]'::jsonb)
     FROM notification_deliveries d WHERE d.notification_id = n.id) AS deliveries`,
  from: 'notifications n LEFT JOIN candidates c ON c.id = n.candidate_id',
  alias: 'n',
  stateless: true,
  filters: {
    q: { type: 'text', sql: `concat_ws(' ', n.title, n.body, n.actor_name)` },
    kind: { type: 'eq', sql: 'n.kind', allowed: KIND_KEYS },
    read: { type: 'eq', sql: `CASE WHEN n.read_at IS NULL THEN 'unread' ELSE 'read' END`, allowed: ['read', 'unread'] },
    important: { type: 'eq', sql: `CASE WHEN n.important THEN 'yes' ELSE 'no' END`, allowed: ['yes', 'no'] },
    delivery: {
      type: 'eq',
      sql: `(SELECT CASE
               WHEN bool_or(d.status = 'failed') THEN 'failed'
               WHEN bool_or(d.status = 'pending') THEN 'pending'
               WHEN bool_or(d.status = 'sent') THEN 'sent'
               WHEN count(*) > 0 THEN 'skipped'
               ELSE 'app' END
             FROM notification_deliveries d WHERE d.notification_id = n.id)`,
      allowed: ['failed', 'pending', 'sent', 'skipped', 'app']
    }
  },
  sorts: {
    createdAt: 'n.created_at',
    kind: 'n.kind',
    title: 'lower(n.title)',
    actor: 'lower(n.actor_name)',
    read: 'n.read_at',
    important: 'n.important'
  },
  defaultSort: { key: 'createdAt', dir: 'DESC' },
  tieBreaker: 'n.id',
  map: toNotification
};

// ---------- Подписка на кандидата ----------

async function assertCandidate(candidateId) {
  const id = optionalUuid(candidateId, 'Кандидат не найден.');
  const row = id ? await db.one('SELECT id FROM candidates WHERE id = $1', [id]) : null;
  if (!row) fail('Кандидат не найден.', 404);
  return row.id;
}

export async function getCandidateWatch(candidateId, user) {
  const id = await assertCandidate(candidateId);
  const row = await db.one(
    `SELECT EXISTS (SELECT 1 FROM candidate_watchers WHERE candidate_id = $1 AND user_id = $2) AS watching,
            (SELECT count(*)::int FROM candidate_watchers WHERE candidate_id = $1) AS watchers`,
    [id, user.id]
  );
  return { watching: row.watching, watchers: row.watchers };
}

export async function setCandidateWatch({ candidateId, watch = true } = {}, user) {
  const id = await assertCandidate(candidateId);

  if (watch) {
    await db.query(
      'INSERT INTO candidate_watchers (candidate_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, user.id]
    );
  } else {
    await db.query('DELETE FROM candidate_watchers WHERE candidate_id = $1 AND user_id = $2', [id, user.id]);
  }

  return getCandidateWatch(id, user);
}

// ---------- Настройки пользователя ----------

export async function getNotificationSettings(_input, user) {
  const [prefs] = [...(await loadPreferences(db, [user.id])).values()];
  const row = await db.one(
    'SELECT email, telegram_username, telegram_chat_id, telegram_verified_at FROM users WHERE id = $1',
    [user.id]
  );
  const { getBotUsername } = await import('./telegram.js');

  return {
    kinds: KINDS,
    channels: CHANNELS.map(channel => ({
      ...channel,
      available:
        channel.key === 'app' ||
        (channel.key === 'email' && smtpConfigured() && !row.email.endsWith('.invalid')) ||
        (channel.key === 'telegram' && telegramConfigured() && Boolean(row.telegram_chat_id)),
      reason:
        channel.key === 'email'
          ? !smtpConfigured()
            ? 'Отправка почты не настроена (администратор: Настройки → Интеграции → SMTP).'
            : row.email.endsWith('.invalid') ? 'У вас не указан email.' : ''
          : channel.key === 'telegram'
            ? !telegramConfigured()
              ? 'Telegram-бот не настроен (администратор: Настройки → Интеграции → Telegram).'
              : !row.telegram_chat_id ? 'Привяжите Telegram, чтобы получать уведомления.' : ''
            : ''
    })),
    preferences: prefs,
    email: row.email.endsWith('.invalid') ? '' : row.email,
    telegram: {
      botConfigured: telegramConfigured(),
      botUsername: getBotUsername(),
      username: row.telegram_username,
      linked: Boolean(row.telegram_chat_id),
      verifiedAt: row.telegram_verified_at ? toIso(row.telegram_verified_at) : ''
    }
  };
}

export async function setNotificationPreference({ kind, channel, enabled } = {}, user) {
  if (!KIND_KEYS.includes(kind)) fail('Неизвестный вид уведомления.');
  if (!CHANNEL_KEYS.includes(channel)) fail('Неизвестный канал.');

  await db.query(
    `INSERT INTO notification_preferences (user_id, kind, channel, enabled)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, kind, channel) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [user.id, kind, channel, Boolean(enabled)]
  );

  return { ok: true };
}

// Все виды разом по одному каналу (или все каналы одного вида).
export async function setNotificationPreferences({ items } = {}, user) {
  if (!Array.isArray(items) || !items.length || items.length > KIND_KEYS.length * CHANNEL_KEYS.length) {
    fail('Нет изменений.');
  }

  await transaction(async tx => {
    for (const { kind, channel, enabled } of items) {
      if (!KIND_KEYS.includes(kind) || !CHANNEL_KEYS.includes(channel)) fail('Неизвестный вид или канал.');
      await tx.query(
        `INSERT INTO notification_preferences (user_id, kind, channel, enabled)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, kind, channel) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
        [user.id, kind, channel, Boolean(enabled)]
      );
    }
  });

  return { ok: true };
}

// ---------- Обслуживание ----------

// Уведомления старше срока удаляются, кроме отмеченных важными.
export const NOTIFICATION_RETENTION_DAYS = 180;

export async function purgeOldNotifications() {
  const result = await db.query(
    `DELETE FROM notifications
     WHERE NOT important AND created_at < now() - make_interval(days => $1)`,
    [NOTIFICATION_RETENTION_DAYS]
  );
  return result.rowCount;
}
