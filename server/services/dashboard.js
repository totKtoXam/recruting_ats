// Сводки по найму. Три RPC собираются из одних и тех же запросов, поэтому числа не расходятся:
// - getHomeData — главная «Мой день»: текущее состояние без периода (очередь, зависшие, вакансии, события);
// - getAnalyticsData — страница «Аналитика»: показатели за период (7 / 30 / 90 дней) и нагрузка;
// - getDashboardData — всё сразу в прежнем формате (MCP-инструмент get_dashboard).
import { APP_CONFIG } from '../config.js';
import { db } from '../db/pool.js';
import { formatDateTime } from '../lib/dates.js';
import { composeFullName } from '../lib/validation.js';
import { userDisplayName } from './mappers.js';
import { getUnreadCount } from './notifications.js';
import { entryDisplays } from './audit.js';

export const DASHBOARD_PERIODS = Object.freeze([7, 30, 90]);
// Кандидат «без движения», если стоит на текущем этапе дольше этого срока.
export const STALE_DAYS = 14;
const LIST_LIMIT = 8;
// На главной очередь и зависшие раскрываются целиком по кнопке «Показать все».
const HOME_LIST_LIMIT = 50;
const HOME_VACANCY_LIMIT = 12;
// «Новых за неделю» в строке вакансии на главной.
const FRESH_DAYS = 7;
const RECENT_LIMIT = 6;
// Последние события: на главной — короткая лента, в полной сводке (MCP) — как раньше.
const HOME_ACTIVITY_LIMIT = 6;
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

// Длинный хвост списка сворачивается в «Другие» (наймы из источников — тоже суммой).
export function foldTail(items, max = 7, otherLabel = 'Другие') {
  if (items.length <= max) return items;
  const tail = items.slice(max - 1);
  const other = { name: otherLabel, count: tail.reduce((sum, item) => sum + item.count, 0), other: true };
  if (tail.some(item => item.hired !== undefined)) other.hired = tail.reduce((sum, item) => sum + (item.hired || 0), 0);
  return [...items.slice(0, max - 1), other];
}

// Конверсия когорты: сколько кандидатов, пришедших за период, дошли до каждого этапа воронки.
// Этапы проходятся по порядку (переходы только на соседний), поэтому «дошёл» = самый дальний
// из этапов в журнале переходов, текущего статуса и этапа, с которого отказали.
// rows: { status, rejected_from_status, reached: [to_status] } → [{ status, count }].
export function summarizeCohort(rows, pipeline = APP_CONFIG.PIPELINE_STATUSES) {
  const counts = pipeline.map(() => 0);
  for (const row of rows) {
    const stages = [row.status, row.rejected_from_status, ...(row.reached || [])];
    const furthest = Math.max(0, ...stages.map(stage => pipeline.indexOf(stage)));
    for (let i = 0; i <= furthest; i += 1) counts[i] += 1;
  }
  return pipeline.map((status, i) => ({ status, count: counts[i] }));
}

// Кандидаты вакансий по этапам: rows { vacancy_id, status, count, fresh } → Map id → { stages, inProgress, fresh }.
export function groupVacancyStages(rows) {
  const byVacancy = new Map();
  for (const row of rows) {
    const entry = byVacancy.get(row.vacancy_id) || { stages: {}, inProgress: 0, fresh: 0 };
    entry.stages[row.status] = (entry.stages[row.status] || 0) + row.count;
    if (!TERMINAL.includes(row.status)) entry.inProgress += row.count;
    entry.fresh += row.fresh || 0;
    byVacancy.set(row.vacancy_id, entry);
  }
  return byVacancy;
}

