import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeAttachmentUpload, keepPreviousAttachments, resolveAttachments } from '../server/services/attachments.js';
import { normalizeAnswers } from '../server/services/interviews.js';
import { normalizeTemplateQuestions, toInterview, toTemplate } from '../server/services/mappers.js';

const FILE_A = '11111111-1111-4111-8111-111111111111';
const FILE_B = '22222222-2222-4222-8222-222222222222';

test('normalizeTemplateQuestions keeps files only when an array is passed', () => {
  const [plain, attached, cleared] = normalizeTemplateQuestions([
    { text: 'Без файлов', answers: [] },
    { text: 'С файлом', files: [{ id: FILE_A, name: 'task.pdf' }, { id: FILE_A }, { id: 'not-a-uuid' }] },
    { text: 'Убрать файлы', files: [] }
  ]);

  assert.equal('files' in plain, false);
  assert.deepEqual(attached.files, [{ id: FILE_A, name: 'task.pdf', mimeType: 'application/octet-stream', size: null }]);
  assert.deepEqual(cleared.files, []);
});

test('normalizeAnswers: a file is an answer, skipped answers drop the flag when files are attached', () => {
  const answers = normalizeAnswers([
    { question: 'Тестовое', answer: '', files: [{ id: FILE_A }], skipped: true },
    { question: 'Без ответа', answer: '', skipped: true, files: [] },
    { question: '', answer: '', files: [{ id: FILE_B }] }
  ]);

  assert.equal(answers.length, 3);
  assert.equal(answers[0].skipped, undefined);
  assert.equal(answers[0].files[0].id, FILE_A);
  assert.equal(answers[1].skipped, true);
  assert.equal(answers[2].files[0].id, FILE_B);
});

test('keepPreviousAttachments restores files only for items without the files key', () => {
  const previous = [
    { text: 'A', files: [{ id: FILE_A, name: 'a.pdf' }] },
    { text: 'B', files: [{ id: FILE_B, name: 'b.png' }] }
  ];
  const result = keepPreviousAttachments(
    [{ text: 'A' }, { text: 'B', files: [] }, { text: 'C' }, { text: 'A', skipped: true }],
    previous,
    item => item.text
  );

  assert.deepEqual(result[0].files, previous[0].files);
  assert.deepEqual(result[1].files, []);
  assert.equal('files' in result[2], false);
  assert.equal('files' in result[3], false);
});

test('resolveAttachments takes file metadata from the database and marks files as linked', async () => {
  const calls = [];
  const executor = {
    many: async (sql, params) => {
      calls.push(['many', params]);
      return [{ id: FILE_A, original_name: 'real.pdf', mime_type: 'application/pdf', size_bytes: '2048' }];
    },
    query: async (sql, params) => calls.push(['query', sql, params])
  };

  const [question, empty] = await resolveAttachments(executor, [
    { text: 'Q', files: [{ id: FILE_A, name: 'forged.exe', size: 1 }] },
    { text: 'R', files: [] }
  ]);

  assert.deepEqual(question.files, [{ id: FILE_A, name: 'real.pdf', mimeType: 'application/pdf', size: 2048 }]);
  assert.equal('files' in empty, false);
  assert.match(calls[1][1], /linked_at = now\(\)/);
});

test('resolveAttachments rejects unknown files', async () => {
  const executor = { many: async () => [], query: async () => {} };
  await assert.rejects(resolveAttachments(executor, [{ files: [{ id: FILE_B }] }]), /Вложение не найдено/);
});

test('decodeAttachmentUpload checks extension and size, mime comes from the extension', () => {
  const upload = decodeAttachmentUpload({ name: 'Схема.PNG', mimeType: 'text/html', base64: Buffer.from('png').toString('base64') });
  assert.equal(upload.mimeType, 'image/png');
  assert.equal(upload.name, 'Схема.PNG');

  assert.throws(() => decodeAttachmentUpload({ name: 'run.exe', base64: 'AAAA' }), /Недопустимый формат/);
  assert.throws(() => decodeAttachmentUpload({ name: 'page.html', base64: 'AAAA' }), /Недопустимый формат/);
  assert.throws(() => decodeAttachmentUpload({ name: 'a.pdf' }), /Файл не передан/);
  assert.throws(() => decodeAttachmentUpload('x'), /Файл не передан/);
});

test('templates and interviews expose download links of attachments', () => {
  const template = toTemplate({ id: 't', number: 1, name: 'T', questions: [{ text: 'Q', files: [{ id: FILE_A, name: 'a.pdf' }] }], tags: [] });
  assert.match(template.questions[0].files[0].url, new RegExp(`/files/${FILE_A}$`));

  const interview = toInterview({ answers: [{ question: 'Q', answer: '', files: [{ id: FILE_B, name: 'b.png' }] }] });
  assert.match(interview.answers[0].files[0].url, new RegExp(`/files/${FILE_B}$`));
});
