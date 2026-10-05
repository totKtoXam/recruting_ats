// Инструменты MCP-сервера ATS. Каждый инструмент вызывает те же сервисы и RPC-методы,
// что и интерфейс, от имени владельца OAuth-токена: права, проверки и журнал изменений общие.
// Ответы сокращены до полей, полезных модели (ключи на английском, значения как в ATS).
import { APP_CONFIG, config } from '../config.js';
import { db } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import { downloadStream, getFileMeta } from '../lib/drive.js';
import { extractResumeText } from '../lib/resume-text.js';
import { richToText } from '../lib/richtext.js';
import { isUuid } from '../lib/validation.js';
import { rpcHandlers } from '../rpc.js';
import * as candidates from '../services/candidates.js';
import { createCandidateDraft } from '../services/drafts.js';
import { toPublicUser } from '../services/mappers.js';
import { SCOPE_KEYS } from '../lib/scopes.js';
import { createUploadLink, takeUpload } from './uploads.js';

const PIPELINE = APP_CONFIG.PIPELINE_STATUSES;
const ALL_STATUSES = [...PIPELINE, APP_CONFIG.REJECTED_STATUS];
const MAX_RESUME_TEXT_CHARS = 40000;

export const MCP_INSTRUCTIONS = `Recruiting ATS — система подбора персонала. Воронка кандидата: ${PIPELINE.join(' → ')}; «${APP_CONFIG.REJECTED_STATUS}» — с любого этапа.
Все действия выполняются от имени пользователя, подключившего сервер, с его правами, и пишутся в журнал изменений ATS.

Правила:
1. Перед любым инструментом, который изменяет данные (у него нет readOnlyHint), покажи пользователю, что именно будет записано, и дождись явного подтверждения. Простые действия (комментарий, реакция, архив/восстановление, статус вакансии, подписка, отметка уведомлений, откат поля) — кратко в чате. Сложные формы (карточка кандидата, перевод по этапу с ответами на вопросы и отказ, вакансия с шаблонами, шаблон вакансии, шаблон интервью, пользователь) — превью формы: визуальный виджет или артефакт, если клиент их поддерживает, иначе аккуратная таблица «поле — значение». Пользователь может переключить режим («покажи в чате» / «покажи превью») — соблюдай выбор до конца разговора.
2. Идентификаторы бери из get_references и search_candidates, не придумывай.
3. Нового кандидата из резюме по умолчанию создавай черновиком (create_candidate_draft): пользователь проверит форму в ATS и сохранит сам. save_candidate без id сразу создаёт кандидата — только по явной просьбе.
4. Перед transition_candidate вызови get_interview_context: на обязательном этапе (resultRequired) нужен итог (result), а при обязательном шаблоне — ещё ответы на все вопросы (или skipped: true). На необязательном этапе итог можно не указывать.
5. Файлы резюме передавай через create_upload_link + curl (uploadId); base64 — только если нет доступа к shell.
6. Персональные данные кандидатов не выводи за пределы разговора с пользователем.`;

const CONFIRM = ' Изменяет данные: перед вызовом покажи пользователю превью и получи подтверждение.';

const candidateUrl = id => `${config.publicUrl}/#/candidate/${encodeURIComponent(id)}`;

// ---------- JSON Schema ----------

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const id = description => str(description, { format: 'uuid' });
const bool = description => ({ type: 'boolean', description });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const arr = (items, description) => ({ type: 'array', items, description });
const obj = (properties, required = [], description) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  ...(description ? { description } : {})
});

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const candidateRef = {
  candidateId: id('ID кандидата (uuid)'),
  number: int('Номер кандидата (№) — вместо candidateId')
};

const fileInput = {
  uploadId: str('uploadId из create_upload_link (предпочтительно)'),
  file: obj(
    { name: str('Имя файла с расширением .pdf/.doc/.docx'), mimeType: str('MIME-тип'), base64: str('Содержимое в base64') },
    ['name', 'base64'],
    'Файл в base64 — только если нет доступа к shell'
  )
};

const linksSchema = arr(obj({ name: str('Название'), url: str('http(s)-ссылка') }, ['name', 'url']), 'Иные ссылки');
const answersSchema = arr(
  obj(
    {
      question: str('Текст вопроса точно как в шаблоне (у своего вопроса — любой)'),
      answer: str('Ответ (текст или HTML)'),
      skipped: bool('Вопрос не задавался (ответ пустой)'),
      custom: bool('Свой вопрос интервьюера, не из шаблона')
    },
    ['question']
  ),
  'Ответы в порядке вопросов шаблона, затем свои вопросы (custom: true)'
);

// ---------- Преобразование ответов ----------

const person = (personId, name) => (personId ? { id: personId, name: name || '' } : null);
const text = html => (html ? richToText(html).trim() : '');

function candidateSummary(c) {
  return {
    id: c['ID'],
    number: c['№'],
    fullName: c['ФИО'],
    status: c['Статус'],
    state: c.state,
    vacancy: c['Vacancy ID'] ? { id: c['Vacancy ID'], number: c['Vacancy №'], name: c['Вакансия'] } : null,
    phone: c['Телефон'] || '',
    email: c['Email'] || '',
    telegram: c['Telegram'] || '',
    source: c['Source ID'] ? { id: c['Source ID'], name: c['Источник'] } : null,
    recruiter: person(c['Responsible ID'], c['Ответственный']),
    createdAt: c['Дата добавления'],
    updatedAt: c['Дата изменения']
  };
}

