// Поиск похожих кандидатов при заполнении карточки — чтобы не завести дубль.
// ФИО сравниваются по «скелету» имени (регистр, лишние пробелы, ё/е, латиница и кириллица,
// варианты транслитерации не считаются различием) расстоянием Дамерау — Левенштейна;
// email, телефон и Telegram — точно.
import { db } from '../db/pool.js';
import { skeleton } from '../lib/person-names.js';
import { similarity } from '../lib/text-distance.js';
import { clean } from '../lib/validation.js';

const NAME_THRESHOLD = 0.8;
const LIMIT = 5;

const nameKey = value => skeleton(clean(value).replace(/[-'’`]/g, ''));
const digits = value => {
  const raw = clean(value).replace(/\D/g, '');
  if (raw.length === 11 && raw.startsWith('8')) return '7' + raw.slice(1);
  if (raw.length === 10 && raw.startsWith('7')) return '7' + raw;
  return raw;
};
const tgKey = value => clean(value).toLowerCase().replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '');

// Оценка сходства ФИО (0..1) или 0, если непохожи. Чистая функция — для тестов.
export function nameSimilarity(input, candidate) {
  const last = nameKey(input.lastName);
  const first = nameKey(input.firstName);
  const middle = nameKey(input.middleName);
  const cLast = nameKey(candidate.lastName);
  const cFirst = nameKey(candidate.firstName);
  const cMiddle = nameKey(candidate.middleName);

  let score = 0;
  if (last && first) {
    // Порядок «Фамилия Имя» мог быть перепутан — сравниваем и крест-накрест.
    const direct = Math.min(similarity(last, cLast), similarity(first, cFirst));
    const swapped = Math.min(similarity(last, cFirst), similarity(first, cLast));
    score = Math.max(direct, swapped);
    if (score < NAME_THRESHOLD) {
      const full = last + first;
      score = Math.max(similarity(full, cLast + cFirst), similarity(full, cFirst + cLast));
    }
  } else if (last) {
    score = Math.max(similarity(last, cLast), similarity(last, cFirst));
    if (last.length < 4) score = 0;
  } else if (first) {
    score = Math.max(similarity(first, cFirst), similarity(first, cLast));
    if (first.length < 4 || score < 0.9) score = 0;
  }

  // Разные отчества при похожих фамилии и имени — скорее разные люди.
  if (score >= NAME_THRESHOLD && middle && cMiddle && similarity(middle, cMiddle) < 0.6) score -= 0.15;
  return score >= NAME_THRESHOLD ? Math.round(score * 100) / 100 : 0;
}

export function matchCandidate(input, candidate) {
  const matchedBy = [];
  const email = clean(input.email).toLowerCase();
  const phone = digits(input.phone);
  const telegram = tgKey(input.telegram);
  if (email && clean(candidate.email).toLowerCase() === email) matchedBy.push('email');
  if (phone.length >= 10 && digits(candidate.phone) === phone) matchedBy.push('phone');
  if (telegram && tgKey(candidate.telegram) === telegram) matchedBy.push('telegram');
  const nameScore = nameSimilarity(input, candidate);
  if (nameScore) matchedBy.push('name');
  if (!matchedBy.length) return null;
  return { matchedBy, nameScore, score: matchedBy.length > 1 || matchedBy[0] !== 'name' ? 1 : nameScore };
}

export async function findSimilarCandidates(input = {}) {
  const excludeId = clean(input.excludeId);
  const hasName = nameKey(input.lastName).length >= 2 || nameKey(input.firstName).length >= 2;
  if (!hasName && !clean(input.email) && digits(input.phone).length < 10 && !clean(input.telegram)) return [];

  const rows = await db.many(
    `SELECT c.id, c.number, c.last_name, c.first_name, c.middle_name, c.status, c.email, c.phone, c.telegram,
            c.archived_at, c.deleted_at, v.name AS vacancy_name
     FROM candidates c
     JOIN vacancies v ON v.id = c.vacancy_id
     ORDER BY c.number DESC
     LIMIT 5000`
  );

  const matches = [];
  for (const row of rows) {
    if (excludeId && String(row.id) === excludeId) continue;
    const candidate = { lastName: row.last_name, firstName: row.first_name, middleName: row.middle_name, email: row.email, phone: row.phone, telegram: row.telegram };
    const match = matchCandidate(input, candidate);
    if (!match) continue;
    matches.push({
      id: row.id,
      number: Number(row.number),
      fullName: [row.last_name, row.first_name, row.middle_name].filter(Boolean).join(' '),
      vacancy: row.vacancy_name,
      status: row.status,
      state: row.deleted_at ? 'deleted' : row.archived_at ? 'archived' : 'active',
      matchedBy: match.matchedBy,
      nameScore: match.nameScore,
      score: match.score
    });
  }

  const stateRank = { active: 0, archived: 1, deleted: 2 };
  matches.sort((a, b) => b.score - a.score || stateRank[a.state] - stateRank[b.state] || b.number - a.number);
  return matches.slice(0, LIMIT);
}