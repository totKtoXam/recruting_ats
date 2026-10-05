import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canViewSalary,
  decryptSalary,
  decryptSalaryText,
  encryptSalary,
  encryptSalaryText,
  requireSalaryAccess
} from '../server/lib/salary.js';
import { decryptSecret, encryptSecret } from '../server/lib/secretbox.js';
import { normalizeScopes } from '../server/lib/scopes.js';
import { toCandidate, toPublicUser } from '../server/services/mappers.js';
import { entryDisplays } from '../server/services/audit.js';

const withScope = { id: 'u1', is_active: true, scopes: ['salary'] };
const withoutScope = { id: 'u2', is_active: true, is_admin: true, scopes: [] };

const candidateRow = enc => ({
  id: 'c1', number: 1, last_name: 'Иванов', first_name: 'Иван', middle_name: '',
  status: 'Новый', links: [], salary_expectation_enc: enc,
  created_at: new Date(), updated_at: new Date()
});

test('salary is encrypted with a random IV and decrypts back to a number', () => {
  const a = encryptSalary(750000);
  const b = encryptSalary(750000);
  assert.notEqual(a, b);
  assert.ok(!a.includes('750000'));
  assert.equal(decryptSalary(a), 750000);
  assert.equal(encryptSalary(null), null);
  assert.equal(encryptSalary(''), null);
  assert.equal(decryptSalary(null), null);
  assert.equal(decryptSalary('v1:broken:data:here'), undefined);
  assert.equal(decryptSalaryText(encryptSalaryText('500 000 тг')), '500 000 тг');
});

test('salary and settings secrets use different keys', () => {
  const salary = encryptSalary(100000);
  assert.equal(decryptSecret(salary), null);
  assert.equal(decryptSalary(encryptSecret('100000')), undefined);
});

test('salary scope: only users with the scope, admin rights do not imply it', () => {
  assert.equal(canViewSalary(withScope), true);
  assert.equal(canViewSalary(withoutScope), false);
  assert.equal(canViewSalary({ ...withScope, is_active: false }), false);
  assert.equal(canViewSalary(null), false);
  assert.throws(() => requireSalaryAccess(withoutScope), error => error.status === 403);
  assert.doesNotThrow(() => requireSalaryAccess(withScope));
});

test('normalizeScopes keeps known scopes once and rejects unknown ones', () => {
  assert.deepEqual(normalizeScopes(['salary', 'salary']), ['salary']);
  assert.deepEqual(normalizeScopes(undefined), []);
  assert.throws(() => normalizeScopes(['salary', 'root']), /Неизвестный доступ: root/);
});

test('candidate card shows salary only to a viewer with the scope', () => {
  const row = candidateRow(encryptSalary(640000));
  assert.equal(toCandidate(row, [], withScope)['Зарплатные ожидания'], 640000);
  assert.equal(toCandidate(row, [], withScope).salaryUnreadable, false);
  assert.ok(!('Зарплатные ожидания' in toCandidate(row, [], withoutScope)));
  // Списки (без viewer) ЗП не содержат никогда.
  assert.ok(!('Зарплатные ожидания' in toCandidate(row)));
  assert.equal(toCandidate(candidateRow(null), [], withScope)['Зарплатные ожидания'], '');
  const broken = toCandidate(candidateRow('v1:AAAA:AAAA:AAAA'), [], withScope);
  assert.equal(broken['Зарплатные ожидания'], '');
  assert.equal(broken.salaryUnreadable, true);
});

test('audit entries of the salary field are hidden without the scope', () => {
  const row = {
    entity_type: 'candidate', field: 'salary_expectation', action: 'update',
    old_display: encryptSalaryText('500 000'), new_display: encryptSalaryText('600 000')
  };
  assert.deepEqual(entryDisplays(row, withScope), { oldDisplay: '500 000', newDisplay: '600 000' });
  assert.deepEqual(entryDisplays(row, withoutScope), { oldDisplay: 'скрыто', newDisplay: 'скрыто' });
  const plain = { entity_type: 'candidate', field: 'phone', action: 'update', old_display: '1', new_display: '2' };
  assert.deepEqual(entryDisplays(plain, withoutScope), { oldDisplay: '1', newDisplay: '2' });
});

test('public user carries scopes for the UI', () => {
  assert.deepEqual(toPublicUser({ id: 'u', email: 'a@b.c', scopes: ['salary'] }).scopes, ['salary']);
  assert.deepEqual(toPublicUser({ id: 'u', email: 'a@b.c' }).scopes, []);
});
