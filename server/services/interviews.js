import { APP_CONFIG } from '../config.js';
import { db, transaction } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import { clean, composeFullName, isUuid, optionalUuid } from '../lib/validation.js';
import { toInterview } from './mappers.js';
import { getTemplatesFor } from './references.js';
import {
  appendTransitionLog,
  getStageResponsible,
  loadCandidateDto
} from './candidates.js';

const REJECTED = APP_CONFIG.REJECTED_STATUS;

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

// Из «Отказано» можно вернуться только на этап, с которого отказали.
function allowedTransitions(candidate) {
  if (candidate.status === REJECTED) {
    return candidate.rejected_from_status ? [candidate.rejected_from_status] : [];
  }
  return APP_CONFIG.TRANSITIONS[candidate.status] || [];
}

function assertTransitionAllowed(candidate, toStatus) {
  if (!allowedTransitions(candidate).includes(toStatus)) {
    fail(`Переход "${candidate.status}" → "${toStatus}" не разрешён.`);
  }
}

export async function getInterviewContext(input = {}) {
  const candidateId = optionalUuid(input.candidateId, 'Кандидат не найден.');
  const candidate = candidateId
    ? await db.one('SELECT * FROM candidates WHERE id = $1 AND archived_at IS NULL', [candidateId])
    : null;

  if (!candidate) {
    fail('Кандидат не найден.', 404);
  }

  const toStatus = clean(input.toStatus);
  assertTransitionAllowed(candidate, toStatus);

  return {
    candidate: await loadCandidateDto(candidate.id),
    fromStatus: candidate.status,
    toStatus,
    // Шаблон вопросов относится к этапу, НА который переводят кандидата.
    templates:
      toStatus === REJECTED || candidate.status === REJECTED
        ? []
        : await getTemplatesFor(candidate.vacancy_id, toStatus)
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

// Результат этапа, на который переводят кандидата: вопросы шаблона этого этапа
// и ответственный за этот этап (HR — HR screening, проф. интервьювер — Проф. интервью,
// рекрутер — остальные этапы).
async function saveStageInterview(tx, candidate, fromStatus, toStatus, input, responsible) {
  const templateId = clean(input.templateId);
  const templates = await getTemplatesFor(candidate.vacancy_id, toStatus, tx);
  const requiredTemplates = templates.filter(template => template.required);

  if (requiredTemplates.length > 1) {
    fail('Для вакансии и этапа настроено несколько обязательных шаблонов.');
  }

  const requiredTemplate = requiredTemplates[0] || null;

  if (requiredTemplate && templateId !== requiredTemplate['Template ID']) {
    fail(
      `Для перехода на этап «${toStatus}» необходимо заполнить обязательный шаблон ` +
        `«${requiredTemplate['Название']}».`
    );
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
      return !answer || answer.question !== question.text || !answer.answer;
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
     VALUES ($1, $2, $4, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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

// Кем и почему отказано: кандидат либо один из назначенных ему ответственных.
async function validateRejection(tx, candidate, input = {}) {
  const byType = clean(input.byType);
  const reason = clean(input.reason);
  const comment = clean(input.comment);
  let responsible = null;

  if (byType === APP_CONFIG.REJECTED_BY_RESPONSIBLE) {
    const assigned = [
      candidate.recruiter_id,
      candidate.hr_responsible_id,
      candidate.tech_interviewer_id
    ].filter(Boolean);
    const responsibleId = clean(input.responsibleId);

    if (!assigned.includes(responsibleId)) {
      fail('Выберите, кем отказано: кандидатом или одним из его ответственных.');
    }

    responsible = await tx.one('SELECT * FROM responsibles WHERE id = $1', [responsibleId]);
  } else if (byType !== APP_CONFIG.REJECTED_BY_CANDIDATE) {
    fail('Укажите, кем отказано.');
  }

  const known = reason
    ? await tx.one('SELECT 1 FROM dictionaries WHERE category = $1 AND value = $2', [
        APP_CONFIG.REJECTION_REASON_CATEGORIES[byType],
        reason
      ])
    : null;

  if (!known) {
    fail('Выберите причину отказа из списка.');
  }

  if (reason === APP_CONFIG.OTHER_REASON && !comment) {
    fail('Для причины «Другое» опишите причину отказа.');
  }

  return { byType, responsible, reason, comment };
}

async function rejectCandidate(tx, candidate, input) {
  const rejection = await validateRejection(tx, candidate, input.rejection);
  const byName = rejection.responsible
    ? composeFullName(
        rejection.responsible.last_name,
        rejection.responsible.first_name,
        rejection.responsible.middle_name
      )
    : 'Кандидат';

  await tx.query(
    `UPDATE candidates SET
       status = $2, rejected_at = now(), rejected_from_status = $3,
       rejected_by_type = $4, rejected_by_responsible_id = $5,
       rejection_reason = $6, rejection_comment = $7, updated_at = now()
     WHERE id = $1`,
    [
      candidate.id,
      REJECTED,
      candidate.status,
      rejection.byType,
      rejection.responsible ? rejection.responsible.id : null,
      rejection.reason,
      rejection.comment
    ]
  );

  return {
    responsible: rejection.responsible,
    comment:
      `Отказано: ${byName}. Причина: ${rejection.reason}` +
      (rejection.comment ? `. ${rejection.comment}` : ''),
    details: {
      rejection: {
        byType: rejection.byType,
        byResponsibleId: rejection.responsible ? rejection.responsible.id : null,
        byName,
        reason: rejection.reason,
        comment: rejection.comment
      }
    }
  };
}

// Возврат из «Отказано» на прежний этап: анкета этапа повторно не заполняется,
// подробности отказа остаются в журнале переходов.
async function restoreCandidate(tx, candidate, toStatus, input) {
  const responsible = await getStageResponsible(tx, candidate, toStatus);

  await tx.query(
    `UPDATE candidates SET
       status = $2, rejected_at = NULL, rejected_from_status = NULL,
       rejected_by_type = NULL, rejected_by_responsible_id = NULL,
       rejection_reason = '', rejection_comment = '', updated_at = now()
     WHERE id = $1`,
    [candidate.id, toStatus]
  );

  return {
    responsible,
    comment: clean(input.comment) || 'Возврат из «Отказано»'
  };
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

    assertTransitionAllowed(candidate, toStatus);

    let interview = null;
    let outcome;

    if (toStatus === REJECTED) {
      outcome = await rejectCandidate(tx, candidate, input);
    } else if (fromStatus === REJECTED) {
      outcome = await restoreCandidate(tx, candidate, toStatus, input);
    } else {
      const responsible = await getStageResponsible(tx, candidate, toStatus);

      interview = await saveStageInterview(
        tx,
        candidate,
        fromStatus,
        toStatus,
        input.interview || {},
        responsible
      );

      await tx.query('UPDATE candidates SET status = $2, updated_at = now() WHERE id = $1', [
        candidate.id,
        toStatus
      ]);

      outcome = { responsible, comment: input.interview && input.interview.comment };
    }

    await appendTransitionLog(tx, {
      candidate: await tx.one('SELECT * FROM candidates WHERE id = $1', [candidate.id]),
      fromStatus,
      toStatus,
      responsible: outcome.responsible,
      changedBy,
      comment: outcome.comment,
      details: outcome.details
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