function candidateFull(c) {
  return {
    ...candidateSummary(c),
    lastName: c['Фамилия'],
    firstName: c['Имя'],
    middleName: c['Отчество'] || '',
    linkedin: c['LinkedIn'] || '',
    github: c['GitHub'] || '',
    // ЗП ожидания — только при доступе (scope «salary»), иначе поля нет.
    ...('Зарплатные ожидания' in c
      ? { salary: c['Зарплатные ожидания'] === '' ? null : c['Зарплатные ожидания'] }
      : {}),
    hrResponsible: person(c['HR Responsible ID'], c['Ответственный HR']),
    techInterviewer: person(c['Tech Interviewer ID'], c['Ответственный проф. интервьювер']),
    rejection: c.rejection || null,
    archivedAt: c.archivedAt || null,
    deletedAt: c.deletedAt || null,
    links: c.links || [],
    resumeVersions: (c.resumeVersions || []).map(version => ({
      fileId: version.id,
      name: version.name,
      url: version.url,
      uploadedAt: version.uploadedAt
    })),
    url: candidateUrl(c['ID'])
  };
}

function interviewOut(i) {
  return {
    id: i['Interview ID'],
    stage: i['Этап'],
    fromStatus: i['From Status'],
    toStatus: i['To Status'],
    template: i['Template ID'] ? { id: i['Template ID'], name: i['Шаблон'] } : null,
    interviewer: person(i['Responsible ID'], i['Интервьюер']),
    date: i['Дата'],
    result: text(i['Результат']),
    answers: (i.answers || []).map(answer => ({
      question: answer.question,
      answer: text(answer.answer),
      ...(answer.skipped ? { skipped: true } : {}),
      ...(answer.custom ? { custom: true } : {})
    })),
    state: i.state
  };
}

function statusLogOut(row) {
  return {
    from: row['From Status'],
    to: row['To Status'],
    changedBy: row['Changed By'],
    responsible: row['Ответственный'] || '',
    comment: text(row['Комментарий']),
    details: row.details || null,
    date: row['Дата']
  };
}

function commentOut(comment) {
  return {
    id: comment.id,
    parentId: comment.parentId || null,
    author: comment.author ? comment.author.name : '',
    text: text(comment.bodyHtml),
    createdAt: comment.createdAt,
    edited: Boolean(comment.edited),
    reactions: (comment.reactions || []).map(reaction => ({ emoji: reaction.emoji, count: reaction.count })),
    canEdit: comment.canEdit,
    canDelete: comment.canDelete
  };
}

function templateOut(t) {
  return {
    id: t['Template ID'],
    number: t['№'],
    name: t['Название'],
    tags: (t.tags || []).map(tag => tag.name),
    questions: t.questions || []
  };
}

// Шаблон вакансии: этапы в формате save_vacancy.templates (с названием шаблона интервью).
function presetOut(p) {
  const byStage = new Map((p.templates || []).map(t => [t.stage, t]));
  const required = p.requiredStages || [];

  return {
    id: p['Preset ID'],
    number: p['№'],
    name: p['Название'],
    stages: PIPELINE.flatMap(stage => {
      const template = byStage.get(stage);
      const isRequired = required.includes(stage) || Boolean(template && template.required);
      if (!template && !isRequired) return [];
      return [{
        stage,
        templateId: template ? template.id : '',
        templateName: template ? template.name : '',
        templateArchived: Boolean(template && template.archived),
        required: isRequired
      }];
    }),
    vacancyCount: p.vacancyCount
  };
}

function currentUserOut(user) {
  const u = toPublicUser(user);
  return { id: u['User ID'], fullName: u['ФИО'], email: u['Email'], isAdmin: Boolean(u.isAdmin), stages: u.stages || [] };
}

// ---------- Помощники ----------

async function resolveCandidateId(args) {
  if (args.candidateId) {
    if (!isUuid(args.candidateId)) fail('Некорректный ID кандидата.');
    return args.candidateId;
  }

  if (args.number !== undefined && args.number !== null && args.number !== '') {
    const number = Number(args.number);
    const row = Number.isInteger(number) ? await db.one('SELECT id FROM candidates WHERE number = $1', [number]) : null;
    if (!row) fail('Кандидат с таким номером не найден.', 404);
    return row.id;
  }

  fail('Укажите candidateId или number.');
}

function resolveFile(args, user) {
  if (args.uploadId) return takeUpload(args.uploadId, user);
  if (args.file && args.file.base64) return args.file;
  return null;
}

const normalize = value => String(value || '').toLowerCase().replace(/ё/g, 'е');

