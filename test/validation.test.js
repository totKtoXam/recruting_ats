import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDateTime } from '../server/lib/dates.js';
import {
  composeFullName,
  normalizeKzPhone,
  normalizeMoney,
  normalizeProfileUrl,
  normalizeTelegram,
  splitFullName,
  validateEmail
} from '../server/lib/validation.js';
import { candidateFolderName, decodeResumeUpload } from '../server/services/files.js';

test('normalizeKzPhone accepts common Kazakhstan mobile formats', () => {
  for (const input of ['+7 701 123 45 67', '87011234567', '7011234567', '8 (701) 123-45-67']) {
    assert.equal(normalizeKzPhone(input), '+7 701 123 45 67');
  }
  assert.throws(() => normalizeKzPhone('+7 312 123 45 67'), /мобильным номером РК/);
  assert.throws(() => normalizeKzPhone('123'), /мобильным номером РК/);
});

test('validateEmail lowercases and rejects malformed values', () => {
  assert.equal(validateEmail(' A@B.KZ '), 'a@b.kz');
  assert.equal(validateEmail(''), '');
  assert.throws(() => validateEmail('not-an-email'), /Некорректный email/);
});

test('normalizeTelegram builds t.me links from usernames', () => {
  assert.deepEqual(normalizeTelegram('@user_name'), { display: '@user_name', url: 'https://t.me/user_name' });
  assert.deepEqual(normalizeTelegram('t.me/user_name'), { display: '@user_name', url: 'https://t.me/user_name' });
  assert.throws(() => normalizeTelegram('@abc'), /Telegram/);
});

test('normalizeProfileUrl expands GitHub and LinkedIn handles', () => {
  assert.equal(normalizeProfileUrl('octocat', 'github'), 'https://github.com/octocat');
  assert.equal(normalizeProfileUrl('github.com/octocat', 'github'), 'https://github.com/octocat');
  assert.equal(normalizeProfileUrl('jdoe', 'linkedin'), 'https://www.linkedin.com/in/jdoe');
  assert.equal(normalizeProfileUrl('in/jdoe', 'linkedin'), 'https://www.linkedin.com/in/jdoe');
});

test('normalizeMoney parses spaced and comma values', () => {
  assert.equal(normalizeMoney('500 000'), 500000);
  assert.equal(normalizeMoney('1,5'), 2);
  assert.equal(normalizeMoney(''), null);
  assert.throws(() => normalizeMoney('-1'), /денежное/);
});

test('full name helpers', () => {
  assert.equal(composeFullName(' Иванов ', 'Иван', ''), 'Иванов Иван');
  assert.deepEqual(splitFullName('Иванов Иван Иванович'), {
    lastName: 'Иванов',
    firstName: 'Иван',
    middleName: 'Иванович'
  });
});

test('decodeResumeUpload enforces format and size', () => {
  const base64 = Buffer.from('%PDF').toString('base64');
  const upload = decodeResumeUpload({ name: 'cv.PDF', base64 });
  assert.equal(upload.mimeType, 'application/pdf');
  assert.equal(upload.buffer.toString(), '%PDF');
  assert.throws(() => decodeResumeUpload({ name: 'cv.exe', base64 }), /форматы/);
  const huge = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
  assert.throws(() => decodeResumeUpload({ name: 'cv.pdf', base64: huge }), /10 МБ/);
});

test('candidateFolderName keeps the original Drive folder format', () => {
  assert.equal(
    candidateFolderName('a1b2c3d4-0000-4000-8000-000000000000', 'Иванов/Иван'),
    'Иванов_Иван - A1B2C3D4'
  );
  assert.equal(candidateFolderName('a1b2c3d4-0000-4000-8000-000000000000', ''), 'Кандидат - A1B2C3D4');
});

test('formatDateTime renders app timezone wall-clock time', () => {
  assert.equal(formatDateTime(new Date('2025-03-01T07:30:00Z')), '2025-03-01 12:30:00');
  assert.equal(formatDateTime(null), '');
});
