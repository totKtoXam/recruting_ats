import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeAnswers } from '../server/services/interviews.js';

test('normalizeAnswers keeps skipped questions and drops the flag once an answer is given', () => {
  const answers = normalizeAnswers([
    { question: 'Опыт', answer: '<p>5 лет</p>', skipped: true },
    { question: 'Релокация', answer: '', skipped: true },
    { question: 'Зарплата', answer: '' },
    { question: '', answer: '' }
  ]);
  assert.deepEqual(answers, [
    { question: 'Опыт', answer: '<p>5 лет</p>' },
    { question: 'Релокация', answer: '', skipped: true },
    { question: 'Зарплата', answer: '' }
  ]);
});

test('normalizeAnswers tolerates missing input', () => {
  assert.deepEqual(normalizeAnswers(undefined), []);
  assert.deepEqual(normalizeAnswers([null, {}]), []);
});
