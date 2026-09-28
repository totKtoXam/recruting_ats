// Главная страница: сводка за период (7 / 30 / 90 дней), воронка по этапам, вакансии,
// очередь «на моём этапе», кандидаты без движения, нагрузка рекрутеров и последние события.
// Всё считается одним RPC getDashboardData, чтобы числа на виджетах не расходились между собой.
import { APP_CONFIG } from '../config.js';
import { db } from '../db/pool.js';
import { formatDateTime } from '../lib/dates.js';
import { composeFullName } from '../lib/validation.js';
import { userDisplayName } from './mappers.js';
import { getUnreadCount } from './notifications.js';

export const DASHBOARD_PERIODS = Object.freeze([7, 30, 90]);
// Кандидат «без движения», если стоит на текущем этапе дольше этого срока.
export const STALE_DAYS = 14;
const LIST_LIMIT = 8;
const RECENT_LIMIT = 6;
const ACTIVITY_LIMIT = 12;
const DAY_MS = 86_400_000;

const HIRED = 'Hired';
const OFFER = 'Offer';
const HR_SCREENING = 'HR screening';
const REJECTED = APP_CONFIG.REJECTED_STATUS;
const PROF = APP_CONFIG.PROF_INTERVIEW_STATUS;
// Этапы, на которых кандидат уже не ждёт действий.
const TERMINAL = Object.freeze([HIRED, REJECTED]);
const FUNNEL_ORDER = Object.freeze([...APP_CONFIG.PIPELINE_STATUSES, REJECTED]);

const personName = alias =>
  `concat_ws(' ', NULLIF(${alias}.last_name, ''), NULLIF(${alias}.first_name, ''), NULLIF(${alias}.middle_name, ''))`;

// ---------- Чистые помощники (проверяются в test/dashboard.test.js) ----------

export function normalizePeriod(days) {
  const value = Number(days);
  return DASHBOARD_PERIODS.includes(value) ? value : 30;
}

// «YYYY-MM-DD» в часовом поясе приложения.
export function dayKey(value) {
  return formatDateTime(value).slice(0, 10);
}

function parseKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

// Ключ дня, сдвинутый на days календарных дней.
export function shiftKey(key, days) {
  return new Date(parseKey(key) + days * DAY_MS).toISOString().slice(0, 10);
}

// Понедельник ISO-недели, в которую входит день key.
export function weekKey(key) {
  const weekday = (new Date(parseKey(key)).getUTCDay() + 6) % 7;
  return shiftKey(key, -weekday);
}

// Начало календарного дня (в поясе приложения), в который попадает момент now.
export function startOfDay(now) {
  const moment = new Date(Math.floor(now.getTime() / 1000) * 1000);
  const [date, time] = formatDateTime(moment).split(' ');
  const [hh, mm, ss] = time.split(':').map(Number);
  const wallClockAsUtc = parseKey(date) + ((hh * 60 + mm) * 60 + ss) * 1000;
  const offset = wallClockAsUtc - moment.getTime();
  return new Date(parseKey(date) - offset);
}

// Период — последние days календарных дней включая сегодня; предыдущий — такой же длины перед ним.
export function periodBounds(days, now = new Date()) {
  const today = startOfDay(now);
  const from = new Date(today.getTime() - (days - 1) * DAY_MS);
  const prevFrom = new Date(from.getTime() - days * DAY_MS);
  return { from, prevFrom, now };
}

// Сколько моментов попало в текущий и в предыдущий период.
export function countInPeriods(dates, { from, prevFrom }) {
  let value = 0;
  let previous = 0;
  for (const raw of dates) {
    const time = new Date(raw).getTime();
    if (time >= from.getTime()) value += 1;
    else if (time >= prevFrom.getTime()) previous += 1;
  }
  return { value, previous };
}

