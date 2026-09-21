import { APP_CONFIG } from '../config.js';
import { db, transaction } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import { clean, isUuid, optionalUuid } from '../lib/validation.js';
import { toInterview } from './mappers.js';
import { getTemplatesFor } from './references.js';
import {
  appendTransitionLog,
  getStageResponsible,
  loadCandidateDto
} from './candidates.js';

const INTERVIEW_SELECT = `
  SELECT i.*,
         c.last_name   AS candidate_last_name,
         c.first_name  AS candidate_first_name,
         c.middle_name AS candidate_middle_name,
         v.name        AS vacancy_name
  FROM interviews i
  JOIN candidates c ON c.id = i.candidate_id
  JOIN vacancies v ON v.id = i.vacancy_id
`;

export async function getInterviews(candidateId) {
  if (!isUuid(candidateId)) {
    return [];
  }

  const rows = await db.many(
    INTERVIEW_SELECT + ' WHERE i.candidate_id = $1 AND i.deleted_at IS NULL ORDER BY i.created_at',
    [candidateId]
  );
  return rows.map(toInterview);
}

function assertTransitionAllowed(fromStatus, toStatus) {
  const allowed = APP_CONFIG.TRANSITIONS[fromStatus] || [];

  if (!allowed.includes(toStatus)) {
    fail(`Переход "${fromStatus}" → "${toStatus}" не разрешён.`);
  }
}

export async function getInterviewContext(input = {}) {
  const candidateId = optionalUuid(input.candidateId, 'Кандидат не найден.');
  const candidate = candidateId ? await loadCandidateDto(candidateId) : null;

  if (!candidate || candidate.archived) {
    fail('Кандидат не найден.', 404);
  }

  assertTransitionAllowed(candidate['Статус'], input.toStatus);

  return {
    candidate,
    fromStatus: candidate['Статус'],
    toStatus: input.toStatus,
    templates: await getTemplatesFor(candidate['Vacancy ID'], candidate['Статус'])
  };
}

function normalizeAnswers(answers) {
  return Array.isArray(answers)
    ? answers
        .map(item => ({
          question: clean(item && item.question),
          answer: clean(item && item.answer)
        }))
        .filter(item => item.question || item.answer)
    : [];
}

async function saveTransitionInterview(tx, candidate, fromStatus, toStatus, input, responsible) {
  const templateId = clean(input.templateId);
  const templates = await getTemplatesFor(candidate.vacancy_id, fromStatus, tx);
  const requiredTemplates = templates.filter(template => template.required);

  if (requiredTemplates.length > 1) {
    fail('Для вакансии и этапа настроено несколько обязательных шаблонов.');
  }

  const requiredTemplate = requiredTemplates[0] || null;

  if (requiredTemplate && templateId !== requiredTemplate['Template ID']) {
    fail(`Для перехода необходимо заполнить обязательный шаблон "${requiredTemplate['Название']}".`);
  }

  let template = null;

  if (templateId) {
    template = templates.find(item => item['Template ID'] === templateId) || null;

    if (!template) {
      fail('Шаблон интервью не найден или не соответствует вакансии и этапу.');
    }
  }

  const answers = normalizeAnswers(input.answers);

  if (template && template.required) {
    if (!template.questions.length) {
      fail('Обязательный шаблон не содержит вопросов.');
    }

    const incomplete = template.questions.some((question, index) => {
      const answer = answers[index];
      return !answer || answer.question !== question || !answer.answer;
    });

    if (incomplete) {
      fail('Заполните все вопросы обязательного шаблона.');
    }
  }

  const result = clean(input.result);

  if (!result) {
    fail('Укажите результат интервью/этапа.');
  }

  const saved = await tx.one(
    `INSERT INTO interviews
       (candidate_id, vacancy_id, stage, from_status, to_status, template_id, template_name,
        responsible_id, interviewer_last_name, interviewer_first_name, interviewer_middle_name,
        answers, comment, result)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      candidate.id,
      candidate.vacancy_id,
      fromStatus,
      toStatus,
      template ? template['Template ID'] : null,
      template ? template['Название'] : '',
      responsible.id,
      responsible.last_name,
      responsible.first_name,
      responsible.middle_name,
      JSON.stringify(answers),
      clean(input.comment),
      result
    ]
  );

  return toInterview(await tx.one(INTERVIEW_SELECT + ' WHERE i.id = $1', [saved.id]));
}

export async function transitionCandidate(input, changedBy) {
  if (!input || !input.candidateId || !input.toStatus) {
    fail('Не указаны параметры перехода.');
  }

  return transaction(async tx => {
    const candidate = isUuid(input.candidateId)
      ? await tx.one(
          'SELECT * FROM candidates WHERE id = $1 AND archived_at IS NULL FOR UPDATE',
          [input.candidateId]
        )
      : null;

    if (!candidate) {
      fail('Кандидат не найден.', 404);
    }

    const fromStatus = candidate.status;
    const toStatus = clean(input.toStatus);

    assertTransitionAllowed(fromStatus, toStatus);

    const currentStageResponsible = await getStageResponsible(tx, candidate, fromStatus);
    const nextStageResponsible = await getStageResponsible(tx, candidate, toStatus);

    const interview = await saveTransitionInterview(
      tx,
      candidate,
      fromStatus,
      toStatus,
      input.interview || {},
      currentStageResponsible
    );

    const updated = await tx.one(
      'UPDATE candidates SET status = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [candidate.id, toStatus]
    );

    await appendTransitionLog(tx, {
      candidate: updated,
      fromStatus,
      toStatus,
      responsible: nextStageResponsible,
      changedBy,
      comment: input.interview && input.interview.comment
    });

    return {
      ok: true,
      candidate: await loadCandidateDto(candidate.id, tx),
      interview
    };
  });
}

export async function updateInterview(input) {
  const id = optionalUuid(input && input.id, 'Результат интервью не найден.');

  if (!id) {
    fail('Не указан Interview ID.');
  }

  const saved = await db.one(
    `UPDATE interviews
     SET answers = COALESCE($2::jsonb, answers), comment = $3, result = $4, updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING id`,
    [
      id,
      Array.isArray(input.answers) ? JSON.stringify(normalizeAnswers(input.answers)) : null,
      clean(input.comment),
      clean(input.result)
    ]
  );

  if (!saved) {
    fail('Результат интервью не найден.', 404);
  }

  return {
    ok: true,
    interview: toInterview(await db.one(INTERVIEW_SELECT + ' WHERE i.id = $1', [id]))
  };
}

export async function deleteInterview(id) {
  const saved = await db.one(
    `UPDATE interviews SET deleted_at = now(), updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [optionalUuid(id, 'Запись не найдена.')]
  );

  if (!saved) {
    fail('Запись не найдена.', 404);
  }

  return {
    ok: true,
    entity: toInterview(await db.one(INTERVIEW_SELECT + ' WHERE i.id = $1', [saved.id]))
  };
}
