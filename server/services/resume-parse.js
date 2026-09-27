// Автозаполнение карточки кандидата из файла резюме.
// Принцип: лучше оставить поле пустым, чем заполнить неверно. Поэтому значения делятся на
// `fields` (уверенные — подставляются в пустые поля) и `suggestions` (показываются кнопкой «Подставить»).
// Все значения проходят те же проверки, что и форма (normalizeKzPhone, validateEmail, …),
// чтобы автозаполнение не подставило то, что сервер потом отвергнет.
import { createHash } from 'node:crypto';
import { db } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import { extractResumeText } from '../lib/resume-text.js';
import { isFirstName, looksLikePatronymic, looksLikeSurname, skeleton, titleCase } from '../lib/person-names.js';
import { normalizeKzPhone, normalizeProfileUrl, normalizeTelegram, validateEmail } from '../lib/validation.js';
import { decodeResumeUpload } from './files.js';
import { findSimilarCandidates } from './similar.js';

export const FORMAT_LABELS = {
  hh: 'hh.ru / hh.kz',
  enbek: 'enbek.kz (предположительно)',
  linkedin: 'LinkedIn',
  generic: 'свободная форма'
};

const MIN_TEXT_CHARS = 80;
const DATE_RU = /^\d{1,2} [а-яё]+ \d{4}$/i;

const tryValue = fn => {
  try {
    return fn();
  } catch {
    return null;
  }
};

const norm = value =>
  String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function field(value, confidence, source) {
  return { value, confidence, source: String(source || '').slice(0, 120) };
}

// ---------- Определение формата ----------

export function detectFormat(document) {
  const text = document.text;
  const links = document.links.join('\n');

  if (/hh\.(?:kz|ru)\/vacancy/i.test(links + '\n' + text) && !/Резюме обновлено/.test(text)) {
    return 'hh_vacancy';
  }
  if (/Резюме обновлено \d{1,2} [а-яё]+ \d{4}/i.test(text) && /Желаемая должность/i.test(text)) {
    return 'hh';
  }
  const enbekMarkers = ['ТРУДОВАЯ ДЕЯТЕЛЬНОСТЬ', 'ПРОФЕССИОНАЛЬНЫЕ СВЕДЕНИЯ', 'УСЛОВИЯ РАБОТЫ', 'ДОПОЛНИТЕЛЬНАЯ ИНФОРМАЦИЯ О СОИСКАТЕЛЕ', 'Пол, возраст'];
  if (enbekMarkers.filter(marker => text.includes(marker)).length >= 2) {
    return 'enbek';
  }
  if (/Page \d+ of \d+/.test(text) && /Top Skills|Experience/.test(text) && /linkedin\.com\/in\//i.test(links + text)) {
    return 'linkedin';
  }
  return 'generic';
}

// ---------- Контакты (общие для всех форматов) ----------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const KNOWN_TLDS = new Set(
  'com ru kz net org io me dev info biz edu gov by ua uz kg tj tr de uk co us pro online site tech app xyz mail email cloud ai eu fr it es pl ca in cn jp kr ge am az md lv lt ee su рф'.split(' ')
);

function extractEmails(document) {
  const found = [];
  const push = (raw, source) => {
    const email = String(raw).replace(/[.,;:)]+$/, '').toLowerCase();
    if (!found.some(item => item.email === email)) found.push({ email, source });
  };
  for (const link of document.links) {
    const match = /^mailto:([^?]+)/i.exec(link);
    if (match) push(decodeURIComponent(match[1]), 'ссылка mailto');
  }
  for (const line of document.lines) {
    for (const match of line.text.matchAll(EMAIL_RE)) push(match[0], line.text);
  }
  return found;
}

// Все цифровые последовательности, похожие на телефон: +7/8 и 10 цифр или 10 цифр с 7.
const PHONE_RE = /(?<![\d\w+])(?:\+?7|8)[\s\-().]*\d(?:[\s\-().]*\d){9}(?![\d])|(?<![\d\w+])7\d{2}[\s\-.]?\d{3}[\s\-.]?\d{2}[\s\-.]?\d{2}(?![\d])/g;

function extractPhones(document) {
  const found = [];
  const push = (raw, source, strong) => {
    const digits = String(raw).replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 11) return;
    const kz = tryValue(() => normalizeKzPhone(digits));
    const key = kz || digits;
    if (!found.some(item => item.key === key)) found.push({ key, kz, digits, source, strong: !!strong });
  };
  for (const link of document.links) {
    const match = /^tel:(.+)$/i.exec(link);
    if (match) push(decodeURIComponent(match[1]), 'ссылка tel:', true);
  }
  document.lines.forEach((line, index) => {
    for (const match of line.text.matchAll(PHONE_RE)) push(match[0], line.text, index < 15);
  });
  return found;
}