// Ряд с нулями для пустых дней (до 31 дня) или недель (дальше; ISO-недели с понедельника).
// groups: { имя: [ключи дней] } → { unit, points: [{ key, имя: число, … }] }.
export function buildSeries(groups, { days, today }) {
  const unit = days > 31 ? 'week' : 'day';
  const keys = [];
  if (unit === 'day') {
    for (let i = days - 1; i >= 0; i -= 1) keys.push(shiftKey(today, -i));
  } else {
    // Недели покрывают весь период: от недели первого дня до недели сегодняшнего.
    const last = weekKey(today);
    for (let key = weekKey(shiftKey(today, -(days - 1))); key <= last; key = shiftKey(key, 7)) keys.push(key);
  }
  const names = Object.keys(groups);
  const points = keys.map(key => ({ key, ...Object.fromEntries(names.map(name => [name, 0])) }));
  const index = new Map(keys.map((key, i) => [key, i]));
  for (const name of names) {
    for (const key of groups[name]) {
      const i = index.get(unit === 'day' ? key : weekKey(key));
      if (i !== undefined) points[i][name] += 1;
    }
  }
  return { unit, points };
}

// Длинный хвост списка сворачивается в «Другие».
export function foldTail(items, max = 7, otherLabel = 'Другие') {
  if (items.length <= max) return items;
  const rest = items.slice(max - 1).reduce((sum, item) => sum + item.count, 0);
  return [...items.slice(0, max - 1), { name: otherLabel, count: rest, other: true }];
}

function average(values) {
  if (!values.length) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

// Переходы за два периода: наймы, офферы, отказы, среднее время найма и причины отказов.
// rows: { to_status, created_at, candidate_created_at, reason, by_type }.
export function summarizeTransitions(rows, { from, prevFrom }) {
  const counters = { transitions: [0, 0], hired: [0, 0], offers: [0, 0], rejected: [0, 0] };
  const hireDays = [[], []];
  const keys = { hired: [], rejected: [] };
  const reasons = new Map();
  let byCandidate = 0;
  let byCompany = 0;

  for (const row of rows) {
    const time = new Date(row.created_at).getTime();
    const slot = time >= from.getTime() ? 0 : time >= prevFrom.getTime() ? 1 : -1;
    if (slot < 0) continue;
    counters.transitions[slot] += 1;

    if (row.to_status === HIRED) {
      counters.hired[slot] += 1;
      if (row.candidate_created_at) {
        hireDays[slot].push((time - new Date(row.candidate_created_at).getTime()) / DAY_MS);
      }
    } else if (row.to_status === OFFER) {
      counters.offers[slot] += 1;
    } else if (row.to_status === REJECTED) {
      counters.rejected[slot] += 1;
    }

    if (slot !== 0) continue;
    if (row.to_status === HIRED) keys.hired.push(dayKey(row.created_at));
    if (row.to_status === REJECTED) {
      keys.rejected.push(dayKey(row.created_at));
      const reason = row.reason || 'Причина не указана';
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
      if (row.by_type === APP_CONFIG.REJECTED_BY_CANDIDATE) byCandidate += 1;
      else byCompany += 1;
    }
  }

  const pair = ([value, previous]) => ({ value, previous });
  return {
    kpi: {
      transitions: pair(counters.transitions),
      hired: pair(counters.hired),
      offers: pair(counters.offers),
      rejected: pair(counters.rejected),
      timeToHireDays: { value: average(hireDays[0]), previous: average(hireDays[1]) }
    },
    keys,
    rejections: {
      total: counters.rejected[0],
      byCandidate,
      byCompany,
      reasons: [...reasons]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'))
    }
  };
}

// ---------- Запросы ----------

const daysBetween = (since, now) =>
  Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / DAY_MS));

function candidateItem(row, now) {
  return {
    id: row.id,
    number: row.number,
    name: composeFullName(row.last_name, row.first_name, row.middle_name),
    status: row.status,
    vacancy: row.vacancy_name || '',
    vacancyNumber: row.vacancy_number,
    recruiter: row.recruiter_name || '',
    stageSince: formatDateTime(row.stage_since),
    days: daysBetween(row.stage_since, now)
  };
}

