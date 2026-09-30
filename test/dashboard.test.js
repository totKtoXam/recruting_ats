import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDateTime } from '../server/lib/dates.js';
import {
  buildSeries,
  countInPeriods,
  dayKey,
  foldTail,
  groupVacancyStages,
  homeFocus,
  normalizePeriod,
  periodBounds,
  shiftKey,
  startOfDay,
  summarizeCohort,
  summarizeTransitions,
  weekKey
} from '../server/services/dashboard.js';

const DAY = 86_400_000;

test('normalizePeriod accepts only 7, 30 and 90 days', () => {
  assert.equal(normalizePeriod(7), 7);
  assert.equal(normalizePeriod('90'), 90);
  assert.equal(normalizePeriod(15), 30);
  assert.equal(normalizePeriod(undefined), 30);
});

test('weekKey and shiftKey work on calendar days', () => {
  assert.equal(weekKey('2026-09-27'), '2026-09-21'); // воскресенье → понедельник той же недели
  assert.equal(weekKey('2026-09-21'), '2026-09-21');
  assert.equal(shiftKey('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftKey('2026-12-31', 1), '2027-01-01');
});

test('startOfDay and periodBounds are aligned to the app time zone day', () => {
  const now = new Date('2026-09-27T10:30:00Z');
  const start = startOfDay(now);
  assert.equal(formatDateTime(start), dayKey(now) + ' 00:00:00');
  assert.ok(start <= now && now.getTime() - start.getTime() < DAY);

  const { from, prevFrom } = periodBounds(7, now);
  assert.equal(dayKey(from), shiftKey(dayKey(now), -6));
  assert.equal(formatDateTime(from).slice(11), '00:00:00');
  assert.equal(from.getTime() - prevFrom.getTime(), 7 * DAY);
});

test('countInPeriods splits dates into the current and the previous period', () => {
  const now = new Date('2026-09-27T12:00:00Z');
  const bounds = periodBounds(7, now);
  const dates = [
    now,
    new Date(bounds.from.getTime() + 1000),
    new Date(bounds.from.getTime() - 1000),
    new Date(bounds.prevFrom.getTime() - 1)
  ];
  assert.deepEqual(countInPeriods(dates, bounds), { value: 2, previous: 1 });
});

test('buildSeries fills empty days and folds 90 days into ISO weeks', () => {
  const daily = buildSeries(
    { created: ['2026-09-27', '2026-09-25', '2026-09-25', '2026-09-01'] },
    { days: 7, today: '2026-09-27' }
  );
  assert.equal(daily.unit, 'day');
  assert.deepEqual(
    daily.points.map(point => point.key),
    ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']
  );
  assert.deepEqual(daily.points.map(point => point.created), [0, 0, 0, 0, 2, 0, 1]);

  const weekly = buildSeries(
    { created: ['2026-09-27', '2026-09-22'], hired: ['2026-07-06'] },
    { days: 90, today: '2026-09-27' }
  );
  assert.equal(weekly.unit, 'week');
  assert.equal(weekly.points.length, 13);
  assert.equal(weekly.points.at(-1).key, '2026-09-21');
  assert.equal(weekly.points.at(-1).created, 2);
  assert.equal(weekly.points.at(-1).hired, 0);
  assert.equal(weekly.points.find(point => point.key === '2026-07-06').hired, 1);
});

test('foldTail keeps the head and sums the rest into «Другие»', () => {
  const items = [5, 4, 3, 2, 1].map((count, index) => ({ name: 's' + index, count }));
  assert.equal(foldTail(items, 5), items);
  const folded = foldTail(items, 3);
  assert.deepEqual(folded.map(item => item.count), [5, 4, 6]);
  assert.equal(folded[2].name, 'Другие');
  assert.equal(folded[2].other, true);
  assert.equal('hired' in folded[2], false);

  const sources = [3, 2, 1].map((count, index) => ({ name: 's' + index, count, hired: index }));
  assert.deepEqual(foldTail(sources, 2)[1], { name: 'Другие', count: 3, other: true, hired: 3 });
});

test('summarizeCohort counts candidates by the furthest stage they reached', () => {
  const pipeline = ['Новый', 'HR screening', 'Проф. интервью', 'Offer', 'Hired'];
  const cohort = summarizeCohort(
    [
      { status: 'Новый', reached: ['Новый'] },
      { status: 'HR screening', reached: ['Новый', 'HR screening'] },
      // Вернули назад с проф. интервью — дошёл до него.
      { status: 'HR screening', reached: ['Новый', 'HR screening', 'Проф. интервью'] },
      // Отказ после оффера: этап отказа учитывается, «Отказано» вне воронки.
      { status: 'Отказано', rejected_from_status: 'Offer', reached: ['Отказано'] },
      { status: 'Hired', reached: [] }
    ],
    pipeline
  );
  assert.deepEqual(
    cohort.map(stage => stage.count),
    [5, 4, 3, 2, 1]
  );
  assert.equal(cohort[0].status, 'Новый');
});

test('groupVacancyStages splits candidates by stage and counts those in progress', () => {
  const grouped = groupVacancyStages([
    { vacancy_id: 'v1', status: 'Новый', count: 3, fresh: 2 },
    { vacancy_id: 'v1', status: 'Hired', count: 1, fresh: 0 },
    { vacancy_id: 'v1', status: 'Отказано', count: 4, fresh: 1 },
    { vacancy_id: 'v2', status: 'Offer', count: 1, fresh: 0 }
  ]);
  assert.deepEqual(grouped.get('v1'), { stages: { 'Новый': 3, Hired: 1, 'Отказано': 4 }, inProgress: 3, fresh: 3 });
  assert.equal(grouped.get('v2').inProgress, 1);
  assert.equal(grouped.get('v3'), undefined);
});

test('homeFocus: interviewers see their queue, everyone else — the team', () => {
  const pipeline = ['Новый', 'HR screening', 'Offer'];
  assert.equal(homeFocus({ is_admin: true, stages: ['HR screening'] }, pipeline), 'team');
  assert.equal(homeFocus({ stages: ['Новый', 'HR screening', 'Offer'] }, pipeline), 'team');
  assert.equal(homeFocus({ stages: [] }, pipeline), 'team');
  assert.equal(homeFocus({ stages: ['HR screening'] }, pipeline), 'personal');
});

test('summarizeTransitions counts hires, offers, rejections and time to hire per period', () => {
  const now = new Date('2026-09-27T12:00:00Z');
  const bounds = periodBounds(30, now);
  const at = daysAgo => new Date(now.getTime() - daysAgo * DAY).toISOString();
  const rows = [
    { to_status: 'Hired', created_at: at(1), candidate_created_at: at(21) },
    { to_status: 'Hired', created_at: at(2), candidate_created_at: at(12) },
    { to_status: 'Offer', created_at: at(3), candidate_created_at: at(10) },
    { to_status: 'Отказано', created_at: at(4), candidate_created_at: at(10), reason: 'Не подошёл по опыту', by_type: 'responsible' },
    { to_status: 'Отказано', created_at: at(5), candidate_created_at: at(10), reason: 'Не подошёл по опыту', by_type: 'responsible' },
    { to_status: 'Отказано', created_at: at(6), candidate_created_at: at(10), reason: 'Принял другой оффер', by_type: 'candidate' },
    { to_status: 'HR screening', created_at: at(7), candidate_created_at: at(10) },
    // Предыдущий период.
    { to_status: 'Hired', created_at: at(40), candidate_created_at: at(50) },
    // Вне обоих периодов.
    { to_status: 'Отказано', created_at: at(70), candidate_created_at: at(80), reason: 'Другое', by_type: 'candidate' }
  ];

  const summary = summarizeTransitions(rows, bounds);
  assert.deepEqual(summary.kpi.hired, { value: 2, previous: 1 });
  assert.deepEqual(summary.kpi.offers, { value: 1, previous: 0 });
  assert.deepEqual(summary.kpi.rejected, { value: 3, previous: 0 });
  assert.deepEqual(summary.kpi.transitions, { value: 7, previous: 1 });
  assert.deepEqual(summary.kpi.timeToHireDays, { value: 15, previous: 10 });
  assert.deepEqual(summary.rejections, {
    total: 3,
    byCandidate: 1,
    byCompany: 2,
    reasons: [
      { name: 'Не подошёл по опыту', count: 2 },
      { name: 'Принял другой оффер', count: 1 }
    ]
  });
  assert.equal(summary.keys.hired.length, 2);
  assert.equal(summary.keys.rejected.length, 3);
});

test('summarizeTransitions without hires reports no time to hire', () => {
  const now = new Date('2026-09-27T12:00:00Z');
  const summary = summarizeTransitions([], periodBounds(7, now));
  assert.deepEqual(summary.kpi.timeToHireDays, { value: null, previous: null });
  assert.deepEqual(summary.rejections.reasons, []);
});
