import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applySwitches } from '../server/services/notifications.js';

const PREFS = {
  assigned: { app: true, email: true, telegram: true },
  candidate_changed: { app: true, email: false, telegram: false }
};

test('applySwitches without switches keeps the matrix as is', () => {
  assert.deepEqual(applySwitches(PREFS), PREFS);
});

test('applySwitches turns off a muted channel and a muted kind, other cells stay', () => {
  const effective = applySwitches(PREFS, { mutedChannels: ['email'], mutedKinds: ['candidate_changed'] });
  assert.deepEqual(effective, {
    assigned: { app: true, email: false, telegram: true },
    candidate_changed: { app: false, email: false, telegram: false }
  });
  // Исходная матрица не меняется.
  assert.equal(PREFS.assigned.email, true);
});
