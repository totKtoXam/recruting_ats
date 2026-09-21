import { randomUUID } from 'node:crypto';
import { APP_CONFIG } from '../config.js';
import { db, transaction } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import {
  clean,
  composeFullName,
  isUuid,
  normalizeKzPhone,
  normalizeMoney,
  normalizeNamePart,
  normalizeProfileUrl,
  normalizeTelegram,
  optionalUuid,
  validateEmail,
  validateHttpUrl
} from '../lib/validation.js';
import { toCandidate, toResumeVersion, toTransitionLogEntry } from './mappers.js';
import {
  UploadTracker,
  copyFileToCandidate,
  ensureCandidateFolder,
  decodeResumeUpload,
  insertFile,
  uploadCandidateResume
} from './files.js';
import { lockActiveDraft, markDraftUsed, tryLockActiveDraft } from './drafts.js';

const personName = alias =>
  `concat_ws(' ', NULLIF(${alias}.last_name, ''), NULLIF(${alias}.first_name, ''), NULLIF(${alias}.middle_name, ''))`;

export const CANDIDATE_SELECT = `
  SELECT c.*,
         v.name   AS vacancy_name,
         v.number AS vacancy_number,
         s.name   AS source_name,
         ${personName('rec')} AS recruiter_name,
         ${personName('hr')}  AS hr_responsible_name,
         ${personName('ti')}  AS tech_interviewer_name,
         lr.file_id      AS latest_resume_file_id,
         lr.external_url AS latest_resume_external_url
  FROM candidates c
  JOIN vacancies v ON v.id = c.vacancy_id
  LEFT JOIN sources s ON s.id = c.source_id
  LEFT JOIN responsibles rec ON rec.id = c.recruiter_id
  LEFT JOIN responsibles hr  ON hr.id  = c.hr_responsible_id
  LEFT JOIN responsibles ti  ON ti.id  = c.tech_interviewer_id
  LEFT JOIN LATERAL (
    SELECT cr.file_id, f.external_url
    FROM candidate_resumes cr
    JOIN files f ON f.id = cr.file_id
    WHERE cr.candidate_id = c.id
    ORDER BY cr.uploaded_at DESC
    LIMIT 1
  ) lr ON true
`;

// ---------- Чтение ----------

export async function getCandidateSummaries() {
  const rows = await db.many(
    CANDIDATE_SELECT + ' WHERE c.archived_at IS NULL ORDER BY c.number'
  );
  return rows.map(row => toCandidate(row));
}

export async function getArchivedCandidateSummaries() {
  const rows = await db.many(
    CANDIDATE_SELECT + ' WHERE c.archived_at IS NOT NULL ORDER BY c.number'
  );
  return rows.map(row => toCandidate(row));
}

export async function getArchivedCandidateCount() {
  const { count } = await db.one(
    'SELECT count(*)::int AS count FROM candidates WHERE archived_at IS NOT NULL'
  );
  return count;
}

export async function getResumeVersions(candidateId, executor = db) {
  const rows = await executor.many(
    `SELECT cr.file_id, cr.uploaded_at, f.original_name, f.external_url
     FROM candidate_resumes cr
     JOIN files f ON f.id = cr.file_id
     WHERE cr.candidate_id = $1
     ORDER BY cr.uploaded_at DESC`,
    [candidateId]
  );
  return rows.map(toResumeVersion);
}

async function loadCandidateDto(candidateId, executor = db) {
  const row = await executor.one(CANDIDATE_SELECT + ' WHERE c.id = $1', [candidateId]);

  if (!row) {
    return null;
  }

  return toCandidate(row, await getResumeVersions(candidateId, executor));
}

export async function getCandidateDetails(candidateId) {
  const candidate = isUuid(candidateId) ? await loadCandidateDto(candidateId) : null;

  if (!candidate) {
    fail('Кандидат не найден.', 404);
  }

  return candidate;
}

export function calculateStats(active, archivedCount) {
  const byStatus = {};

  for (const candidate of active || []) {
    const status = candidate['Статус'] || 'Без статуса';
    byStatus[status] = (byStatus[status] || 0) + 1;
  }

  return {
    total: (active || []).length,
    archived: Number(archivedCount || 0),
    byStatus
  };
}

