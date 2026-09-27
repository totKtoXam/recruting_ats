import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isFirstName, looksLikeSurname, skeleton, titleCase } from '../server/lib/person-names.js';
import { cleanLine, extractResumeText } from '../server/lib/resume-text.js';
import { computeHints, detectFormat, parseResumeDocument } from '../server/services/resume-parse.js';

// Документ в формате extractResumeText из строк: строка — текст или { text, size, x }.
function doc(lines, links = []) {
  const rows = lines.map(line => (typeof line === 'string' ? { text: line, size: 10, x: 0 } : { size: 10, x: 0, ...line }));
  const text = rows.map(row => row.text).join('\n');
  return { kind: 'pdf', pages: [{ lines: rows, links }], lines: rows, links, text, textChars: text.replace(/\s/g, '').length, producer: '' };
}

const filler = Array.from({ length: 6 }, (_, i) => 'Строка с описанием опыта работы номер ' + (i + 1) + ' для объёма текста.');

test('person names: skeleton matches transliteration variants', () => {
  assert.equal(skeleton('Zhumabay'), skeleton('Жумабай'));
  assert.equal(skeleton('Rakhat'), skeleton('Рахат'));
  assert.equal(skeleton('Yerlan'), skeleton('Ерлан'));
  assert.ok(isFirstName('Амирбек') && isFirstName('Amirbek') && isFirstName('Luiza') && isFirstName('Нуркен'));
  assert.ok(!isFirstName('Зулпыхаров') && looksLikeSurname('Зулпыхаров') && looksLikeSurname('Akhmetov'));
  assert.equal(titleCase('НУРКЕН'), 'Нуркен');
  assert.equal(titleCase('ANN-MARIE'), 'Ann-Marie');
  assert.equal(titleCase('Олег'), 'Олег');
});

test('cleanLine strips private-use bullets and odd spaces', () => {
  assert.equal(cleanLine(String.fromCharCode(0xf0b7) + ' Разработал' + String.fromCharCode(0xa0) + 'сервис  '), 'Разработал сервис');
});

const hhLines = [
  { text: 'Отклик на вакансию: «Backend-разработчик»', size: 9 },
  { text: '5 мая 2026', size: 8 },
  { text: 'Иванова Мария', size: 25 },
  { text: 'Петровна', size: 25 },
  'Женщина, 30 лет, родилась 1 января 1996',
  '+7 (701) 123 45 67 — предпочитаемый способ связи',
  'maria.ivanova@example.com',
  'telegram: @maria_test',
  'Проживает: Астана',
  'Гражданство: Казахстан, есть разрешение на работу: Казахстан',
  { text: 'Сопроводительное письмо', size: 11 },
  'Здравствуйте! Хочу к вам.',
  { text: 'Желаемая должность и зарплата', size: 11 },
  { text: 'Backend-разработчик', size: 12 },
  { text: '500 000 ₸ на руки', size: 9 },
  'Специализации:',
  { text: 'Опыт работы — 3 года 2 месяца', size: 11 },
  ...filler,
  { text: 'Комментарии к резюме', size: 11 },
  { text: '1 мая 2026\tне вышел на связь', size: 9 },
  { text: 'Рекрутер Тестовый', size: 8, x: 128 },
  { text: 'История общения с кандидатом', size: 11 },
  { text: 'Отклики\tBackend-разработчик', size: 9 },
  { text: '5 мая 2026', size: 8 },
  { text: 'Получил отказ\tQA-инженер', size: 9 },
  { text: '2 мая 2026', size: 8 },
  { text: 'Резюме обновлено 3 мая 2026 в 10:00', size: 8 },
  { text: 'Иванова Мария • Резюме обновлено 3 мая 2026 в 10:00', size: 8 }
];

test('hh resume: fixed template gives every field, patronymic via footer, extras', () => {
  const document = doc(hhLines);
  assert.equal(detectFormat(document), 'hh');
  const result = parseResumeDocument(document, 'Иванова Мария.pdf');
  assert.equal(result.status, 'ok');
  assert.equal(result.fields.lastName.value, 'Иванова');
  assert.equal(result.fields.firstName.value, 'Мария');
  assert.equal(result.fields.middleName.value, 'Петровна');
  assert.equal(result.fields.phone.value, '+7 701 123 45 67');
  assert.equal(result.fields.email.value, 'maria.ivanova@example.com');
  assert.equal(result.fields.telegram.value, '@maria_test');
  assert.equal(result.fields.salary.value, '500000');
  assert.equal(result.position, 'Backend-разработчик');
  assert.deepEqual(result.hh.events.map(event => event.kind + '|' + event.vacancy + '|' + event.date), [
    'Отклик на вакансию|Backend-разработчик|5 мая 2026',
    'Получил отказ|QA-инженер|2 мая 2026'
  ]);
  assert.deepEqual(result.hh.comments, [{ date: '1 мая 2026', text: 'не вышел на связь', author: 'Рекрутер Тестовый' }]);
  assert.equal(result.hh.coverLetter, 'Здравствуйте! Хочу к вам.');
  assert.ok(result.summary.includes('Город: Астана'));
  assert.ok(result.summary.includes('Опыт работы: 3 года 2 месяца'));

  const hints = computeHints(result, [{ id: 'v1', name: 'Backend - разработчик' }, { id: 'v2', name: 'QA' }], [{ id: 's1', name: 'HeadHunter' }]);
  assert.equal(hints.vacancy.id, 'v1');
  assert.equal(hints.vacancy.confidence, 'high');
  assert.equal(hints.source.id, 's1');
});