async function searchCandidates(args) {
  const state = ['active', 'archived', 'deleted', 'all'].includes(args.state) ? args.state : 'active';
  const rows = [];

  if (state === 'active' || state === 'all') rows.push(...(await candidates.getCandidateSummaries()));
  if (state === 'archived' || state === 'all') rows.push(...(await candidates.getArchivedCandidateSummaries()));
  if (state === 'deleted' || state === 'all') rows.push(...(await candidates.getDeletedCandidateSummaries()));

  const query = normalize(args.query).trim();
  const words = query.split(/\s+/).filter(Boolean);
  const digits = query.replace(/\D/g, '');

  const matches = rows.filter(c => {
    if (args.vacancyId && c['Vacancy ID'] !== args.vacancyId) return false;
    if (args.status && c['Статус'] !== args.status) return false;
    if (args.sourceId && c['Source ID'] !== args.sourceId) return false;
    if (
      args.responsibleId &&
      ![c['Responsible ID'], c['HR Responsible ID'], c['Tech Interviewer ID']].includes(args.responsibleId)
    ) {
      return false;
    }
    if (!words.length) return true;
    if (/^\d+$/.test(query) && String(c['№']) === query) return true;

    const haystack = normalize(
      [c['ФИО'], c['Email'], c['Telegram'], c['Вакансия'], c['LinkedIn'], c['GitHub'], c['Источник']].join(' ')
    );
    if (words.every(word => haystack.includes(word))) return true;

    return digits.length >= 4 && String(c['Телефон'] || '').replace(/\D/g, '').includes(digits);
  });

  matches.sort((a, b) => b['№'] - a['№']);

  const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
  const offset = Math.max(Number(args.offset) || 0, 0);

  return {
    total: matches.length,
    offset,
    limit,
    items: matches.slice(offset, offset + limit).map(candidateSummary)
  };
}

async function getCandidate(args, { user }) {
  const candidateId = await resolveCandidateId(args);
  const details = await candidates.getCandidateDetails(candidateId, user);
  const result = {
    candidate: candidateFull(details),
    allowedTransitions: await candidates.getAllowedTransitions(candidateId)
  };

  if (args.includeInterviews !== false) {
    result.interviews = (await rpcHandlers.getInterviews(candidateId, { user })).map(interviewOut);
  }

  if (args.includeStatusLog) {
    result.statusLog = (await candidates.getCandidateTransitionStatusLog(candidateId)).map(statusLogOut);
  }

  if (args.includeComments) {
    const comments = await rpcHandlers.listComments({ entityType: 'candidate', entityId: candidateId }, { user });
    result.comments = comments.map(commentOut);
  }

  return result;
}

async function getResumeText(args) {
  const candidateId = await resolveCandidateId(args);
  const base = `SELECT f.* FROM candidate_resumes cr JOIN files f ON f.id = cr.file_id WHERE cr.candidate_id = $1`;
  const file = args.fileId
    ? await db.one(`${base} AND f.id = $2`, [candidateId, isUuid(args.fileId) ? args.fileId : null])
    : await db.one(`${base} ORDER BY cr.uploaded_at DESC LIMIT 1`, [candidateId]);

  if (!file) fail('У кандидата нет резюме.', 404);

  if (!file.drive_file_id) {
    return { candidateId, fileId: file.id, fileName: file.original_name, text: null, externalUrl: file.external_url, note: 'Резюме — внешняя ссылка, текст недоступен.' };
  }

  const meta = await getFileMeta(file.drive_file_id);
  if (meta.trashed) fail('Файл резюме перемещён в корзину Google Drive.', 404);
  if (String(meta.mimeType).startsWith('application/vnd.google-apps.')) {
    return { candidateId, fileId: file.id, fileName: file.original_name, text: null, externalUrl: meta.webViewLink, note: 'Документ Google — откройте по ссылке.' };
  }

  const chunks = [];
  for await (const chunk of await downloadStream(file.drive_file_id)) chunks.push(chunk);

  const extension = (String(file.original_name).split('.').pop() || '').toLowerCase();
  const extracted = await extractResumeText(Buffer.concat(chunks), extension);
  const fullText = extracted.text || '';

  return {
    candidateId,
    fileId: file.id,
    fileName: file.original_name,
    chars: fullText.length,
    truncated: fullText.length > MAX_RESUME_TEXT_CHARS,
    text: fullText.slice(0, MAX_RESUME_TEXT_CHARS),
    links: extracted.links || [],
    note: fullText.trim().length < 80 ? 'Текста почти нет — вероятно, скан.' : undefined
  };
}

async function getReferences(_args, { user }) {
  const r = await rpcHandlers.getReferenceData();

  return {
    currentUser: currentUserOut(user),
    pipelineStatuses: r.pipelineStatuses,
    rejectedStatus: r.rejectedStatus,
    transitions: r.transitions,
    vacancyStatusTransitions: r.vacancyStatusTransitions,
    rejectionReasons: r.rejectionReasons,
    otherReason: r.otherReason,
    vacancies: r.vacancies.map(v => ({ id: v['Vacancy ID'], number: v['№'], name: v['Вакансия'], status: v['Статус'], requiredStages: v.requiredStages || [] })),
    sources: r.sources.map(s => ({ id: s['Source ID'], number: s['№'], name: s['Название'] })),
    responsibles: r.responsibles.map(u => ({
      id: u['Responsible ID'],
      fullName: u['ФИО'],
      email: u['Email'],
      stages: u.stages,
      hasAccess: u.hasAccess
    })),
    templates: r.templates.map(templateOut),
    vacancyPresets: r.vacancyPresets.map(presetOut),
    templateBindings: r.interviewTemplates.map(t => ({
      vacancyId: t['Vacancy ID'],
      stage: t['Этап'],
      templateId: t['Template ID'],
      required: Boolean(t.required)
    })),
    sourceIconKeys: r.sourceIconKeys,
    templateTagColors: r.templateTagColors
  };
}