// ---------- Ответственные кандидата ----------

export async function resolveResponsible(executor, responsibleId, label, requiredStages) {
  const id = clean(responsibleId);

  if (!id) {
    fail(label + ' обязателен.');
  }

  const responsible = isUuid(id)
    ? await executor.one(
        'SELECT * FROM responsibles WHERE id = $1 AND deleted_at IS NULL',
        [id]
      )
    : null;

  if (!responsible) {
    fail(label + ' не найден или удалён.');
  }

  const missing = (requiredStages || []).filter(stage => !responsible.stages.includes(stage));

  if (missing.length) {
    fail(label + ' не имеет доступа к этапам: ' + missing.join(', ') + '.');
  }

  return responsible;
}

export function getStageResponsible(executor, candidateRow, stage) {
  if (stage === 'HR screening') {
    return resolveResponsible(
      executor,
      candidateRow.hr_responsible_id,
      'Ответственный HR',
      ['HR screening']
    );
  }

  if (stage === 'Техническое интервью') {
    return resolveResponsible(
      executor,
      candidateRow.tech_interviewer_id,
      'Ответственный тех. интервьювер',
      ['Техническое интервью']
    );
  }

  return resolveResponsible(
    executor,
    candidateRow.recruiter_id,
    'Рекрутер',
    APP_CONFIG.PIPELINE_STATUSES
  );
}

// ---------- Журнал переходов ----------

