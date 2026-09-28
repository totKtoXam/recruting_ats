import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeBasePath } from '../server/config.js';

test('normalizeBasePath returns empty string for root', () => {
  for (const input of [undefined, '', ' ', '/', '//']) {
    assert.equal(normalizeBasePath(input), '');
  }
});

test('normalizeBasePath adds leading slash and strips trailing slash', () => {
  assert.equal(normalizeBasePath('/hr-ats'), '/hr-ats');
  assert.equal(normalizeBasePath('hr-ats'), '/hr-ats');
  assert.equal(normalizeBasePath('/hr-ats/'), '/hr-ats');
  assert.equal(normalizeBasePath('/apps/hr_ats.v2'), '/apps/hr_ats.v2');
});

test('normalizeBasePath rejects unsafe values', () => {
  for (const input of ['/hr ats', '/hr-ats?x=1', "/a'b", '/a"b', '/<x>', '/a//b']) {
    assert.throws(() => normalizeBasePath(input), /BASE_PATH/);
  }
});