const CANDIDATE_OPTIONAL = ['middleName', 'email', 'telegram', 'linkedin', 'github', 'salary', 'sourceId', 'links', 'comment', 'draftToken'];

async function saveCandidate(args, { user }) {
  const payload = {};

  if (args.id) {
    // Изменение: обязательные поля формы берутся из карточки, если не переданы.
    const current = await candidates.getCandidateDetails(args.id);
    Object.assign(payload, {
      ID: args.id,
      lastName: args.lastName ?? current['Фамилия'],
      firstName: args.firstName ?? current['Имя'],
      vacancyId: args.vacancyId ?? current['Vacancy ID'],
      phone: args.phone ?? current['Телефон'],
      recruiterId: args.recruiterId ?? current['Responsible ID'],
      hrResponsibleId: args.hrResponsibleId ?? current['HR Responsible ID'],
      techInterviewerId: args.techInterviewerId ?? current['Tech Interviewer ID']
    });
  } else {
    Object.assign(payload, {
      lastName: args.lastName,
      firstName: args.firstName,
      vacancyId: args.vacancyId,
      phone: args.phone,
      recruiterId: args.recruiterId,
      hrResponsibleId: args.hrResponsibleId,
      techInterviewerId: args.techInterviewerId
    });
  }

  for (const key of CANDIDATE_OPTIONAL) {
    if (args[key] !== undefined) payload[key] = args[key];
  }

  const resumeFile = resolveFile({ uploadId: args.resumeUploadId, file: args.resumeFile }, user);
  if (resumeFile) payload.resumeFile = resumeFile;

  const result = await rpcHandlers.saveCandidate(payload, { user });
  return { ok: true, created: !args.id, candidate: candidateFull(result.candidate) };
}

const LIST_METHODS = {
  vacancies: 'listVacancies',
  vacancy_presets: 'listVacancyPresets',
  sources: 'listSources',
  templates: 'listTemplates',
  users: 'listUsers'
};
// Этап вакансии или шаблона вакансии: шаблон вопросов и/или обязательность.
const STAGE_SCHEMA = obj(
  { stage: str('Этап', { enum: PIPELINE }), templateId: str('Шаблон (uuid или пусто — этап без шаблона)'), required: bool('Обязательный этап') },
  ['stage']
);

const STATE_METHODS = { archive: 'archiveEntity', unarchive: 'unarchiveEntity', delete: 'deleteEntity', restore: 'restoreEntity' };

// ---------- Реестр ----------

