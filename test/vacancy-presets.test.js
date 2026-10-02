import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toPublicError } from '../server/lib/errors.js';
import { mcpTools } from '../server/mcp/tools.js';
import { rpcDocs } from '../server/openapi/index.js';
import { AUDIT_ENTITIES } from '../server/services/audit.js';
import { LIFECYCLE_TYPES } from '../server/services/lifecycle.js';
import { toVacancyPreset } from '../server/services/mappers.js';
import { copyableStageBindings, describeVacancyStages } from '../server/services/references.js';

const ACTIVE = '11111111-1111-4111-8111-111111111111';
const ARCHIVED = '22222222-2222-4222-8222-222222222222';
const DELETED = '33333333-3333-4333-8333-333333333333';

const row = (stage, templateId, extra = {}) => ({
  stage,
  template_id: templateId,
  required: false,
  name: `Шаблон ${stage}`,
  number: 7,
  archived: false,
  deleted: false,
  ...extra
});

test('copyableStageBindings copies stages in pipeline order with required flags', () => {
  const { bindings, skipped } = copyableStageBindings({
    rows: [row('Проф. интервью', ACTIVE, { required: true }), row('HR screening', ACTIVE)],
    requiredStages: ['Проф. интервью', 'Финальное интервью']
  });

  assert.deepEqual(bindings, [
    { stage: 'HR screening', templateId: ACTIVE, required: false },
    { stage: 'Проф. интервью', templateId: ACTIVE, required: true },
    // Обязательный этап без шаблона копируется тоже.
    { stage: 'Финальное интервью', templateId: '', required: true }
  ]);
  assert.deepEqual(skipped, []);
});

test('copyableStageBindings drops archived and trashed interview templates but keeps the stage required', () => {
  const { bindings, skipped } = copyableStageBindings({
    rows: [
      row('HR screening', ARCHIVED, { archived: true, required: true, name: 'Скрининг', number: 3 }),
      row('Offer', DELETED, { deleted: true, name: 'Оффер', number: 4 })
    ],
    requiredStages: ['HR screening']
  });

  // Необязательный этап с шаблоном в корзине пропадает целиком: без шаблона он не хранится.
  assert.deepEqual(bindings, [{ stage: 'HR screening', templateId: '', required: true }]);
  assert.deepEqual(skipped, [
    { stage: 'HR screening', number: 3, name: 'Скрининг' },
    { stage: 'Offer', number: 4, name: 'Оффер' }
  ]);
});

test('copyableStageBindings takes the required flag from the binding too (imported data)', () => {
  const { bindings } = copyableStageBindings({
    rows: [row('HR screening', ACTIVE, { required: true })],
    requiredStages: []
  });

  assert.deepEqual(bindings, [{ stage: 'HR screening', templateId: ACTIVE, required: true }]);
});

test('describeVacancyStages lists stages in pipeline order for the audit log', () => {
  const text = describeVacancyStages(
    [{ stage: 'Проф. интервью', name: 'Тех. интервью .NET' }, { stage: 'HR screening', name: 'Скрининг' }],
    ['Проф. интервью', 'Финальное интервью']
  );

  assert.equal(
    text,
    'HR screening: Скрининг; Проф. интервью: Тех. интервью .NET (обязательный); Финальное интервью: без шаблона (обязательный)'
  );
  assert.equal(describeVacancyStages([], []), '');
});

test('toVacancyPreset maps a row with stages and vacancy count', () => {
  const preset = toVacancyPreset({
    id: ACTIVE,
    number: 5,
    name: '.NET разработчик',
    required_stages: ['HR screening'],
    templates: [{ id: ARCHIVED, number: 2, name: 'Скрининг', stage: 'HR screening', required: true, archived: false }],
    vacancy_count: '3',
    created_at: null,
    updated_at: null,
    archived_at: null,
    deleted_at: null
  });

  assert.equal(preset['Preset ID'], ACTIVE);
  assert.equal(preset['№'], 5);
  assert.equal(preset['Название'], '.NET разработчик');
  assert.deepEqual(preset.requiredStages, ['HR screening']);
  assert.equal(preset.templates.length, 1);
  assert.equal(preset.vacancyCount, 3);
  assert.equal(preset.state, 'active');
});

test('duplicate vacancy preset names become a 409 with a readable message', () => {
  const error = toPublicError({ code: '23505', constraint: 'vacancy_presets_name_active_uq' });

  assert.equal(error.status, 409);
  assert.match(error.message, /уже существует/);
});

test('every lifecycle type is audited and listed in OpenAPI and MCP enums', () => {
  assert.ok(LIFECYCLE_TYPES.includes('vacancy_preset'));

  for (const type of LIFECYCLE_TYPES) {
    assert.ok(AUDIT_ENTITIES[type], `AUDIT_ENTITIES.${type}`);
  }

  const sorted = list => [...list].sort();
  assert.deepEqual(sorted(rpcDocs.archiveEntity.args.properties.type.enum), sorted(LIFECYCLE_TYPES));
  assert.deepEqual(sorted(rpcDocs.getHistory.args.properties.entityType.enum), sorted(LIFECYCLE_TYPES));

  const tool = name => mcpTools.find(item => item.name === name);
  assert.deepEqual(sorted(tool('set_record_state').inputSchema.properties.type.enum), sorted(LIFECYCLE_TYPES));
  assert.deepEqual(sorted(tool('get_history').inputSchema.properties.entityType.enum), sorted(LIFECYCLE_TYPES));
  assert.ok(tool('list_records').inputSchema.properties.kind.enum.includes('vacancy_presets'));
  assert.ok(tool('save_vacancy_preset'));
  assert.ok(tool('save_vacancy').inputSchema.properties.presetId);
});