test('generic resume: contacts from text and link annotations, name order by dictionary', () => {
  const document = doc(
    [
      { text: 'Пётр Сидоров', size: 20 },
      { text: 'Senior Java Developer', size: 12 },
      'Телефон: 8 (777) 123-45-67 | Email: petr.sidorov@example.com',
      'Telegram: @petr_sid · GitHub: github.com/petrsid',
      'Опыт работы',
      ...filler
    ],
    ['https://www.linkedin.com/in/petr-sidorov', 'https://github.com/features', 'https://hh.kz/resume/abc123', 'https://drive.google.com/file/d/1']
  );
  const result = parseResumeDocument(document, 'cv.pdf');
  assert.equal(result.format, 'generic');
  assert.equal(result.fields.lastName.value, 'Сидоров');
  assert.equal(result.fields.firstName.value, 'Пётр');
  assert.equal(result.fields.phone.value, '+7 777 123 45 67');
  assert.equal(result.fields.email.value, 'petr.sidorov@example.com');
  assert.equal(result.fields.telegram.value, '@petr_sid');
  assert.equal(result.fields.github.value, 'https://github.com/petrsid');
  assert.equal(result.fields.linkedin.value, 'https://www.linkedin.com/in/petr-sidorov');
  assert.equal(result.position, 'Senior Java Developer');
  assert.deepEqual(result.links, [{ name: 'hh.ru', url: 'https://hh.kz/resume/abc123' }]);

  const hints = computeHints(result, [{ id: 'v1', name: 'Java-разработчик' }], []);
  assert.equal(hints.vacancy.id, 'v1');
});

test('generic resume: ambiguous name order becomes a suggestion, email settles it when possible', () => {
  const ambiguous = parseResumeDocument(doc([{ text: 'Арман Азамат', size: 20 }, 'Инженер', ...filler]), 'cv.pdf');
  assert.equal(ambiguous.fields.lastName, undefined);
  const names = ambiguous.suggestions.filter(item => item.field === 'name');
  assert.equal(names.length, 2);
  assert.deepEqual(names.map(item => item.label).sort(), ['Азамат Арман', 'Арман Азамат']);

  const byEmail = parseResumeDocument(doc([{ text: 'Азамат Арман', size: 20 }, 'Email: arman.azamat@example.com', ...filler]), 'cv.pdf');
  assert.equal(byEmail.fields.firstName.value, 'Арман');
  assert.equal(byEmail.fields.lastName.value, 'Азамат');
  assert.equal(byEmail.fields.lastName.confidence, 'medium');
});

test('phone outside Kazakhstan is only a suggestion; typo in email domain too', () => {
  const result = parseResumeDocument(doc([{ text: 'Иван Петров', size: 20 }, '+7 951 899 44 68', 'ivan@example.comn', ...filler]), 'cv.pdf');
  assert.equal(result.fields.phone, undefined);
  assert.equal(result.fields.email, undefined);
  assert.ok(result.suggestions.some(item => item.field === 'phone' && item.value === '+7 951 899 44 68'));
  assert.ok(result.suggestions.some(item => item.field === 'email' && /опечатка/.test(item.note)));
  assert.ok(result.warnings.some(text => /не мобильный номер РК/.test(text)));
});

test('telegram label at the end of the previous line counts', () => {
  const result = parseResumeDocument(doc([{ text: 'Иван Петров', size: 20 }, 'Увлекаюсь наукой. Тг:', '@magnus_test, +7 777 596 41 88.', ...filler]), 'cv.pdf');
  assert.equal(result.fields.telegram.value, '@magnus_test');
  assert.equal(result.fields.phone.value, '+7 777 596 41 88');
});

test('scans and hh vacancy printouts are rejected with a message', () => {
  assert.equal(parseResumeDocument(doc(['Иван']), 'scan.pdf').status, 'scan');
  const vacancy = parseResumeDocument(doc(['Вакансия Middle C#/.NET-разработчик в Астане', ...filler], ['https://astana.hh.kz/vacancy/view?draftId=1']), 'v.pdf');
  assert.equal(vacancy.status, 'not_resume');
});

// Эталонный набор реальных резюме лежит вне репозитория (test/fixtures/resumes, в .gitignore).
const FIXTURES = path.resolve('test/fixtures/resumes');
const EXPECTED = path.join(FIXTURES, 'expected.json');

test('golden set of real resumes', { skip: !existsSync(EXPECTED) && 'нет test/fixtures/resumes/expected.json' }, async () => {
  const expected = JSON.parse(readFileSync(EXPECTED, 'utf8'));
  const failures = [];
  for (const [file, want] of Object.entries(expected)) {
    const buffer = readFileSync(path.join(FIXTURES, file));
    const document = await extractResumeText(buffer, file.split('.').pop());
    const result = parseResumeDocument(document, file);
    const got = { status: result.status, format: result.format, fields: {} };
    for (const [name, item] of Object.entries(result.fields || {})) got.fields[name] = item.value;
    try {
      assert.deepEqual(JSON.parse(JSON.stringify(got)), want);
    } catch (error) {
      failures.push(file + '\n' + error.message);
    }
  }
  assert.equal(failures.length, 0, failures.join('\n\n'));
});