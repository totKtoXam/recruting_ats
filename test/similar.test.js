import assert from 'node:assert/strict';
import { test } from 'node:test';
import { damerauLevenshtein, similarity } from '../server/lib/text-distance.js';
import { matchCandidate, nameSimilarity } from '../server/services/similar.js';

test('damerauLevenshtein counts transpositions as one edit', () => {
  assert.equal(damerauLevenshtein('иванов', 'иванов'), 0);
  assert.equal(damerauLevenshtein('иванов', 'ивнаов'), 1);
  assert.equal(damerauLevenshtein('иванов', 'ивановв'), 1);
  assert.equal(damerauLevenshtein('kitten', 'sitting'), 3);
  assert.equal(similarity('Ли', 'Ло'), 0);
  assert.equal(similarity('иванов', 'иванов'), 1);
});

const stored = { lastName: 'Мендибаев', firstName: 'Акылбек', middleName: '', email: 'a@example.com', phone: '+7 747 910 03 21', telegram: '' };

test('nameSimilarity ignores case, spaces, script and name order; catches typos', () => {
  assert.equal(nameSimilarity({ lastName: ' мендибаев ', firstName: 'АКЫЛБЕК' }, stored), 1);
  assert.equal(nameSimilarity({ lastName: 'Mendibaev', firstName: 'Akylbek' }, stored), 1);
  assert.equal(nameSimilarity({ lastName: 'Акылбек', firstName: 'Мендибаев' }, stored), 1);
  assert.ok(nameSimilarity({ lastName: 'Мендибаеф', firstName: 'Акылбек' }, stored) >= 0.85);
  assert.equal(nameSimilarity({ lastName: 'Мендибаев', firstName: '' }, stored), 1);
  assert.equal(nameSimilarity({ lastName: 'Иванов', firstName: 'Акылбек' }, stored), 0);
  assert.equal(nameSimilarity({ lastName: 'Менд', firstName: '' }, stored), 0);
  assert.equal(nameSimilarity({ lastName: 'Иванов', firstName: 'Иван', middleName: 'Петрович' }, { lastName: 'Иванов', firstName: 'Иван', middleName: 'Сергеевич' }), 0.85);
});

test('matchCandidate reports exact contact matches and fuzzy names', () => {
  const byPhone = matchCandidate({ lastName: 'Другой', firstName: 'Человек', phone: '87479100321' }, stored);
  assert.deepEqual(byPhone.matchedBy, ['phone']);
  assert.equal(byPhone.score, 1);
  const byName = matchCandidate({ lastName: 'Мендибаев', firstName: 'Акылбек' }, stored);
  assert.deepEqual(byName.matchedBy, ['name']);
  assert.equal(matchCandidate({ lastName: 'Петров', firstName: 'Олег', email: 'other@example.com' }, stored), null);
});