// Интервьюер (отвечает только за часть этапов) видит на главной свою очередь и уведомления;
// рекрутер (все этапы), администратор и наблюдатель без этапов — ещё и командные блоки.
export function homeFocus(user, pipeline = APP_CONFIG.PIPELINE_STATUSES) {
  if (!user || user.is_admin) return 'team';
  const stages = user.stages || [];
  return !stages.length || pipeline.every(stage => stages.includes(stage)) ? 'team' : 'personal';
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

// Список кандидатов с общим числом: { total, items }.
const candidateList = (rows, now) => ({
  total: rows.length ? rows[0].total : 0,
  items: rows.map(row => candidateItem(row, now))
});

function queryTotals() {
  return db.one(
    `SELECT count(*) FILTER (WHERE ${ACTIVE})::int AS active,
            count(*) FILTER (WHERE ${ACTIVE} AND c.status <> ALL($1::text[]))::int AS in_progress,
            count(*) FILTER (WHERE ${ACTIVE} AND c.status = $2)::int AS hired,
            count(*) FILTER (WHERE ${ACTIVE} AND c.status = $3)::int AS rejected,
            count(*) FILTER (WHERE ${ACTIVE} AND c.status = $4)::int AS offers,
            count(*) FILTER (WHERE c.archived_at IS NOT NULL AND c.deleted_at IS NULL)::int AS archived,
            count(*) FILTER (WHERE c.deleted_at IS NOT NULL)::int AS deleted
     FROM candidates c`,
    [TERMINAL, HIRED, REJECTED, OFFER]
  );
}

function queryStale(now, limit) {
  return db.many(
    `${IN_PROGRESS_SELECT} AND coalesce(lm.at, c.created_at) < $2 ORDER BY stage_since ASC LIMIT $3`,
    [TERMINAL, new Date(now.getTime() - STALE_DAYS * DAY_MS), limit]
  );
}

// На моём этапе: HR screening — HR, проф. интервью — проф. интервьювер, остальные этапы — рекрутер.
function queryQueue(user, limit) {
  return db.many(
    `${IN_PROGRESS_SELECT}
       AND ((c.status = $2 AND c.hr_responsible_id = $4)
         OR (c.status = $3 AND c.tech_interviewer_id = $4)
         OR (c.status <> $2 AND c.status <> $3 AND c.recruiter_id = $4))
     ORDER BY stage_since ASC LIMIT $5`,
    [TERMINAL, HR_SCREENING, PROF, user.id, limit]
  );
}

function queryMine(user) {
  return db.one(
    `SELECT count(*) FILTER (WHERE c.recruiter_id = $2 OR c.hr_responsible_id = $2 OR c.tech_interviewer_id = $2)::int AS mine
     FROM candidates c
     WHERE ${ACTIVE} AND c.status <> ALL($1::text[])`,
    [TERMINAL, user.id]
  );
}

async function queryVacancyCounts() {
  const rows = await db.many(
    'SELECT status, count(*)::int AS count FROM vacancies WHERE archived_at IS NULL AND deleted_at IS NULL GROUP BY status'
  );
  const counts = Object.fromEntries(rows.map(row => [row.status, row.count]));
  return { open: counts['Открыта'] || 0, paused: counts['На паузе'] || 0, closed: counts['Закрыта'] || 0 };
}

async function queryWorkload() {
  const rows = await db.many(
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
  );
  return rows.map(row => ({
    userId: row.id,
    name: userDisplayName(row),
    inProgress: row.in_progress,
    offers: row.offers,
    total: row.total
  }));
}

// Журнал изменений пользователей видят только администраторы (как и в истории записи).
async function queryActivity(user, limit) {
  const rows = await db.many(
    `SELECT a.id, a.entity_type, a.entity_id, a.action, a.field, a.field_label,
            a.old_display, a.new_display, a.actor_name, a.created_at,
            CASE a.entity_type
              WHEN 'candidate' THEN (SELECT concat_ws(' ', nullif(c.last_name, ''), nullif(c.first_name, '')) FROM candidates c WHERE c.id = a.entity_id)
              WHEN 'interview' THEN (SELECT concat_ws(' ', nullif(c.last_name, ''), nullif(c.first_name, ''))
                                     FROM interviews i JOIN candidates c ON c.id = i.candidate_id WHERE i.id = a.entity_id)
              WHEN 'vacancy'   THEN (SELECT v.name FROM vacancies v WHERE v.id = a.entity_id)
              WHEN 'source'    THEN (SELECT s.name FROM sources s WHERE s.id = a.entity_id)
              WHEN 'template'  THEN (SELECT t.name FROM interview_templates t WHERE t.id = a.entity_id)
              WHEN 'vacancy_preset' THEN (SELECT p.name FROM vacancy_presets p WHERE p.id = a.entity_id)
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
    [Boolean(user && user.is_admin), limit]
  );
  return rows.map(row => ({
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    candidateId: row.candidate_id || '',
    action: row.action,
    field: row.field,
    fieldLabel: row.field_label,
    ...entryDisplays(row, user),
    actorName: row.actor_name || 'Система',
    entityLabel: row.entity_label || '',
    createdAt: new Date(row.created_at).toISOString()
  }));
}

// Показатели за период и предыдущий период той же длины: KPI, ряд по дням/неделям,
// источники с наймами, причины отказа и конверсия новых кандидатов по этапам.
async function queryPeriod(days, now) {
  const { from, prevFrom } = periodBounds(days, now);
  const [createdRows, logRows, sourceRows, cohortRows] = await Promise.all([
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
      `SELECT s.id AS source_id, coalesce(s.name, '') AS name, count(*)::int AS count,
              count(*) FILTER (WHERE c.status = $2)::int AS hired
       FROM candidates c
       LEFT JOIN sources s ON s.id = c.source_id
       WHERE c.deleted_at IS NULL AND c.created_at >= $1
       GROUP BY s.id, s.name
       ORDER BY count DESC, name`,
      [from, HIRED]
    ),
    db.many(
      `SELECT c.status, c.rejected_from_status,
              coalesce(array_agg(DISTINCT l.to_status) FILTER (WHERE l.to_status IS NOT NULL), '{}') AS reached
       FROM candidates c
       LEFT JOIN candidate_status_log l ON l.candidate_id = c.id
       WHERE c.deleted_at IS NULL AND c.created_at >= $1
       GROUP BY c.id`,
      [from]
    )
  ]);

  const bounds = { from, prevFrom };
  const transitions = summarizeTransitions(logRows, bounds);
  const series = buildSeries(
    {
      created: createdRows
        .filter(row => new Date(row.created_at).getTime() >= from.getTime())
        .map(row => dayKey(row.created_at)),
      hired: transitions.keys.hired,
      rejected: transitions.keys.rejected
    },
    { days, today: dayKey(now) }
  );

  return {
    days,
    from,
    period: { days, from: formatDateTime(from), to: formatDateTime(now), staleDays: STALE_DAYS },
    kpi: { created: countInPeriods(createdRows.map(row => row.created_at), bounds), ...transitions.kpi },
    series,
    cohort: summarizeCohort(cohortRows),
    sources: foldTail(
      sourceRows.map(row => ({
        sourceId: row.source_id || '',
        name: row.name || 'Не указан',
        count: row.count,
        hired: row.hired
      }))
    ),
    rejections: { ...transitions.rejections, reasons: foldTail(transitions.rejections.reasons, 6) }
  };
}

const publicTotals = totals => ({ inProgress: totals.in_progress, offers: totals.offers, hired: totals.hired });

// ---------- RPC ----------

// Главная «Мой день»: только текущее состояние, без периода.
export async function getHomeData(_input, user) {
  const now = new Date();
  const freshFrom = new Date(now.getTime() - FRESH_DAYS * DAY_MS);
  const [totals, queueRows, staleRows, myCounts, vacancyRows, stageRows, vacancyCounts, activity, notificationsUnread] =
    await Promise.all([
      queryTotals(),
      queryQueue(user, HOME_LIST_LIMIT),
      queryStale(now, HOME_LIST_LIMIT),
      queryMine(user),
      db.many(
        `SELECT v.id, v.number, v.name, v.status, v.created_at
         FROM vacancies v
         WHERE v.archived_at IS NULL AND v.deleted_at IS NULL AND v.status <> 'Закрыта'
         ORDER BY array_position(ARRAY['Открыта', 'На паузе'], v.status), v.number DESC
         LIMIT $1`,
        [HOME_VACANCY_LIMIT]
      ),
      db.many(
        `SELECT c.vacancy_id, c.status, count(*)::int AS count,
                count(*) FILTER (WHERE c.created_at >= $1)::int AS fresh
         FROM candidates c
         WHERE ${ACTIVE}
         GROUP BY c.vacancy_id, c.status`,
        [freshFrom]
      ),
      queryVacancyCounts(),
      queryActivity(user, HOME_ACTIVITY_LIMIT),
      getUnreadCount(user)
    ]);

  const stages = groupVacancyStages(stageRows);
  return {
    generatedAt: now.toISOString(),
    focus: homeFocus(user),
    staleDays: STALE_DAYS,
    freshDays: FRESH_DAYS,
    totals: publicTotals(totals),
    my: { mine: myCounts.mine, ...candidateList(queueRows, now) },
    stale: candidateList(staleRows, now),
    vacancies: {
      counts: vacancyCounts,
      items: vacancyRows.map(row => {
        const entry = stages.get(row.id) || { stages: {}, inProgress: 0, fresh: 0 };
        return {
          id: row.id,
          number: row.number,
          name: row.name,
          status: row.status,
          stages: entry.stages,
          inProgress: entry.inProgress,
          fresh: entry.fresh,
          daysOpen: daysBetween(row.created_at, now)
        };
      })
    },
    activity,
    notificationsUnread
  };
}

// Страница «Аналитика»: показатели за период и нагрузка рекрутеров сейчас.
export async function getAnalyticsData(input = {}) {
  const days = normalizePeriod(input && input.days);
  const now = new Date();
  const [{ from: _from, ...period }, totals, workload] = await Promise.all([
    queryPeriod(days, now),
    queryTotals(),
    queryWorkload()
  ]);
  return { ...period, generatedAt: now.toISOString(), totals: publicTotals(totals), workload };
}

// Всё сразу в прежнем формате — для MCP-инструмента get_dashboard.
export async function getDashboardData(input = {}, user) {
  const days = normalizePeriod(input && input.days);
  const isAdmin = Boolean(user && user.is_admin);
  const now = new Date();

  const [
    period,
    totals,
    funnelRows,
    vacancyRows,
    vacancyCounts,
    staleRows,
    queueRows,
    myCounts,
    recentRows,
    workload,
    activity,
    notificationsUnread
  ] = await Promise.all([
    queryPeriod(days, now),
    queryTotals(),
    db.many(`SELECT c.status, count(*)::int AS count FROM candidates c WHERE ${ACTIVE} GROUP BY c.status`),
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
      [TERMINAL, OFFER, HIRED, periodBounds(days, now).from, LIST_LIMIT]
    ),
    queryVacancyCounts(),
    queryStale(now, LIST_LIMIT),
    queryQueue(user, LIST_LIMIT),
    queryMine(user),
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
    queryWorkload(),
    queryActivity(user, ACTIVITY_LIMIT),
    getUnreadCount(user)
  ]);

  const funnelCounts = Object.fromEntries(funnelRows.map(row => [row.status, row.count]));
  const funnel = FUNNEL_ORDER.map(status => ({ status, count: funnelCounts[status] || 0 }));
  // Статусы вне справочника (после переименований) — в конец, чтобы сумма сходилась.
  for (const row of funnelRows) {
    if (!FUNNEL_ORDER.includes(row.status)) funnel.push({ status: row.status, count: row.count });
  }
  const queue = candidateList(queueRows, now);

  return {
    days,
    period: period.period,
    generatedAt: now.toISOString(),
    totals: {
      active: totals.active,
      inProgress: totals.in_progress,
      hired: totals.hired,
      rejected: totals.rejected,
      archived: totals.archived,
      deleted: isAdmin ? totals.deleted : null
    },
    kpi: period.kpi,
    funnel,
    series: period.series,
    sources: period.sources,
    rejections: period.rejections,
    vacancies: {
      counts: vacancyCounts,
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
    stale: { thresholdDays: STALE_DAYS, ...candidateList(staleRows, now) },
    my: { mine: myCounts.mine, queueTotal: queue.total, queue: queue.items },
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
    workload,
    activity,
    notificationsUnread
  };
}