export const mcpTools = [
  // ----- Чтение -----
  {
    name: 'get_references',
    title: 'Справочники ATS',
    description:
      'Текущий пользователь, этапы и допустимые переходы, активные вакансии, источники, ответственные (с этапами), шаблоны интервью и их привязки к вакансиям, шаблоны вакансий (vacancyPresets — готовые этапы для новой вакансии), причины отказа. Вызывай первым, чтобы получить ID.',
    inputSchema: obj({}),
    annotations: READ,
    handler: getReferences
  },
  {
    name: 'search_candidates',
    title: 'Поиск кандидатов',
    description:
      'Поиск кандидатов по ФИО, email, телефону, Telegram, номеру и фильтрам. Возвращает краткие карточки, новые первыми.',
    inputSchema: obj({
      query: str('Текст поиска: ФИО, email, телефон, Telegram, № кандидата'),
      state: str('Где искать (по умолчанию active)', { enum: ['active', 'archived', 'deleted', 'all'] }),
      status: str('Этап', { enum: ALL_STATUSES }),
      vacancyId: id('Вакансия'),
      sourceId: id('Источник'),
      responsibleId: id('Рекрутер, HR или проф. интервьювер кандидата'),
      limit: int('Сколько вернуть (1–100, по умолчанию 25)', { minimum: 1, maximum: 100 }),
      offset: int('Сдвиг для пагинации', { minimum: 0 })
    }),
    annotations: READ,
    handler: searchCandidates
  },
  {
    name: 'get_candidate',
    title: 'Карточка кандидата',
    description:
      'Полная карточка кандидата: контакты, вакансия, ответственные, отказ, ссылки, версии резюме, допустимые переходы, результаты интервью; по флагам — журнал этапов и комментарии.',
    inputSchema: obj({
      ...candidateRef,
      includeInterviews: bool('Результаты интервью (по умолчанию true)'),
      includeStatusLog: bool('Журнал переходов по этапам'),
      includeComments: bool('Лента комментариев')
    }),
    annotations: READ,
    handler: getCandidate
  },
  {
    name: 'get_resume_text',
    title: 'Текст резюме',
    description: 'Скачивает резюме кандидата (последнюю версию или fileId) из Google Drive и возвращает извлечённый текст.',
    inputSchema: obj({ ...candidateRef, fileId: id('ID версии резюме из resumeVersions') }),
    annotations: READ,
    handler: getResumeText
  },
  {
    name: 'find_similar_candidates',
    title: 'Похожие кандидаты',
    description: 'Проверка дублей: до 5 кандидатов (включая архив и корзину), совпадающих по email, телефону, Telegram или похожему ФИО.',
    inputSchema: obj({
      lastName: str('Фамилия'),
      firstName: str('Имя'),
      middleName: str('Отчество'),
      email: str('Email'),
      phone: str('Телефон'),
      telegram: str('Telegram'),
      excludeId: id('Исключить кандидата')
    }),
    annotations: READ,
    handler: args => rpcHandlers.findSimilarCandidates(args).then(items => ({ items }))
  },
  {
    name: 'create_upload_link',
    title: 'Ссылка для загрузки резюме',
    description:
      'Одноразовая ссылка (30 минут) для загрузки файла резюме (PDF/DOC/DOCX до 10 МБ) через curl. Полученный uploadId передай в parse_resume, create_candidate_draft или save_candidate.',
    inputSchema: obj({}),
    annotations: READ,
    handler: (_args, { user }) => createUploadLink(user)
  },
  {
    name: 'parse_resume',
    title: 'Разбор резюме',
    description:
      'Разбирает файл резюме так же, как автозаполнение в ATS: ФИО, контакты, зарплата (с уверенностью), ссылки, подсказки вакансии и источника, возможные дубли. Ничего не сохраняет.',
    inputSchema: obj(fileInput),
    annotations: READ,
    handler: (args, { user }) => {
      const file = resolveFile(args, user);
      if (!file) fail('Передайте uploadId или file.');
      return rpcHandlers.parseResume(file);
    }
  },
  {
    name: 'get_interview_context',
    title: 'Контекст перехода',
    description:
      'Что нужно для перевода кандидата на этап toStatus: обязателен ли итог (resultRequired — этап обязательный), шаблоны вопросов, привязанные к вакансии и этапу (required — обязательный), с вопросами и предпочтительными ответами.',
    inputSchema: obj({ candidateId: id('ID кандидата'), toStatus: str('Целевой этап', { enum: ALL_STATUSES }) }, ['candidateId', 'toStatus']),
    annotations: READ,
    handler: async (args, context) => {
      const result = await rpcHandlers.getInterviewContext(args, context);
      return {
        fromStatus: result.fromStatus,
        toStatus: result.toStatus,
        resultRequired: Boolean(result.resultRequired),
        templates: (result.templates || []).map(t => ({ ...templateOut(t), required: Boolean(t.required) }))
      };
    }
  },
  {
    name: 'list_comments',
    title: 'Комментарии',
    description: 'Лента комментариев кандидата, вакансии или результата интервью (с ответами и реакциями).',
    inputSchema: obj(
      { entityType: str('Тип записи', { enum: ['candidate', 'vacancy', 'interview'] }), entityId: id('ID записи') },
      ['entityType', 'entityId']
    ),
    annotations: READ,
    handler: async (args, context) => ({ comments: (await rpcHandlers.listComments(args, context)).map(commentOut) })
  },
  {
    name: 'get_history',
    title: 'Журнал изменений',
    description: 'История изменений записи: кто, когда, какое поле, было → стало (для кандидата — вместе с переходами по этапам). id записи журнала нужен для revert_change.',
    inputSchema: obj(
      {
        entityType: str('Тип записи', { enum: ['candidate', 'vacancy', 'source', 'template', 'vacancy_preset', 'interview', 'user'] }),
        entityId: id('ID записи')
      },
      ['entityType', 'entityId']
    ),
    annotations: READ,
    handler: (args, context) => rpcHandlers.getHistory(args, context)
  },
  {
    name: 'get_dashboard',
    title: 'Дашборд',
    description:
      'Сводка за период: KPI, воронка, источники, причины отказов, вакансии, зависшие кандидаты, моя очередь, нагрузка, последние события.',
    inputSchema: obj({ days: int('Период в днях', { enum: [7, 30, 90] }) }),
    annotations: READ,
    handler: (args, context) => rpcHandlers.getDashboardData(args, context)
  },
  {
    name: 'list_records',
    title: 'Таблицы справочников',
    description:
      'Постраничные таблицы вакансий, шаблонов вакансий, источников, шаблонов интервью и пользователей (users — только админ) с фильтрами и сортировкой, включая архив и корзину.',
    inputSchema: obj(
      {
        kind: str('Таблица', { enum: Object.keys(LIST_METHODS) }),
        page: int('Страница (с 1)', { minimum: 1 }),
        pageSize: int('Размер страницы (до 100)', { minimum: 1, maximum: 100 }),
        sort: obj({ key: str('Поле сортировки'), dir: str('Направление', { enum: ['asc', 'desc'] }) }),
        filters: {
          type: 'object',
          description:
            'state: active|archived|deleted|all; vacancies: number, name, status; vacancy_presets: number, name; sources: number, name; templates: number, name, tag; users: email, name, stage, responsible (yes|no), status (active|pending|disabled), admin (yes|no)'
        }
      },
      ['kind']
    ),
    annotations: READ,
    handler: ({ kind, ...input }, context) => {
      if (!LIST_METHODS[kind]) fail('Неизвестная таблица.');
      return rpcHandlers[LIST_METHODS[kind]](input, context);
    }
  },
  {
    name: 'get_notifications',
    title: 'Уведомления',
    description: 'Лента уведомлений текущего пользователя.',
    inputSchema: obj({
      view: str('Какие показать', { enum: ['recent', 'unread', 'important'] }),
      limit: int('Сколько (1–50)', { minimum: 1, maximum: 50 }),
      before: str('Курсор: createdAt последнего полученного уведомления')
    }),
    annotations: READ,
    handler: async (args, context) => {
      const feed = await rpcHandlers.getNotificationFeed(args, context);
      return {
        unread: feed.unread,
        hasMore: feed.hasMore,
        items: feed.items.map(item => ({
          id: item.id,
          kind: item.kindLabel,
          title: item.title,
          body: item.body,
          actor: item.actorName,
          candidateId: item.candidateId,
          candidateNumber: item.candidateNumber,
          read: item.read,
          important: item.important,
          createdAt: item.createdAt
        }))
      };
    }
  },

  // ----- Кандидаты -----
  {
    name: 'create_candidate_draft',
    title: 'Черновик кандидата',
    description:
      'Создаёт черновик кандидата (живёт 7 дней) и возвращает draftUrl — форму нового кандидата с подставленными данными. Кандидат появится только после проверки и «Сохранить» в ATS. Рекомендуемый способ добавить кандидата из резюме.' +
      CONFIRM,
    inputSchema: obj({
      lastName: str('Фамилия'),
      firstName: str('Имя'),
      middleName: str('Отчество'),
      phone: str('Телефон (мобильный РК)'),
      email: str('Email'),
      telegram: str('Telegram'),
      github: str('GitHub'),
      linkedin: str('LinkedIn'),
      salary: str('Зарплатные ожидания (сохраняются зашифрованными; видны только пользователям с доступом к ЗП)'),
      vacancyId: id('Вакансия'),
      sourceId: id('Источник'),
      responsibleId: id('Рекрутер'),
      comment: str('Первый комментарий кандидата'),
      links: linksSchema,
      resumeUploadId: str('uploadId файла резюме'),
      resumeFile: fileInput.file
    }),
    annotations: WRITE,
    handler: async (args, { user }) => {
      const { resumeUploadId, resumeFile, ...fields } = args;
      const resume = resolveFile({ uploadId: resumeUploadId, file: resumeFile }, user);
      return createCandidateDraft({ ...fields, resume: resume || undefined });
    }
  },
  {
    name: 'save_candidate',
    title: 'Сохранить кандидата',
    description:
      'Создаёт кандидата (без id) или изменяет карточку (с id — передавай только изменяемые поля). Создание требует ФИО, вакансию (Открыта), телефон РК, рекрутера, HR, проф. интервьювера и резюме. Пустая строка очищает необязательное поле; links заменяет весь список; новое резюме добавляет версию.' +
      CONFIRM,
    inputSchema: obj({
      id: id('ID кандидата для изменения; без него — создание'),
      lastName: str('Фамилия'),
      firstName: str('Имя'),
      middleName: str('Отчество'),
      vacancyId: id('Вакансия'),
      phone: str('Телефон (мобильный РК)'),
      recruiterId: id('Рекрутер (ответственный за все этапы)'),
      hrResponsibleId: id('Ответственный HR (этап HR screening)'),
      techInterviewerId: id('Проф. интервьювер (этап Проф. интервью)'),
      email: str('Email'),
      telegram: str('Telegram'),
      linkedin: str('LinkedIn'),
      github: str('GitHub'),
      salary: {
        type: ['number', 'string'],
        description: 'Зарплатные ожидания — только если у пользователя есть доступ к ЗП (scope salary), иначе ошибка 403'
      },
      sourceId: str('Источник (uuid или пустая строка)'),
      links: linksSchema,
      comment: str('Только при создании: первый комментарий'),
      draftToken: str('Только при создании: токен черновика (резюме берётся из него)'),
      resumeUploadId: str('uploadId файла резюме'),
      resumeFile: fileInput.file
    }),
    annotations: WRITE,
    handler: saveCandidate
  },
  {
    name: 'transition_candidate',
    title: 'Перевести по этапу',
    description:
      'Переводит кандидата на другой этап. Обычный переход: interview.result обязателен на обязательном этапе (resultRequired в get_interview_context); при обязательном шаблоне — templateId и ответы на все вопросы (сначала get_interview_context). Отказ (toStatus «Отказано»): rejection с byType, reason из rejectionReasons, для «Другое» — comment. Возврат из отказа — только на прежний этап, с comment верхнего уровня.' +
      CONFIRM,
    inputSchema: obj(
      {
        candidateId: id('ID кандидата'),
        toStatus: str('Целевой этап', { enum: ALL_STATUSES }),
        interview: obj({
          templateId: str('Шаблон вопросов (uuid или пусто)'),
          answers: answersSchema,
          result: str('Итог этапа (обязателен на обязательном этапе)'),
          comment: str('Первый комментарий к результату интервью')
        }),
        rejection: obj({
          byType: str('Кто отказал', { enum: ['candidate', 'responsible'] }),
          responsibleId: id('Для responsible: рекрутер, HR или проф. интервьювер кандидата'),
          reason: str('Причина из справочника'),
          comment: str('Комментарий (обязателен для «Другое»)')
        }),
        comment: str('Комментарий при возврате из «Отказано»')
      },
      ['candidateId', 'toStatus']
    ),
    annotations: WRITE,
    handler: async (args, context) => {
      const result = await rpcHandlers.transitionCandidate(args, context);
      return {
        ok: true,
        candidate: candidateSummary(result.candidate),
        interview: result.interview ? interviewOut(result.interview) : null
      };
    }
  },
  {
    name: 'update_interview',
    title: 'Изменить результат интервью',
    description: 'Меняет итог и (если переданы) ответы сохранённого результата интервью. answers заменяет все ответы.' + CONFIRM,
    inputSchema: obj(
      { id: id('ID результата интервью'), result: str('Итог (пустая строка допустима только для необязательного этапа)'), answers: answersSchema },
      ['id', 'result']
    ),
    annotations: WRITE,
    handler: async (args, context) => {
      const result = await rpcHandlers.updateInterview(args, context);
      return { ok: true, interview: interviewOut(result.interview) };
    }
  },
  {
    name: 'set_record_state',
    title: 'Архив и корзина',
    description:
      'Жизненный цикл записи: archive (в архив), unarchive (из архива), delete (архивную — в корзину на 30 дней, только админ), restore (из корзины в архив, только админ).' +
      CONFIRM,
    inputSchema: obj(
      {
        action: str('Действие', { enum: Object.keys(STATE_METHODS) }),
        type: str('Тип записи', { enum: ['candidate', 'vacancy', 'source', 'template', 'vacancy_preset', 'interview', 'user'] }),
        id: id('ID записи')
      },
      ['action', 'type', 'id']
    ),
    annotations: DESTRUCTIVE,
    handler: ({ action, type, id: entityId }, context) => {
      if (!STATE_METHODS[action]) fail('Неизвестное действие.');
      return rpcHandlers[STATE_METHODS[action]]({ type, id: entityId }, context);
    }
  },
  {
    name: 'set_candidate_watch',
    title: 'Подписка на кандидата',
    description: 'Подписывает текущего пользователя на уведомления об изменениях кандидата или отписывает.' + CONFIRM,
    inputSchema: obj({ candidateId: id('ID кандидата'), watch: bool('true — подписаться, false — отписаться') }, ['candidateId', 'watch']),
    annotations: WRITE,
    handler: (args, context) => rpcHandlers.setCandidateWatch({ candidateId: args.candidateId, watch: args.watch === true }, context)
  },
  {
    name: 'mark_notifications_read',
    title: 'Прочитать уведомления',
    description: 'Отмечает уведомление (id) или все уведомления (all: true) прочитанными.' + CONFIRM,
    inputSchema: obj({ id: id('ID уведомления'), all: bool('Отметить все'), read: bool('false — вернуть в непрочитанные') }),
    annotations: WRITE,
    handler: (args, context) =>
      args.all ? rpcHandlers.markAllNotificationsRead({}, context) : rpcHandlers.markNotificationRead({ id: args.id, read: args.read !== false }, context)
  },

  // ----- Комментарии -----
  {
    name: 'add_comment',
    title: 'Добавить комментарий',
    description: 'Комментарий (или ответ на комментарий) к кандидату, вакансии или результату интервью. Текст или простой HTML.' + CONFIRM,
    inputSchema: obj(
      {
        entityType: str('Тип записи', { enum: ['candidate', 'vacancy', 'interview'] }),
        entityId: id('ID записи'),
        text: str('Текст комментария'),
        parentId: id('Ответ на комментарий')
      },
      ['entityType', 'entityId', 'text']
    ),
    annotations: WRITE,
    handler: async (args, context) =>
      commentOut(await rpcHandlers.addComment({ entityType: args.entityType, entityId: args.entityId, bodyHtml: args.text, parentId: args.parentId }, context))
  },
  {
    name: 'edit_comment',
    title: 'Изменить комментарий',
    description: 'Меняет текст своего комментария.' + CONFIRM,
    inputSchema: obj({ id: id('ID комментария'), text: str('Новый текст') }, ['id', 'text']),
    annotations: WRITE,
    handler: async (args, context) => commentOut(await rpcHandlers.updateComment({ id: args.id, bodyHtml: args.text }, context))
  },
  {
    name: 'delete_comment',
    title: 'Удалить комментарий',
    description: 'Удаляет комментарий вместе с ответами (автор или админ).' + CONFIRM,
    inputSchema: obj({ id: id('ID комментария') }, ['id']),
    annotations: DESTRUCTIVE,
    handler: (args, context) => rpcHandlers.deleteComment(args.id, context)
  },
  {
    name: 'toggle_reaction',
    title: 'Реакция',
    description: 'Ставит или снимает реакцию на комментарий.' + CONFIRM,
    inputSchema: obj({ commentId: id('ID комментария'), emoji: str('Реакция', { enum: ['👍', '👎', '❤️', '😂', '🎉', '👀'] }) }, ['commentId', 'emoji']),
    annotations: WRITE,
    handler: (args, context) => rpcHandlers.toggleReaction(args, context)
  },
  {
    name: 'revert_change',
    title: 'Откатить изменение',
    description: 'Возвращает прежнее значение поля по записи журнала (id из get_history, где canRevert = true).' + CONFIRM,
    inputSchema: obj({ id: id('ID записи журнала') }, ['id']),
    annotations: WRITE,
    handler: (args, context) => rpcHandlers.revertChange({ id: args.id }, context)
  },

  // ----- Справочники -----
  {
    name: 'save_vacancy',
    title: 'Сохранить вакансию',
    description:
      'Создаёт (без id, статус «Открыта») или изменяет вакансию. links и templates, если переданы, заменяют весь список; templates — этапы вакансии: шаблон вопросов (не больше одного на этап) и обязательность. Обязательный этап (required) требует итог при переходе, а с шаблоном — ещё ответы; обязательным может быть и этап без шаблона (templateId пустой). presetId — шаблон вакансии (get_references.vacancyPresets): без templates этапы копируются из него один раз; этапы, где шаблон вопросов в архиве, копируются без шаблона и возвращаются в skippedStages.' +
      CONFIRM,
    inputSchema: obj(
      {
        id: id('ID вакансии для изменения'),
        name: str('Название (уникальное)'),
        links: arr(obj({ url: str('Ссылка'), name: str('Подпись') }, ['url']), 'Ссылки (до 20)'),
        templates: arr(STAGE_SCHEMA, 'Этапы: шаблоны вопросов и обязательность'),
        presetId: id('Шаблон вакансии: этапы из него, если templates не передан')
      },
      ['name']
    ),
    annotations: WRITE,
    handler: (args, context) => rpcHandlers.saveVacancy(args, context)
  },
  {
    name: 'set_vacancy_status',
    title: 'Статус вакансии',
    description: 'Меняет статус вакансии: Открыта → На паузе/Закрыта, На паузе → Открыта/Закрыта, Закрыта → Открыта.' + CONFIRM,
    inputSchema: obj({ id: id('ID вакансии'), status: str('Новый статус', { enum: APP_CONFIG.VACANCY_STATUSES }) }, ['id', 'status']),
    annotations: WRITE,
    handler: (args, context) => rpcHandlers.setVacancyStatus(args, context)
  },
  {
    name: 'save_source',
    title: 'Сохранить источник',
    description: 'Создаёт (без id) или переименовывает источник кандидатов; iconKey — значок из sourceIconKeys.' + CONFIRM,
    inputSchema: obj({ id: id('ID источника'), name: str('Название'), iconKey: str('Ключ значка или пустая строка') }, ['name']),
    annotations: WRITE,
    handler: (args, context) => rpcHandlers.saveSource(args, context)
  },
  {
    name: 'save_interview_template',
    title: 'Сохранить шаблон интервью',
    description:
      'Создаёт (без id) или изменяет шаблон вопросов. questions и tags заменяются целиком (не переданные теги удаляются). Привязка к вакансиям — через save_vacancy.' +
      CONFIRM,
    inputSchema: obj(
      {
        id: id('ID шаблона'),
        name: str('Название'),
        questions: arr(obj({ text: str('Вопрос'), answers: arr(str('Ответ'), 'Предпочтительные ответы') }, ['text']), 'Вопросы (минимум один)'),
        tags: arr(obj({ name: str('Тег (до 40 символов)'), color: str('Цвет', { enum: ['blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink', 'gray'] }) }, ['name']), 'Теги (до 10)')
      },
      ['name', 'questions']
    ),
    annotations: WRITE,
    handler: (args, context) => rpcHandlers.saveInterviewTemplate(args, context)
  },
  {
    name: 'save_vacancy_preset',
    title: 'Сохранить шаблон вакансии',
    description:
      'Создаёт (без id) или изменяет шаблон вакансии — готовый набор этапов для новых вакансий: шаблон вопросов (не больше одного на этап) и обязательность. templates, если передан, заменяет все этапы (формат как у save_vacancy). fromVacancyId без templates — взять этапы из вакансии. Новая вакансия из шаблона — save_vacancy с presetId.' +
      CONFIRM,
    inputSchema: obj(
      {
        id: id('ID шаблона вакансии для изменения'),
        name: str('Название (уникальное)'),
        templates: arr(STAGE_SCHEMA, 'Этапы: шаблоны вопросов и обязательность'),
        fromVacancyId: id('Вакансия, из которой взять этапы (если templates не передан)')
      },
      ['name']
    ),
    annotations: WRITE,
    handler: (args, context) => rpcHandlers.saveVacancyPreset(args, context)
  },

  // ----- Пользователи (только администраторы) -----
  {
    name: 'save_user',
    title: 'Сохранить пользователя',
    description:
      'Только админ. Создаёт или изменяет пользователя ATS (он же ответственный). Полная замена: не переданные stages станут пустыми, isAdmin — false. Доступ существующего пользователя меняется через set_user_access.' +
      CONFIRM,
    inputSchema: obj(
      {
        id: id('ID пользователя для изменения'),
        email: str('Email (Google)'),
        lastName: str('Фамилия'),
        firstName: str('Имя'),
        middleName: str('Отчество'),
        stages: arr(str('Этап', { enum: PIPELINE }), 'Этапы, за которые отвечает'),
        isAdmin: bool('Администратор'),
        isActive: bool('Только при создании: открыть доступ в ATS'),
        telegram: str('Telegram @username'),
        scopes: arr(
          str('Доступ', { enum: SCOPE_KEYS }),
          'Доступ к данным: salary — видит и меняет ЗП ожидания кандидатов. Не передан — не меняется'
        )
      },
      ['email', 'lastName', 'firstName']
    ),
    annotations: WRITE,
    handler: (args, context) => rpcHandlers.saveUser(args, context)
  },
  {
    name: 'set_user_access',
    title: 'Доступ пользователя',
    description: 'Только админ. Открывает (true) или закрывает (false) пользователю доступ в ATS.' + CONFIRM,
    inputSchema: obj({ id: id('ID пользователя'), isActive: bool('Доступ открыт') }, ['id', 'isActive']),
    annotations: DESTRUCTIVE,
    handler: (args, context) => rpcHandlers.setUserAccess({ id: args.id, isActive: args.isActive === true }, context)
  }
];