// Кандидаты в работе с датой попадания на текущий этап (последний переход либо создание).
// count(*) OVER() — общее число подходящих строк, LIMIT его не обрезает.
const IN_PROGRESS_SELECT = `
  SELECT c.id, c.number, c.last_name, c.first_name, c.middle_name, c.status,
         v.name AS vacancy_name, v.number AS vacancy_number,
         ${personName('rec')} AS recruiter_name,
         coalesce(lm.at, c.created_at) AS stage_since,
         count(*) OVER()::int AS total
  FROM candidates c
  JOIN vacancies v ON v.id = c.vacancy_id
  LEFT JOIN users rec ON rec.id = c.recruiter_id
  LEFT JOIN LATERAL (
    SELECT max(l.created_at) AS at FROM candidate_status_log l WHERE l.candidate_id = c.id
  ) lm ON true
  WHERE c.archived_at IS NULL AND c.deleted_at IS NULL AND c.status <> ALL($1::text[])`;

const ACTIVE = 'c.archived_at IS NULL AND c.deleted_at IS NULL';

export async function getDashboardData(input = {}, user) {
  const days = normalizePeriod(input && input.days);
  const isAdmin = Boolean(user && user.is_admin);
  const now = new Date();
  const { from, prevFrom } = periodBounds(days, now);
  const today = dayKey(now);
  const staleBefore = new Date(now.getTime() - STALE_DAYS * DAY_MS);

  const [
    totals,
    funnelRows,
    createdRows,
    logRows,
    sourceRows,
    vacancyRows,
    vacancyCountRows,
    staleRows,
    queueRows,
    myCounts,
    recentRows,
    workloadRows,
    activityRows,
    notificationsUnread
  ] = await Promise.all([
    db.one(
      `SELECT count(*) FILTER (WHERE ${ACTIVE})::int AS active,
              count(*) FILTER (WHERE ${ACTIVE} AND c.status <> ALL($1::text[]))::int AS in_progress,
              count(*) FILTER (WHERE ${ACTIVE} AND c.status = $2)::int AS hired,
              count(*) FILTER (WHERE ${ACTIVE} AND c.status = $3)::int AS rejected,
              count(*) FILTER (WHERE c.archived_at IS NOT NULL AND c.deleted_at IS NULL)::int AS archived,
              count(*) FILTER (WHERE c.deleted_at IS NOT NULL)::int AS deleted
       FROM candidates c`,
      [TERMINAL, HIRED, REJECTED]
    ),
    db.many(`SELECT c.status, count(*)::int AS count FROM candidates c WHERE ${ACTIVE} GROUP BY c.status`),
    db.many('SELECT created_at FROM candidates WHERE deleted_at IS NULL AND created_at >= $1', [prevFrom]),
    db.many(
      `SELECT l.to_status, l.created_at, c.created_at AS candidate_created_at,
              l.details -> 'rejection' ->> 'reason' AS reason,
              l.details -> 'rejection' ->> 'byType' AS by_type
       FROM candidate_status_log l
       JOIN candidates c ON c.id = l.candidate_id
       WHERE c.deleted_at IS NULL AND l.created_at >= $1`,
      [prevFrom]
    ),
    db.many(
      `SELECT s.id AS source_id, coalesce(s.name, '') AS name, count(*)::int AS count
       FROM candidates c
       LEFT JOIN sources s ON s.id = c.source_id
       WHERE c.deleted_at IS NULL AND c.created_at >= $1
       GROUP BY s.id, s.name
       ORDER BY count DESC, name`,
      [from]
    ),
    db.many(
      `SELECT v.id, v.number, v.name, v.status, v.created_at,
              count(c.id) FILTER (WHERE ${ACTIVE} AND c.status <> ALL($1::text[]))::int AS in_progress,
              count(c.id) FILTER (WHERE ${ACTIVE} AND c.status = $2)::int AS offers,
              count(c.id) FILTER (WHERE ${ACTIVE} AND c.status = $3)::int AS hired,
              count(c.id) FILTER (WHERE c.deleted_at IS NULL AND c.created_at >= $4)::int AS created
       FROM vacancies v
       LEFT JOIN candidates c ON c.vacancy_id = v.id
       WHERE v.archived_at IS NULL AND v.deleted_at IS NULL
       GROUP BY v.id
       ORDER BY array_position(ARRAY['Открыта', 'На паузе', 'Закрыта'], v.status), in_progress DESC, v.number DESC
       LIMIT $5`,
      [TERMINAL, OFFER, HIRED, from, LIST_LIMIT]
    ),
    db.many(
      'SELECT status, count(*)::int AS count FROM vacancies WHERE archived_at IS NULL AND deleted_at IS NULL GROUP BY status'
    ),
    db.many(
      `${IN_PROGRESS_SELECT} AND coalesce(lm.at, c.created_at) < $2 ORDER BY stage_since ASC LIMIT $3`,
      [TERMINAL, staleBefore, LIST_LIMIT]
    ),
    // На моём этапе: HR screening — HR, проф. интервью — проф. интервьювер, остальные этапы — рекрутер.
    db.many(
      `${IN_PROGRESS_SELECT}
         AND ((c.status = $2 AND c.hr_responsible_id = $4)
           OR (c.status = $3 AND c.tech_interviewer_id = $4)
           OR (c.status <> $2 AND c.status <> $3 AND c.recruiter_id = $4))
       ORDER BY stage_since ASC LIMIT $5`,
      [TERMINAL, HR_SCREENING, PROF, user.id, LIST_LIMIT]
    ),
    db.one(
      `SELECT count(*) FILTER (WHERE c.recruiter_id = $2 OR c.hr_responsible_id = $2 OR c.tech_interviewer_id = $2)::int AS mine
       FROM candidates c
       WHERE ${ACTIVE} AND c.status <> ALL($1::text[])`,
      [TERMINAL, user.id]
    ),
    db.many(
      `SELECT c.id, c.number, c.last_name, c.first_name, c.middle_name, c.status, c.created_at, c.archived_at,
              v.name AS vacancy_name, v.number AS vacancy_number, s.name AS source_name
       FROM candidates c
       JOIN vacancies v ON v.id = c.vacancy_id
       LEFT JOIN sources s ON s.id = c.source_id
       WHERE c.deleted_at IS NULL
       ORDER BY c.created_at DESC
       LIMIT $1`,
      [RECENT_LIMIT]
    ),
    db.many(
      `SELECT u.id, u.last_name, u.first_name, u.middle_name, u.full_name, u.email,
              count(c.id) FILTER (WHERE c.status <> ALL($1::text[]))::int AS in_progress,
              count(c.id) FILTER (WHERE c.status = $2)::int AS offers,
              count(c.id)::int AS total
       FROM candidates c
       JOIN users u ON u.id = c.recruiter_id
       WHERE ${ACTIVE}
       GROUP BY u.id
       ORDER BY in_progress DESC, u.last_name, u.first_name
       LIMIT $3`,
      [TERMINAL, OFFER, LIST_LIMIT]
    ),
    // Журнал изменений пользователей видят только администраторы (как и в истории записи).
    db.many(
      `SELECT a.id, a.entity_type, a.entity_id, a.action, a.field, a.field_label,
              a.old_display, a.new_display, a.actor_name, a.created_at,
              CASE a.entity_type
                WHEN 'candidate' THEN (SELECT concat_ws(' ', nullif(c.last_name, ''), nullif(c.first_name, '')) FROM candidates c WHERE c.id = a.entity_id)
                WHEN 'interview' THEN (SELECT concat_ws(' ', nullif(c.last_name, ''), nullif(c.first_name, ''))
                                       FROM interviews i JOIN candidates c ON c.id = i.candidate_id WHERE i.id = a.entity_id)
                WHEN 'vacancy'   THEN (SELECT v.name FROM vacancies v WHERE v.id = a.entity_id)
                WHEN 'source'    THEN (SELECT s.name FROM sources s WHERE s.id = a.entity_id)
                WHEN 'template'  THEN (SELECT t.name FROM interview_templates t WHERE t.id = a.entity_id)
                WHEN 'user'      THEN (SELECT coalesce(nullif(concat_ws(' ', nullif(u.last_name, ''), nullif(u.first_name, '')), ''), u.email)
                                       FROM users u WHERE u.id = a.entity_id)
              END AS entity_label,
              CASE a.entity_type
                WHEN 'candidate' THEN a.entity_id
                WHEN 'interview' THEN (SELECT i.candidate_id FROM interviews i WHERE i.id = a.entity_id)
              END AS candidate_id
       FROM audit_log a
       WHERE $1::boolean OR a.entity_type <> 'user'
       ORDER BY a.created_at DESC
       LIMIT $2`,
      [isAdmin, ACTIVITY_LIMIT]
    ),
    getUnreadCount(user)
  ]);

  const funnelCounts = Object.fromEntries(funnelRows.map(row => [row.status, row.count]));
  const funnel = FUNNEL_ORDER.map(status => ({ status, count: funnelCounts[status] || 0 }));
  // Статусы вне справочника (после переименований) — в конец, чтобы сумма сходилась.
  for (const row of funnelRows) {
    if (!FUNNEL_ORDER.includes(row.status)) funnel.push({ status: row.status, count: row.count });
  }

  const bounds = { from, prevFrom };
  const created = countInPeriods(createdRows.map(row => row.created_at), bounds);
  const transitions = summarizeTransitions(logRows, bounds);
  const series = buildSeries(
    {
      created: createdRows
        .filter(row => new Date(row.created_at).getTime() >= from.getTime())
        .map(row => dayKey(row.created_at)),
      hired: transitions.keys.hired,
      rejected: transitions.keys.rejected
    },
    { days, today }
  );
  const vacancyCounts = Object.fromEntries(vacancyCountRows.map(row => [row.status, row.count]));

  return {
    days,
    period: { days, from: formatDateTime(from), to: formatDateTime(now), staleDays: STALE_DAYS },
    generatedAt: now.toISOString(),
    totals: {
      active: totals.active,
      inProgress: totals.in_progress,
      hired: totals.hired,
      rejected: totals.rejected,
      archived: totals.archived,
      deleted: isAdmin ? totals.deleted : null
    },
    kpi: { created, ...transitions.kpi },
    funnel,
    series,
    sources: foldTail(
      sourceRows.map(row => ({ sourceId: row.source_id || '', name: row.name || 'Не указан', count: row.count }))
    ),
    rejections: { ...transitions.rejections, reasons: foldTail(transitions.rejections.reasons, 6) },
    vacancies: {
      counts: {
        open: vacancyCounts['Открыта'] || 0,
        paused: vacancyCounts['На паузе'] || 0,
        closed: vacancyCounts['Закрыта'] || 0
      },
      items: vacancyRows.map(row => ({
        id: row.id,
        number: row.number,
        name: row.name,
        status: row.status,
        inProgress: row.in_progress,
        offers: row.offers,
        hired: row.hired,
        created: row.created,
        daysOpen: daysBetween(row.created_at, now)
      }))
    },
    stale: {
      thresholdDays: STALE_DAYS,
      total: staleRows.length ? staleRows[0].total : 0,
      items: staleRows.map(row => candidateItem(row, now))
    },
    my: {
      mine: myCounts.mine,
      queueTotal: queueRows.length ? queueRows[0].total : 0,
      queue: queueRows.map(row => candidateItem(row, now))
    },
    recent: recentRows.map(row => ({
      id: row.id,
      number: row.number,
      name: composeFullName(row.last_name, row.first_name, row.middle_name),
      status: row.status,
      vacancy: row.vacancy_name || '',
      vacancyNumber: row.vacancy_number,
      source: row.source_name || '',
      createdAt: formatDateTime(row.created_at),
      archived: Boolean(row.archived_at)
    })),
    workload: workloadRows.map(row => ({
      userId: row.id,
      name: userDisplayName(row),
      inProgress: row.in_progress,
      offers: row.offers,
      total: row.total
    })),
    activity: activityRows.map(row => ({
      id: row.id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      candidateId: row.candidate_id || '',
      action: row.action,
      field: row.field,
      fieldLabel: row.field_label,
      oldDisplay: row.old_display,
      newDisplay: row.new_display,
      actorName: row.actor_name || 'Система',
      entityLabel: row.entity_label || '',
      createdAt: new Date(row.created_at).toISOString()
    })),
    notificationsUnread
  };
}
