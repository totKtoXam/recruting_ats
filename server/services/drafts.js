import { randomBytes } from 'node:crypto';
import { APP_CONFIG, config } from '../config.js';
import { db, transaction } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import { trashFile } from '../lib/drive.js';
import { clean, normalizeNamePart } from '../lib/validation.js';
import { UploadTracker, decodeResumeUpload, insertFile, uploadDraftResume } from './files.js';
import { fileUrl } from './mappers.js';

function draftData(input) {
  return {
    lastName: normalizeNamePart(input.lastName),
    firstName: normalizeNamePart(input.firstName),
    middleName: normalizeNamePart(input.middleName),
    phone: clean(input.phone),
    email: clean(input.email).toLowerCase(),
    telegram: clean(input.telegram),
    github: clean(input.github),
    linkedin: clean(input.linkedin),
    salary: clean(input.salary),
    vacancyId: clean(input.vacancyId),
    sourceId: clean(input.sourceId),
    responsibleId: clean(input.responsibleId),
    comment: clean(input.comment),
    links: Array.isArray(input.links)
      ? input.links.map(link => ({ name: clean(link && link.name), url: clean(link && link.url) }))
      : []
  };
}

export async function createCandidateDraft(input = {}) {
  const token = randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + APP_CONFIG.DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000);
  const upload = input.resume && input.resume.base64 ? decodeResumeUpload(input.resume) : null;
  const tracker = new UploadTracker();

  try {
    const uploaded = upload ? await uploadDraftResume(tracker, token, upload) : null;

    const { resumeFile } = await transaction(async tx => {
      const file = uploaded ? await insertFile(tx, uploaded) : null;

      await tx.query(
        `INSERT INTO candidate_drafts (token, data, resume_file_id, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [token, JSON.stringify(draftData(input)), file ? file.id : null, expiresAt]
      );

      return { resumeFile: file };
    });

    const draftUrl = `${config.publicUrl}/?draft=${encodeURIComponent(token)}`;

    return {
      ok: true,
      draftToken: token,
      draftUrl,
      webAppUrl: config.publicUrl,
      expiresAt: expiresAt.toISOString(),
      resume: resumeFile
        ? { id: resumeFile.id, name: resumeFile.original_name, url: config.publicUrl + fileUrl(resumeFile.id) }
        : null
    };
  } catch (error) {
    await tracker.rollback();
    throw error;
  }
}

function assertActive(draft) {
  if (!draft) {
    fail('Черновик кандидата не найден.', 404);
  }

  if (draft.used_at) {
    fail('Черновик уже использован.');
  }

  if (new Date(draft.expires_at).getTime() < Date.now()) {
    fail('Срок действия черновика истёк.');
  }

  return draft;
}

export async function getCandidateDraft(token) {
  const cleanToken = clean(token);

  if (!cleanToken) {
    fail('Не указан token черновика.');
  }

  const draft = assertActive(
    await db.one(
      `SELECT d.*, f.original_name AS resume_name
       FROM candidate_drafts d
       LEFT JOIN files f ON f.id = d.resume_file_id
       WHERE d.token = $1`,
      [cleanToken]
    )
  );

  return {
    token: draft.token,
    data: draft.data || {},
    resume: draft.resume_file_id
      ? {
          id: draft.resume_file_id,
          name: draft.resume_name || 'Резюме',
          url: fileUrl(draft.resume_file_id)
        }
      : null,
    expiresAt: new Date(draft.expires_at).toISOString()
  };
}

// Блокирует активный черновик в рамках транзакции создания кандидата.
export async function lockActiveDraft(tx, token) {
  return assertActive(
    await tx.one('SELECT * FROM candidate_drafts WHERE token = $1 FOR UPDATE', [clean(token)])
  );
}

// То же, но неактивный или отсутствующий черновик не считается ошибкой.
export async function tryLockActiveDraft(tx, token) {
  const draft = await tx.one(
    `SELECT * FROM candidate_drafts
     WHERE token = $1 AND used_at IS NULL AND expires_at > now()
     FOR UPDATE`,
    [clean(token)]
  );
  return draft || null;
}

export async function markDraftUsed(tx, draftId, candidateId) {
  await tx.query(
    'UPDATE candidate_drafts SET used_at = now(), candidate_id = $2 WHERE id = $1',
    [draftId, candidateId]
  );
}

const CLEANUP_INTERVAL_MS = 12 * 60 * 60 * 1000;
let lastCleanupAt = 0;
let cleanupInProgress = false;

// Запускает очистку в фоне, если с прошлого запуска прошло больше 12 часов.
// Вызывается из обычных запросов, а не по таймеру: на Cloud Run и других
// serverless-хостингах процесс между запросами почти не получает CPU.
export function cleanupDraftsIfDue() {
  if (cleanupInProgress || Date.now() - lastCleanupAt < CLEANUP_INTERVAL_MS) {
    return;
  }

  lastCleanupAt = Date.now();
  cleanupInProgress = true;

  cleanupExpiredCandidateDrafts()
    .then(({ removed }) => removed && console.log(`Draft cleanup: removed ${removed}`))
    .catch(error => console.error('Draft cleanup failed:', error.message))
    .finally(() => {
      cleanupInProgress = false;
    });
}

// Удаляет использованные и просроченные черновики, их файлы переносит в корзину Google Drive.
export async function cleanupExpiredCandidateDrafts() {
  const drafts = await db.many(
    `SELECT d.id, d.resume_file_id, f.drive_file_id
     FROM candidate_drafts d
     LEFT JOIN files f ON f.id = d.resume_file_id
     WHERE d.used_at IS NOT NULL OR d.expires_at < now()`
  );

  for (const draft of drafts) {
    await transaction(async tx => {
      await tx.query('DELETE FROM candidate_drafts WHERE id = $1', [draft.id]);

      if (draft.resume_file_id) {
        await tx.query('DELETE FROM files WHERE id = $1', [draft.resume_file_id]);
      }
    });

    if (draft.drive_file_id) {
      await trashFile(draft.drive_file_id).catch(() => {});
    }
  }

  return { ok: true, removed: drafts.length };
}
