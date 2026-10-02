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

test('normalizeAnswers keeps the custom flag of interviewer questions', () => {
  const answers = normalizeAnswers([
    { question: 'Вопрос шаблона', answer: 'Да' },
    // Свой вопрос интервьюера — не из шаблона.
    { question: 'Почему уходите?', answer: 'Рост', custom: true },
    { question: 'Флаг строкой', answer: 'Ок', custom: 'true' }
  ]);

  assert.equal(answers[0].custom, undefined);
  assert.equal(answers[1].custom, true);
  assert.equal(answers[2].custom, true);
});

test('normalizeAnswers tolerates missing input', () => {
  assert.deepEqual(normalizeAnswers(undefined), []);
  assert.deepEqual(normalizeAnswers([null, {}]), []);
});
