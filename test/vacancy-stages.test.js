import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeTemplateBindings } from '../server/services/references.js';

const TEMPLATE = '11111111-1111-4111-8111-111111111111';

test('normalizeTemplateBindings keeps templates and required stages without a template', () => {
  const bindings = normalizeTemplateBindings([
    { stage: 'HR screening', templateId: TEMPLATE, required: true },
    { stage: 'Проф. интервью', templateId: '', required: true },
    // Необязательный этап без шаблона не хранится.
    { stage: 'Финальное интервью', templateId: '', required: false },
    { stage: 'Offer', templateId: TEMPLATE, required: false }
  ]);
  assert.deepEqual(bindings, [
    { stage: 'HR screening', templateId: TEMPLATE, required: true },
    { stage: 'Проф. интервью', templateId: '', required: true },
    { stage: 'Offer', templateId: TEMPLATE, required: false }
  ]);
});

test('normalizeTemplateBindings rejects unknown and duplicate stages', () => {
  assert.throws(() => normalizeTemplateBindings([{ stage: 'Нет такого', required: true }]), /этап/);
  assert.throws(
    () => normalizeTemplateBindings([
      { stage: 'Offer', required: true },
      { stage: 'Offer', templateId: TEMPLATE }
    ]),
    /только один шаблон/
  );
});