export async function appendTransitionLog(executor, { candidate, fromStatus, toStatus, responsible, changedBy, comment }) {
  await executor.query(
    `INSERT INTO candidate_status_log
       (candidate_id, candidate_number, candidate_full_name, from_status, to_status,
        responsible_id, responsible_name, changed_by_user_id, changed_by_name,
        changed_by_email, comment)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      candidate.id,
      candidate.number ?? null,
      composeFullName(candidate.last_name, candidate.first_name, candidate.middle_name),
      fromStatus || '',
      toStatus,
      responsible ? responsible.id : null,
      responsible
        ? composeFullName(responsible.last_name, responsible.first_name, responsible.middle_name)
        : '',
      changedBy ? changedBy.id : null,
      changedBy ? changedBy.full_name : '',
      changedBy ? changedBy.email : '',
      clean(comment)
    ]
  );
}

export async function getCandidateTransitionStatusLog(candidateId) {
  if (!isUuid(candidateId)) {
    return [];
  }

  const rows = await db.many(
    'SELECT * FROM candidate_status_log WHERE candidate_id = $1 ORDER BY created_at',
    [candidateId]
  );
  return rows.map(toTransitionLogEntry);
}

// ---------- Сохранение ----------

function validateCandidatePayload(payload) {
  if (!payload) fail('Пустые данные кандидата.');
  if (!normalizeNamePart(payload.lastName)) fail('Фамилия обязательна.');
  if (!normalizeNamePart(payload.firstName)) fail('Имя обязательно.');
  if (!payload.vacancyId) fail('Вакансия обязательна.');
  if (!payload.phone) fail('Телефон обязателен.');
  if (!payload.recruiterId && !payload.responsibleId) fail('Рекрутер обязателен.');
  if (!payload.hrResponsibleId) fail('Ответственный HR обязателен.');
  if (!payload.techInterviewerId) fail('Ответственный тех. интервьювер обязателен.');
}

// Значение из payload, если поле передано, иначе текущее значение кандидата.
const pick = (payload, key, fallback) => (payload[key] !== undefined ? payload[key] : fallback);

function normalizeLinks(links) {
  const result = links
    .map(link => ({
      name: clean(link && link.name),
      url: validateHttpUrl(link && link.url)
    }))
    .filter(link => link.name || link.url);

  if (result.some(link => !link.name || !link.url)) {
    fail('Для иной ссылки необходимо заполнить и название, и URL.');
  }

  return result;
}

export async function saveCandidate(payload, changedBy) {
  validateCandidatePayload(payload);

  const tracker = new UploadTracker();
  const resumeUpload = payload.resumeFile ? decodeResumeUpload(payload.resumeFile) : null;
  const isNew = !payload.ID;

  if (!isNew && !isUuid(payload.ID)) {
    fail('Кандидат не найден.', 404);
  }

  try {
    // Работа с Google Drive выполняется до транзакции, чтобы не держать блокировку строки
    // и соединение из пула на время передачи файла.
    const candidateId = isNew ? randomUUID() : payload.ID;
    const stored = isNew
      ? null
      : await db.one(
          'SELECT drive_folder_id, last_name, first_name, middle_name FROM candidates WHERE id = $1',
          [candidateId]
        );

    if (!isNew && !stored) {
      fail('Кандидат не найден.', 404);
    }

    const draftFile =
      isNew && payload.draftToken && !resumeUpload
        ? await db.one(
            `SELECT f.* FROM candidate_drafts d
             JOIN files f ON f.id = d.resume_file_id
             WHERE d.token = $1 AND d.used_at IS NULL AND d.expires_at > now()
               AND f.drive_file_id IS NOT NULL`,
            [clean(payload.draftToken)]
          )
        : null;

    let folderId = null;
    let uploaded = null;

    // Папка кандидата создаётся только когда есть что в неё положить.
    if (resumeUpload || draftFile) {
      folderId = await ensureCandidateFolder(
        tracker,
        candidateId,
        stored
          ? composeFullName(stored.last_name, stored.first_name, stored.middle_name)
          : composeFullName(payload.lastName, payload.firstName, payload.middleName),
        stored && stored.drive_folder_id
      );

      uploaded = resumeUpload
        ? await uploadCandidateResume(tracker, folderId, resumeUpload)
        : await copyFileToCandidate(tracker, draftFile, folderId);
    }

    return await transaction(async tx => {
      let existing = {};

      if (!isNew) {
        existing = await tx.one('SELECT * FROM candidates WHERE id = $1 FOR UPDATE', [candidateId]);

        if (!existing) {
          fail('Кандидат не найден.', 404);
        }
      }

      const vacancyId = clean(payload.vacancyId || existing.vacancy_id);
      const vacancy = isUuid(vacancyId)
        ? await tx.one('SELECT * FROM vacancies WHERE id = $1', [vacancyId])
        : null;

      if (!vacancy) {
        fail('Выбранная вакансия не найдена.');
      }

      const vacancyChanged = clean(existing.vacancy_id) !== vacancyId;

      if ((isNew || vacancyChanged) && (vacancy.deleted_at || vacancy.status !== 'Открыта')) {
        fail('Можно выбрать только открытую вакансию.');
      }

      const recruiter = await resolveResponsible(
        tx,
        payload.recruiterId || payload.responsibleId || existing.recruiter_id,
        'Рекрутер',
        APP_CONFIG.PIPELINE_STATUSES
      );
      const hrResponsible = await resolveResponsible(
        tx,
        payload.hrResponsibleId || existing.hr_responsible_id,
        'Ответственный HR',
        ['HR screening']
      );
      const techInterviewer = await resolveResponsible(
        tx,
        payload.techInterviewerId || existing.tech_interviewer_id,
        'Ответственный тех. интервьювер',
        ['Техническое интервью']
      );

      const sourceId = clean(pick(payload, 'sourceId', existing.source_id));
      let source = null;

      if (sourceId) {
        source = isUuid(sourceId)
          ? await tx.one('SELECT * FROM sources WHERE id = $1', [sourceId])
          : null;

        if (!source) {
          fail('Источник не найден.');
        }

        if ((isNew || clean(existing.source_id) !== sourceId) && source.deleted_at) {
          fail('Выбранный источник удалён.');
        }
      }

      const lastName = normalizeNamePart(pick(payload, 'lastName', existing.last_name));
      const firstName = normalizeNamePart(pick(payload, 'firstName', existing.first_name));
      const middleName = normalizeNamePart(pick(payload, 'middleName', existing.middle_name));
      const fullName = composeFullName(lastName, firstName, middleName);
      const telegram = normalizeTelegram(pick(payload, 'telegram', existing.telegram));
      const linkedin = normalizeProfileUrl(pick(payload, 'linkedin', existing.linkedin), 'linkedin');
      const github = normalizeProfileUrl(pick(payload, 'github', existing.github), 'github');
      const links = Array.isArray(payload.links) ? normalizeLinks(payload.links) : existing.links || [];
      const salary = normalizeMoney(pick(payload, 'salary', existing.salary_expectation));

      if (salary !== null && salary > 10_000_000) {
        fail('ЗП ожидания не может превышать 10 000 000.');
      }

      const phone = normalizeKzPhone(pick(payload, 'phone', existing.phone));
      const email = validateEmail(pick(payload, 'email', existing.email));
      const comment = clean(pick(payload, 'comment', existing.comment));

      // Как в исходной версии: черновик обязан быть активным, только если из него берётся резюме.
      // При собственном файле неактивный черновик просто игнорируется.
      let draft = null;

      if (isNew && payload.draftToken) {
        draft = resumeUpload
          ? await tryLockActiveDraft(tx, payload.draftToken)
          : await lockActiveDraft(tx, payload.draftToken);
      }

      if (isNew && !uploaded) {
        fail('Резюме обязательно.');
      }

      const values = [
        candidateId, lastName, firstName, middleName, vacancyId, phone, email,
        telegram.display, telegram.url, linkedin, github, source ? source.id : null, salary,
        recruiter.id, hrResponsible.id, techInterviewer.id, folderId, comment,
        JSON.stringify(links)
      ];

      const saved = isNew
        ? await tx.one(
            `INSERT INTO candidates
               (id, last_name, first_name, middle_name, vacancy_id, phone, email,
                telegram, telegram_url, linkedin, github, source_id, salary_expectation,
                recruiter_id, hr_responsible_id, tech_interviewer_id, drive_folder_id, comment,
                links, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'Новый')
             RETURNING *`,
            values
          )
        : await tx.one(
            `UPDATE candidates SET
               last_name = $2, first_name = $3, middle_name = $4, vacancy_id = $5, phone = $6,
               email = $7, telegram = $8, telegram_url = $9, linkedin = $10, github = $11,
               source_id = $12, salary_expectation = $13, recruiter_id = $14,
               hr_responsible_id = $15, tech_interviewer_id = $16,
               drive_folder_id = COALESCE($17, drive_folder_id),
               comment = $18, links = $19, updated_at = now()
             WHERE id = $1
             RETURNING *`,
            values
          );

      if (uploaded) {
        const resumeFile = await insertFile(tx, uploaded);

        await tx.query(
          'INSERT INTO candidate_resumes (candidate_id, file_id) VALUES ($1, $2)',
          [candidateId, resumeFile.id]
        );
      }

      if (isNew) {
        await appendTransitionLog(tx, {
          candidate: saved,
          fromStatus: '',
          toStatus: saved.status,
          responsible: recruiter,
          changedBy,
          comment: 'Кандидат создан'
        });
      }

      if (draft) {
        await markDraftUsed(tx, draft.id, candidateId);
      }

      return {
        ok: true,
        candidate: await loadCandidateDto(candidateId, tx)
      };
    });
  } catch (error) {
    await tracker.rollback();
    throw error;
  }
}

// ---------- Архивация ----------

export async function archiveCandidate(candidateId) {
  if (!isUuid(candidateId)) {
    fail('Кандидат не найден.', 404);
  }

  // Текущий статус сохраняется, кандидат лишь получает отметку архивации.
  await db.query(
    `UPDATE candidates SET archived_at = now(), updated_at = now()
     WHERE id = $1 AND archived_at IS NULL`,
    [candidateId]
  );

  const candidate = await loadCandidateDto(candidateId);

  if (!candidate) {
    fail('Кандидат не найден.', 404);
  }

  return { ok: true, candidate };
}

export async function getAllowedTransitions(candidateId) {
  const id = optionalUuid(candidateId, 'Кандидат не найден.');
  const row = id
    ? await db.one('SELECT status FROM candidates WHERE id = $1 AND archived_at IS NULL', [id])
    : null;

  return row ? APP_CONFIG.TRANSITIONS[row.status] || [] : [];
}

export { loadCandidateDto };