const TG_LABELLED_RE = /(?:^|[\s|•·,;(\t])(?:telegram|телеграм|tg|тг)\s*[:\-–—]?\s*(?:https?:\/\/)?(?:t\.me\/)?@?([A-Za-z][A-Za-z0-9_]{4,31})\b/gi;
const TG_LINK_RE = /t(?:elegram)?\.me\/(?!joinchat|\+)([A-Za-z][A-Za-z0-9_]{4,31})\b/gi;
const TG_SUFFIX_RE = /@([A-Za-z][A-Za-z0-9_]{4,31})\s*\((?:telegram|tg|тг|телеграм)\)/gi;
const TG_BARE_RE = /(?<![\w.\/])@([A-Za-z][A-Za-z0-9_]{4,31})\b(?!\.[a-z])/g;

function extractTelegram(document) {
  const strong = [];
  const weak = [];
  const push = (list, username, source) => {
    const normalized = tryValue(() => normalizeTelegram(username));
    if (!normalized) return;
    if (!list.some(item => item.value === normalized.display)) list.push({ value: normalized.display, source });
  };
  const haystack = [...document.lines.map(line => line.text), ...document.links];
  for (const text of haystack) {
    for (const match of text.matchAll(TG_LABELLED_RE)) push(strong, match[1], text);
    for (const match of text.matchAll(TG_LINK_RE)) push(strong, match[1], text);
    for (const match of text.matchAll(TG_SUFFIX_RE)) push(strong, match[1], text);
  }
  const labelTail = /(?:^|[^a-zа-яё])(?:telegram|телеграм|tg|тг)\s*[:\-–—]?\s*$/i;
  document.lines.forEach((line, index) => {
    for (const match of line.text.matchAll(TG_BARE_RE)) {
      const before = line.text.slice(0, match.index);
      const previous = index > 0 ? document.lines[index - 1].text : '';
      if (labelTail.test(before) || (!before.trim() && labelTail.test(previous))) push(strong, match[1], previous + ' ' + line.text);
      else if (!strong.length) push(weak, match[1], line.text);
    }
  });
  return { strong, weak: strong.length ? [] : weak };
}
const GITHUB_RESERVED = new Set(
  'features topics orgs about login join settings marketplace explore pricing sponsors apps site security enterprise team customer-stories readme collections events trending new notifications pulls issues'.split(' ')
);
const GITHUB_RE = /github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?=[\/?#\s)|,;]|$)/gi;
const GITHUB_LABEL_RE = /github\s*[:\-–—]\s*@?(?!https?:|www\.)([A-Za-z0-9][A-Za-z0-9-]{1,38})\b/i;
const LINKEDIN_RE = /linkedin\.com\/in\/([^\s\/?#)|,;]+)/gi;
const LINKEDIN_LABEL_RE = /linkedin\s*[:\-–—]\s*(?!https?:|www\.|linkedin)([A-Za-z0-9][A-Za-z0-9-]{2,99})\b/i;

function extractProfiles(document) {
  const result = { github: [], githubWeak: [], linkedin: [], linkedinWeak: [] };
  const texts = [...document.links, ...document.lines.map(line => line.text)];
  for (const text of texts) {
    for (const match of text.matchAll(GITHUB_RE)) {
      const handle = match[1];
      if (GITHUB_RESERVED.has(handle.toLowerCase())) continue;
      const url = 'https://github.com/' + handle;
      if (!result.github.some(item => item.value.toLowerCase() === url.toLowerCase())) result.github.push({ value: url, source: text });
    }
    for (const match of text.matchAll(LINKEDIN_RE)) {
      let handle = match[1].replace(/[.,;:)]+$/, '');
      handle = tryValue(() => decodeURIComponent(handle)) || handle;
      const url = 'https://www.linkedin.com/in/' + handle;
      if (!result.linkedin.some(item => item.value.toLowerCase() === url.toLowerCase())) result.linkedin.push({ value: url, source: text });
    }
  }
  if (!result.github.length) {
    for (const line of document.lines) {
      const match = GITHUB_LABEL_RE.exec(line.text);
      if (match) {
        result.githubWeak.push({ value: 'https://github.com/' + match[1], source: line.text });
        break;
      }
    }
  }
  if (!result.linkedin.length) {
    for (const line of document.lines) {
      const match = LINKEDIN_LABEL_RE.exec(line.text);
      if (match) {
        result.linkedinWeak.push({ value: 'https://www.linkedin.com/in/' + match[1], source: line.text });
        break;
      }
    }
  }
  return result;
}

// Ссылки в «Иные ссылки» — только профили с известных площадок. Сертификаты, Google Drive,
// сайты работодателей и карты в карточке не нужны.
const LINK_HOSTS = [
  [/^(?:www\.)?(?:[a-z]+\.)?hh\.(?:kz|ru)\/resume\//i, 'hh.ru'],
  [/^(?:www\.)?gitlab\.com\/[A-Za-z0-9_.-]+\/?$/i, 'GitLab'],
  [/^(?:www\.)?stackoverflow\.com\/users\//i, 'Stack Overflow'],
  [/^(?:www\.)?hackerrank\.com\//i, 'HackerRank'],
  [/^(?:www\.)?leetcode\.com\//i, 'LeetCode'],
  [/^(?:www\.)?codewars\.com\/users\//i, 'Codewars'],
  [/^(?:www\.)?codeforces\.com\/profile\//i, 'Codeforces'],
  [/^(?:www\.)?kaggle\.com\//i, 'Kaggle'],
  [/^(?:www\.)?behance\.net\//i, 'Behance'],
  [/^(?:www\.)?dribbble\.com\//i, 'Dribbble'],
  [/^(?:career\.)?habr\.com\//i, 'Habr'],
  [/^(?:www\.)?medium\.com\/@/i, 'Medium'],
  [/^(?:www\.)?dev\.to\//i, 'dev.to'],
  [/^(?:www\.)?enbek\.kz\//i, 'enbek.kz']
];

function extractOtherLinks(document) {
  const links = [];
  const candidates = [...document.links];
  for (const line of document.lines) {
    for (const match of line.text.matchAll(/https?:\/\/[^\s)»"']+/g)) candidates.push(match[0]);
  }
  for (const raw of candidates) {
    const url = raw.replace(/[.,;:)]+$/, '');
    const withoutScheme = url.replace(/^https?:\/\//i, '');
    for (const [pattern, name] of LINK_HOSTS) {
      if (!pattern.test(withoutScheme)) continue;
      if (!links.some(link => link.url.toLowerCase() === url.toLowerCase())) links.push({ name, url });
      break;
    }
    if (links.length >= 6) break;
  }
  return links;
}

// ---------- ФИО ----------

const NAME_STOPWORDS = new Set(
  `resume cv curriculum vitae резюме developer engineer разработчик программист инженер аналитик analyst senior middle junior lead
   team manager менеджер architect архитектор контакты contact contacts information summary profile профиль skills навыки education
   образование experience опыт backend frontend fullstack full stack software web data scientist designer дизайнер qa tester
   тестировщик devops intern стажер стажёр специалист руководитель директор head chief officer cto ceo python java net kotlin php
   javascript typescript react vue angular node астана almaty алматы astana казахстан kazakhstan россия москва шымкент караганда
   актобе атырау page страница желаемая должность вакансия компания projects проекты about обо мне цель objective`
    .split(/\s+/)
    .filter(Boolean)
);

const NAME_TOKEN_RE = /^[A-Za-zА-ЯЁа-яёӘәҒғҚқҢңӨөҰұҮүҺһІі][A-Za-zА-ЯЁа-яёӘәҒғҚқҢңӨөҰұҮүҺһІі'’-]{1,}$/;

function nameTokens(text) {
  const tokens = String(text).trim().split(/\s+/);
  if (tokens.length < 2 || tokens.length > 4) return null;
  for (const token of tokens) {
    if (!NAME_TOKEN_RE.test(token)) return null;
    if (NAME_STOPWORDS.has(token.toLowerCase())) return null;
    if (token[0] !== token[0].toUpperCase()) return null;
  }
  return tokens.map(titleCase);
}

function filenameSkeletons(filename) {
  return new Set(
    String(filename || '')
      .replace(/\.[^.]+$/, '')
      .split(/[^A-Za-zА-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]+/)
      .filter(part => part.length >= 3)
      .map(skeleton)
  );
}

// Раскладывает слова на Ф/И/О. `orderKnown` — порядок «Фамилия Имя Отчество» задан шаблоном.
function splitPersonName(tokens, { orderKnown = false, shortName = null } = {}) {
  const result = { lastName: '', firstName: '', middleName: '', confidence: 'high', alternatives: [] };

  if (orderKnown) {
    if (shortName && shortName.length === 2 && tokens.length > 2) {
      // hh печатает в подвале «Фамилия Имя»: разница с заголовком — отчество.
      const rest = tokens.filter(token => !shortName.some(short => skeleton(short) === skeleton(token)));
      if (rest.length === tokens.length - 2) {
        return { ...result, lastName: shortName[0], firstName: shortName[1], middleName: rest.join(' ') };
      }
    }
    result.lastName = tokens[0];
    result.firstName = tokens[1];
    result.middleName = tokens.slice(2).join(' ');
    return result;
  }

  if (tokens.length >= 3) {
    const [a, b, c] = tokens;
    const last = tokens[tokens.length - 1];
    if (looksLikePatronymic(c) && !isFirstName(c)) return { ...result, lastName: a, firstName: b, middleName: tokens.slice(2).join(' ') };
    if (looksLikePatronymic(b) && !isFirstName(b)) return { ...result, lastName: c, firstName: a, middleName: b };
    if (isFirstName(b) && !isFirstName(a)) return { ...result, lastName: a, firstName: b, middleName: tokens.slice(2).join(' ') };
    if (isFirstName(a) && !isFirstName(b)) return { ...result, lastName: last, firstName: a, middleName: tokens.slice(1, -1).join(' ') };
    return {
      ...result,
      confidence: 'low',
      lastName: a,
      firstName: b,
      middleName: tokens.slice(2).join(' '),
      alternatives: [{ lastName: last, firstName: a, middleName: tokens.slice(1, -1).join(' ') }]
    };
  }

  const [a, b] = tokens;
  const fa = isFirstName(a);
  const fb = isFirstName(b);
  const sa = looksLikeSurname(a);
  const sb = looksLikeSurname(b);

  if (fb && !fa) return { ...result, lastName: a, firstName: b, confidence: sa || !sb ? 'high' : 'medium' };
  if (fa && !fb) return { ...result, lastName: b, firstName: a, confidence: sb || !sa ? 'high' : 'medium' };
  if (!fa && !fb) {
    if (sa && !sb) return { ...result, lastName: a, firstName: b, confidence: 'medium' };
    if (sb && !sa) return { ...result, lastName: b, firstName: a, confidence: 'medium' };
  }
  // Оба слова — имена (Рахат Бектас) или оба неизвестны: порядок не определить.
  return {
    ...result,
    confidence: 'low',
    lastName: a,
    firstName: b,
    alternatives: [{ lastName: b, firstName: a, middleName: '' }]
  };
}
// ---------- hh.ru ----------

const HH_APPLY_RE = /^(Отклик на вакансию|Отказано без приглашения на вакансию|Приглашение на вакансию|Приглашён на вакансию|Приглашен на вакансию): «(.+)»$/;
const HH_SECTIONS = new Set([
  'Желаемая должность и зарплата', 'Опыт работы', 'Образование', 'Навыки', 'Дополнительная информация', 'Комментарии к резюме',
  'История общения с кандидатом', 'Сопроводительное письмо', 'Повышение квалификации, курсы', 'Электронные сертификаты',
  'Опыт вождения', 'Тесты, экзамены', 'Портфолио', 'Гражданство, время в пути до работы', 'Рекомендации'
]);
const HH_SALARY_RE = /^(\d[\d\s]*\d|\d)\s*(₸|тг\.?|тенге|KZT|руб\.?|₽|RUB|\$|USD|€|EUR|сом|сум)(?:\s+(?:на руки|до вычета налогов))?/i;

function isHhSection(line) {
  const text = line.text.replace(/\s+—.*$/, '').trim();
  return line.size >= 11 && (HH_SECTIONS.has(text) || /^Опыт работы —/.test(line.text));
}

function parseHh(document) {
  const lines = document.lines;
  const out = { name: null, position: '', salary: null, summary: [], hh: { events: [], comments: [], coverLetter: '' } };

  let index = 0;
  while (index < lines.length && lines[index].size < 18) {
    const match = HH_APPLY_RE.exec(lines[index].text);
    if (match) {
      const date = lines[index + 1] && DATE_RU.test(lines[index + 1].text) ? lines[index + 1].text : '';
      out.hh.events.push({ kind: match[1], vacancy: match[2], date });
      index += date ? 2 : 1;
      continue;
    }
    index++;
  }

  // ФИО — самые крупные строки в начале документа (могут занимать две строки).
  const nameLines = [];
  while (index < lines.length && lines[index].size >= 18) nameLines.push(lines[index++].text);
  const footer = lines.map(line => /^(.+?) • Резюме обновлено/.exec(line.text)).find(Boolean);
  const shortName = footer ? footer[1].trim().split(/\s+/) : null;
  const tokens = nameTokens(nameLines.join(' '));
  if (tokens) out.name = { ...splitPersonName(tokens, { orderKnown: true, shortName }), source: nameLines.join(' ') };

  const sectionIndex = title => lines.findIndex(line => isHhSection(line) && line.text.startsWith(title));
  const positionIdx = sectionIndex('Желаемая должность и зарплата');
  if (positionIdx >= 0) {
    const parts = [];
    for (let i = positionIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (isHhSection(line) || /^(Специализации:|Тип занятости:|Формат работы:|Занятость:|График работы:)/.test(line.text)) break;
      const salary = HH_SALARY_RE.exec(line.text);
      if (salary) {
        out.salary = { amount: Number(salary[1].replace(/\s/g, '')), currency: salary[2], source: line.text };
        continue;
      }
      if (line.size >= 12) parts.push(line.text);
    }
    out.position = parts.join(' ').replace(/\s*,\s*/g, ', ');
  }

  const coverIdx = sectionIndex('Сопроводительное письмо');
  if (coverIdx >= 0) {
    const parts = [];
    for (let i = coverIdx + 1; i < lines.length && !isHhSection(lines[i]); i++) parts.push(lines[i].text);
    out.hh.coverLetter = parts.join('\n');
  }

  for (const line of lines) {
    let match;
    if ((match = /^(Мужчина|Женщина)(?:, (\d+ (?:лет|год|года)))?(?:, родил(?:ся|ась) (.+))?$/.exec(line.text))) {
      const born = match[3] ? (match[1] === 'Женщина' ? 'родилась ' : 'родился ') + match[3] : '';
      out.summary.push([match[1], match[2], born].filter(Boolean).join(', '));
    } else if ((match = /^Проживает: (.+)$/.exec(line.text))) out.summary.push('Город: ' + match[1]);
    else if (/^Гражданство: /.test(line.text)) out.summary.push(line.text);
    else if (/^(Не )?готов[а]? к переезду/i.test(line.text)) out.summary.push(line.text);
    else if ((match = /^Опыт работы — (.+)$/.exec(line.text))) out.summary.push('Опыт работы: ' + match[1]);
    else if (/^Формат работы: /.test(line.text) && !out.summary.some(item => item.startsWith('Формат работы'))) out.summary.push(line.text);
    else if ((match = /Резюме обновлено (\d{1,2} [а-яё]+ \d{4})/i.exec(line.text)) && !out.summary.some(item => item.startsWith('Резюме обновлено'))) {
      out.summary.push('Резюме обновлено: ' + match[1]);
    }
  }
  if (out.position) out.summary.unshift('Желаемая должность: ' + out.position);

  const commentsIdx = sectionIndex('Комментарии к резюме');
  if (commentsIdx >= 0) {
    for (let i = commentsIdx + 1; i < lines.length && !isHhSection(lines[i]); i++) {
      const match = /^(\d{1,2} [а-яё]+ \d{4})\t(.+)$/i.exec(lines[i].text);
      if (match) {
        const author = lines[i + 1] && lines[i + 1].size <= 8 && !/\t/.test(lines[i + 1].text) ? lines[i + 1].text : '';
        out.hh.comments.push({ date: match[1], text: match[2], author });
        if (author) i++;
      }
    }
  }

  const historyIdx = sectionIndex('История общения с кандидатом');
  if (historyIdx >= 0) {
    let pending = null;
    for (let i = historyIdx + 1; i < lines.length && !isHhSection(lines[i]); i++) {
      const text = lines[i].text;
      const dateOnly = text.replace(/^.*\t/, '');
      if (DATE_RU.test(dateOnly)) {
        if (pending) {
          pending.date = dateOnly;
          out.hh.events.push(pending);
          pending = null;
        }
        continue;
      }
      if (/\t/.test(text)) {
        const [kind, vacancy] = text.split('\t');
        if (pending) out.hh.events.push(pending);
        pending = { kind, vacancy, date: '' };
      }
    }
    if (pending) out.hh.events.push(pending);
  }

  // Отклик из шапки повторяется в «Истории общения» — оставляем первое упоминание.
  const seen = new Set();
  out.hh.events = out.hh.events.filter(event => {
    const key = (/отказ/i.test(event.kind) ? 'reject' : /отклик/i.test(event.kind) ? 'apply' : 'invite') + '|' + norm(event.vacancy);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return out;
}

// ---------- enbek.kz ----------

function parseEnbek(document) {
  const lines = document.lines;
  const out = { name: null, position: '', salary: null, summary: [] };
  const first = lines[0];
  const tokens = first ? nameTokens(first.text) : null;
  if (tokens) out.name = { ...splitPersonName(tokens, { orderKnown: true }), source: first.text };
  const parts = [];
  for (let i = 1; i < Math.min(lines.length, 5); i++) {
    if (/КОНТАКТЫ|ТРУДОВАЯ/.test(lines[i].text)) break;
    parts.push(lines[i].text.replace(/\t.*$/, ''));
  }
  out.position = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (out.position) out.summary.push('Желаемая должность: ' + out.position);
  for (const line of lines) {
    let match;
    if ((match = /Гражданство\t(.+)$/.exec(line.text))) out.summary.push('Гражданство: ' + match[1]);
    else if ((match = /Опыт работы\t(.+)$/.exec(line.text))) out.summary.push('Опыт работы: ' + match[1]);
    else if ((match = /^Готов к переезду\t(.+)$/.exec(line.text))) out.summary.push('Готов к переезду: ' + match[1]);
  }
  return out;
}

// Email вида ivan.petrov@… или i.petrov@… подсказывает, какое слово — фамилия, когда словарь не помог.
function refineNameByEmail(split, tokens, document) {
  const emails = extractEmails(document);
  if (!emails.length) return split;
  const parts = emails[0].email.split('@')[0].toLowerCase().replace(/\d+/g, '').split(/[._-]+/).filter(Boolean);
  const keys = tokens.map(skeleton);
  const full = parts.map(part => keys.indexOf(skeleton(part)));
  if (parts.length === 2 && full[0] >= 0 && full[1] >= 0 && full[0] !== full[1]) {
    return { ...split, firstName: tokens[full[0]], lastName: tokens[full[1]], middleName: '', confidence: 'medium', alternatives: [] };
  }
  if (parts.length === 2) {
    const [initial, word] = parts[0].length === 1 ? [parts[0], parts[1]] : parts[1].length === 1 ? [parts[1], parts[0]] : [null, null];
    if (initial) {
      const surnameIndex = keys.indexOf(skeleton(word));
      const other = surnameIndex >= 0 ? tokens[1 - surnameIndex] : null;
      if (other && skeleton(other).startsWith(skeleton(initial))) {
        return { ...split, lastName: tokens[surnameIndex], firstName: other, middleName: '', confidence: 'medium', alternatives: [] };
      }
    }
  }
  return split;
}

// ---------- Свободная форма ----------

const ROLE_RE = /developer|разработчик|engineer|инженер|analyst|аналитик|manager|менеджер|designer|дизайнер|\bqa\b|tester|тестировщик|devops|architect|архитектор|\blead\b|специалист|programmer|программист|\bcto\b|scientist|intern|стаж[её]р|administrator|администратор|consultant|консультант|product owner|scrum/i;
const SALARY_RE = /(?:зарплат\w*|з\/п|зп|salary|ожидан\w*|expected|compensation|доход\w*)[^\n\d]{0,40}?(\d[\d\s]{2,}(?:[.,]\d)?)\s*(тыс\.?|к|k|млн)?\s*(₸|тг\.?|тенге|kzt|руб\.?|₽|rub|\$|usd|€|eur)?/i;

function parseGeneric(document, filename) {
  const lines = document.lines;
  const out = { name: null, position: '', salary: null, summary: [] };
  const top = lines.slice(0, 15);
  const sizes = lines.map(line => line.size).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)] || 10;
  const maxSize = Math.max(...top.map(line => line.size), 0);
  const fileKeys = filenameSkeletons(filename);

  const candidates = [];
  top.forEach((line, index) => {
    line.text.split('\t').forEach(cell => {
      const cleaned = cell.replace(/^(?:ФИО|Имя|Name|Full name)\s*[:\-–—]\s*/i, '').trim();
      const tokens = nameTokens(cleaned);
      if (!tokens) return;
      let score = 0;
      if (line.size >= maxSize && maxSize > median) score += 4;
      else if (line.size > median) score += 2;
      score += Math.max(0, 3 - index * 0.5);
      score += tokens.filter(token => isFirstName(token)).length * 2;
      score += tokens.filter(token => looksLikeSurname(token) || looksLikePatronymic(token)).length;
      score += tokens.filter(token => fileKeys.has(skeleton(token))).length * 2;
      if (ROLE_RE.test(cleaned)) score -= 5;
      candidates.push({ tokens, score, source: line.text, index });
    });
  });
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  const best = candidates[0];
  if (best && best.score >= 3) {
    let split = splitPersonName(best.tokens);
    const fileMatches = best.tokens.filter(token => fileKeys.has(skeleton(token))).length;
    if (split.confidence === 'medium' && fileMatches >= 2) split.confidence = 'high';
    if (split.confidence !== 'high' && best.tokens.length === 2) split = refineNameByEmail(split, best.tokens, document);
    out.name = { ...split, source: best.source };
  }

  // Должность — короткая строка-заголовок с названием роли в шапке; не предложение и не пункт списка.
  const nameText = best ? best.tokens.join(' ') : '';
  outer: for (const line of top.slice(0, 8)) {
    for (const cell of line.text.split('\t')) {
      const text = cell.replace(/^(?:Желаемая должность|Должность|Position|Позиция)\s*[:\-–—]\s*/i, '').trim();
      if (!text || text.length > 80 || (nameText && skeleton(text) === skeleton(nameText))) continue;
      if (/^[•·\-–—*]/.test(text) || /[.;:]$/.test(text) || /\d{4}/.test(text) || /\b(и|and|with|для|опыт|experience)\b/i.test(text)) continue;
      if (text[0] !== text[0].toUpperCase() || !ROLE_RE.test(text)) continue;
      out.position = text;
      break outer;
    }
  }
  if (out.position) out.summary.push('Желаемая должность: ' + out.position);

  for (const line of lines) {
    const match = SALARY_RE.exec(line.text);
    if (!match) continue;
    let amount = Number(match[1].replace(/\s/g, '').replace(',', '.'));
    const unit = (match[2] || '').toLowerCase().replace('.', '');
    if (unit === 'тыс' || unit === 'к' || unit === 'k') amount *= 1000;
    if (unit === 'млн') amount *= 1000000;
    if (Number.isFinite(amount) && amount >= 30000 && amount <= 10000000) {
      out.salary = { amount: Math.round(amount), currency: match[3] || '', source: line.text };
      break;
    }
  }

  for (const line of top) {
    const match = /^(?:Город|Проживает|Location|Адрес)\s*[:\-–—]\s*(.+)$/i.exec(line.text.replace(/\t.*$/, ''));
    if (match) {
      out.summary.push('Город: ' + match[1]);
      break;
    }
  }
  return out;
}
// ---------- Сборка результата ----------

const KZT_RE = /^(₸|тг\.?|тенге|kzt)$/i;

function buildResult(document, format, parsed, filename) {
  const fields = {};
  const suggestions = [];
  const warnings = [];
  const addSuggestion = (name, value, label, note) => suggestions.push({ field: name, value, label, note: note || '' });
  const nameLabel = name => [name.lastName, name.firstName, name.middleName].filter(Boolean).join(' ');

  // ФИО
  if (parsed.name) {
    const name = parsed.name;
    if (name.confidence === 'low') {
      const primary = { lastName: name.lastName, firstName: name.firstName, middleName: name.middleName };
      addSuggestion('name', primary, nameLabel(primary), 'Порядок «Фамилия Имя» не определён — проверьте');
      for (const alternative of name.alternatives) addSuggestion('name', alternative, nameLabel(alternative), 'Вариант: фамилия и имя наоборот');
    } else {
      fields.lastName = field(name.lastName, name.confidence, name.source);
      fields.firstName = field(name.firstName, name.confidence, name.source);
      if (name.middleName) fields.middleName = field(name.middleName, name.confidence, name.source);
    }
  } else {
    warnings.push('ФИО в резюме не распознано — заполните вручную.');
  }

  // Email
  const emails = extractEmails(document);
  if (emails.length) {
    const [primary, ...rest] = emails;
    const valid = tryValue(() => validateEmail(primary.email));
    const tld = primary.email.split('.').pop();
    if (valid && KNOWN_TLDS.has(tld)) fields.email = field(valid, 'high', primary.source);
    else if (valid) addSuggestion('email', valid, valid, 'Необычный домен «.' + tld + '» — возможно, опечатка');
    for (const item of rest.slice(0, 2)) addSuggestion('email', item.email, item.email, 'Ещё один адрес из резюме');
  }

  // Телефон
  const phones = extractPhones(document);
  const kzPhone = phones.find(item => item.kz);
  if (kzPhone) {
    fields.phone = field(kzPhone.kz, kzPhone.strong ? 'high' : 'medium', kzPhone.source);
    for (const item of phones.filter(item => item.kz && item !== kzPhone).slice(0, 2)) addSuggestion('phone', item.kz, item.kz, 'Ещё один номер из резюме');
  } else if (phones.length) {
    const item = phones[0];
    const digits = item.digits.length === 10 ? '7' + item.digits : item.digits.replace(/^8/, '7');
    const pretty = '+' + digits.slice(0, 1) + ' ' + digits.slice(1, 4) + ' ' + digits.slice(4, 7) + ' ' + digits.slice(7, 9) + ' ' + digits.slice(9);
    addSuggestion('phone', pretty, pretty, 'Не мобильный номер РК — форма принимает только +7 7XX');
    warnings.push('Найден телефон ' + pretty + ', но это не мобильный номер РК.');
  }

  // Telegram
  const telegram = extractTelegram(document);
  if (telegram.strong.length) {
    fields.telegram = field(telegram.strong[0].value, 'high', telegram.strong[0].source);
    for (const item of telegram.strong.slice(1, 3)) addSuggestion('telegram', item.value, item.value, 'Ещё один ник из резюме');
  } else {
    for (const item of telegram.weak.slice(0, 2)) addSuggestion('telegram', item.value, item.value, 'Похоже на ник Telegram, но подпись не найдена');
  }

  // GitHub, LinkedIn
  const profiles = extractProfiles(document);
  if (profiles.github.length) {
    const value = tryValue(() => normalizeProfileUrl(profiles.github[0].value, 'github'));
    if (value) fields.github = field(value, 'high', profiles.github[0].source);
    for (const item of profiles.github.slice(1, 3)) addSuggestion('github', item.value, item.value, 'Ещё один профиль GitHub');
  } else {
    for (const item of profiles.githubWeak) addSuggestion('github', item.value, item.value, 'Ник из текста, ссылки нет');
  }
  if (profiles.linkedin.length) {
    const value = tryValue(() => normalizeProfileUrl(profiles.linkedin[0].value, 'linkedin'));
    if (value) fields.linkedin = field(value, 'high', profiles.linkedin[0].source);
  } else {
    for (const item of profiles.linkedinWeak) addSuggestion('linkedin', item.value, item.value, 'Ник из текста, ссылки нет');
  }

  // Зарплата: только тенге подставляется, другая валюта — подсказкой.
  if (parsed.salary && parsed.salary.amount) {
    const { amount, currency, source } = parsed.salary;
    if (!currency || KZT_RE.test(currency)) {
      if (amount >= 30000 && amount <= 10000000) fields.salary = field(String(amount), 'medium', source);
    } else {
      addSuggestion('salary', String(amount), amount.toLocaleString('ru-RU') + ' ' + currency, 'Зарплата в другой валюте — переведите в тенге');
    }
  }

  return {
    status: 'ok',
    format,
    formatLabel: FORMAT_LABELS[format] || FORMAT_LABELS.generic,
    fileName: filename,
    fields,
    suggestions,
    warnings,
    links: extractOtherLinks(document),
    position: parsed.position || '',
    summary: parsed.summary || [],
    hh: parsed.hh || null,
    duplicates: [],
    hints: {}
  };
}

// Чистая функция для тестов: документ из extractResumeText → результат разбора без обращения к БД.
export function parseResumeDocument(document, filename = '') {
  if (!document.textChars || document.textChars < MIN_TEXT_CHARS) {
    return {
      status: 'scan',
      message: document.textChars
        ? 'В файле почти нет текста — похоже, это скан. Заполните карточку вручную.'
        : 'В файле нет текстового слоя — похоже, это скан. Заполните карточку вручную.'
    };
  }
  const format = detectFormat(document);
  if (format === 'hh_vacancy') {
    return { status: 'not_resume', message: 'Это распечатка вакансии с hh, а не резюме кандидата.' };
  }
  const parsed = format === 'hh' ? parseHh(document) : format === 'enbek' ? parseEnbek(document) : parseGeneric(document, filename);
  return buildResult(document, format, parsed, filename);
}

// ---------- Подсказки по справочникам и дубли ----------

const TOKEN_ALIASES = {
  'c#': 'csharp', 'с#': 'csharp', '.net': 'net', dotnet: 'net', 'asp.net': 'net', js: 'javascript', ts: 'typescript',
  'front-end': 'frontend', 'back-end': 'backend', 'full-stack': 'fullstack', разработчик: 'developer', программист: 'developer',
  инженер: 'engineer', аналитик: 'analyst', тестировщик: 'qa', дизайнер: 'designer', менеджер: 'manager', архитектор: 'architect'
};
const TOKEN_NOISE = new Set(['middle', 'senior', 'junior', 'lead', 'strong', 'в', 'и', 'на', 'по', 'the', 'a', 'of', 'разработка', 'работа', 'астане', 'астана', 'алматы', 'удаленно', 'удалённо']);

function vacancyTokens(text) {
  return new Set(
    norm(text)
      .replace(/[\/,()|+·•-]/g, ' ')
      .split(/\s+/)
      .filter(token => token.length > 1 && !TOKEN_NOISE.has(token))
      .map(token => TOKEN_ALIASES[token] || token)
  );
}

export function computeHints(result, vacancies, sources) {
  const hints = {};
  const events = (result.hh && result.hh.events) || [];
  const appliedEvent = events.find(event => /Отклик/.test(event.kind) && event.vacancy) || events.find(event => event.vacancy);
  const appliedName = appliedEvent ? appliedEvent.vacancy : '';

  const sameName = (a, b) => norm(a).replace(/\s*-\s*/g, '-') === norm(b).replace(/\s*-\s*/g, '-');
  if (appliedName) {
    const exact = vacancies.find(vacancy => sameName(vacancy.name, appliedName));
    if (exact) hints.vacancy = { id: exact.id, name: exact.name, confidence: 'high', reason: 'Отклик в hh на вакансию «' + appliedName + '»' };
    else hints.vacancyText = appliedName;
  }
  for (const [text, reason] of [[appliedName, 'Отклик в hh на вакансию «' + appliedName + '»'], [result.position, 'Желаемая должность: «' + result.position + '»']]) {
    if (hints.vacancy || !text) continue;
    const positionTokens = vacancyTokens(text);
    let best = null;
    for (const vacancy of vacancies) {
      const tokens = vacancyTokens(vacancy.name);
      if (!tokens.size) continue;
      const common = [...tokens].filter(token => positionTokens.has(token)).length;
      const score = common / tokens.size;
      if (common && (!best || score > best.score)) best = { vacancy, score };
    }
    if (best && best.score >= 0.5) {
      hints.vacancy = { id: best.vacancy.id, name: best.vacancy.name, confidence: best.score === 1 ? 'high' : 'medium', reason };
    }
  }

  const sourcePattern = {
    hh: /(^|[^a-zа-я])(hh|headhunter|head hunter|хедхантер|хэдхантер)([^a-zа-я]|$)/i,
    enbek: /enbek|энбек|биржа труда/i,
    linkedin: /linkedin|линкедин/i
  }[result.format];
  if (sourcePattern) {
    const source = sources.find(item => sourcePattern.test(item.name));
    if (source) hints.source = { id: source.id, name: source.name, confidence: 'high', reason: 'Резюме в формате ' + result.formatLabel };
  }
  return hints;
}

// RPC: разбирает файл { name, mimeType, base64 } и ничего не сохраняет.
export async function parseResume(input) {
  const upload = decodeResumeUpload(input);
  const extension = upload.name.split('.').pop().toLowerCase();

  let document;
  try {
    document = await extractResumeText(upload.buffer, extension);
  } catch (error) {
    const reason = error && error.message ? String(error.message).replace(/\.+$/, '') : 'неизвестная ошибка';
    fail('Не удалось прочитать файл резюме: ' + reason + '.');
  }

  const result = parseResumeDocument(document, upload.name);
  result.fileHash = createHash('sha256').update(upload.buffer).digest('hex');
  if (result.status !== 'ok') return result;

  const [vacancies, sources] = await Promise.all([
    db.many(`SELECT id, name FROM vacancies WHERE status = 'Открыта' AND archived_at IS NULL ORDER BY number`),
    db.many('SELECT id, name FROM sources WHERE archived_at IS NULL ORDER BY number')
  ]);
  result.hints = computeHints(result, vacancies, sources);
  const value = name => (result.fields[name] ? result.fields[name].value : '');
  result.duplicates = await findSimilarCandidates({ lastName: value('lastName'), firstName: value('firstName'), middleName: value('middleName'), email: value('email'), phone: value('phone'), telegram: value('telegram') });
  return result;
}