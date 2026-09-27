// Жизненный цикл записей: активная → архив → корзина → окончательное удаление.
//   - Архивировать и вернуть из архива может любой пользователь с доступом.
//   - Удалить можно только архивную запись; удаление и восстановление — только администраторы.
//   - Удалённое хранится в корзине 30 дней, затем удаляется из БД полностью (не soft delete).
import { APP_CONFIG } from '../config.js';
import { transaction } from '../db/pool.js';
import { trashFile } from '../lib/drive.js';
import { fail } from '../lib/errors.js';
import { isUuid } from '../lib/validation.js';
import { notifyCandidateEvent, purgeOldNotifications } from './notifications.js';
import { purgeAudit, recordEvent } from './audit.js';
import { requireAdmin } from './users.js';

// Изменения жизненного цикла кандидата и его результатов интервью — это «изменения в карточке».
const LIFECYCLE_TEXT = {
  candidate: {
    archive: 'Кандидат отправлен в архив.',
    unarchive: 'Кандидат возвращён из архива.',
    delete: 'Кандидат удалён в корзину.',
    restore: 'Кандидат восстановлен из корзины (в архив).'
  },
  interview: {
    archive: 'Результат интервью отправлен в архив.',
    unarchive: 'Результат интервью возвращён из архива.',
    delete: 'Результат интервью удалён в корзину.',
    restore: 'Результат интервью восстановлен из корзины.'
  }
};

function notifyLifecycle(tx, type, row, action, actor) {
  const text = LIFECYCLE_TEXT[type] && LIFECYCLE_TEXT[type][action];
  if (!text) return null;
  const candidateId = type === 'candidate' ? row.id : row.candidate_id;
  return notifyCandidateEvent(tx, candidateId, actor, { type: 'changed', text });
}

export const RETENTION_DAYS = APP_CONFIG.TRASH_RETENTION_DAYS;

async function assertNotLastAdmin(tx, userId) {
  const { count } = await tx.one(
    'SELECT count(*)::int AS count FROM users WHERE is_admin AND is_active AND id <> $1',
    [userId]
  );
  if (count === 0) {
    fail('Нельзя архивировать последнего администратора.');
  }
}

const ENTITIES = {
  candidate: { table: 'candidates', label: 'Кандидат' },
  vacancy: {
    table: 'vacancies',
    label: 'Вакансия',
    async beforeDelete(tx, row) {
      const { count } = await tx.one(
        'SELECT count(*)::int AS count FROM candidates WHERE vacancy_id = $1',
        [row.id]
      );
      if (count) {
        fail(`На вакансию ссылаются кандидаты (${count}). Сначала удалите их или перенесите на другую вакансию.`);
      }
    }
  },
  source: { table: 'sources', label: 'Источник' },
  template: { table: 'interview_templates', label: 'Шаблон' },
  interview: { table: 'interviews', label: 'Результат интервью' },
  user: {
    table: 'users',
    label: 'Пользователь',
    adminOnly: true,
    async beforeArchive(tx, row, actor) {
      if (row.id === actor.id) {
        fail('Нельзя архивировать самого себя.');
      }
      if (row.is_admin) {
        await assertNotLastAdmin(tx, row.id);
      }
    },
    // Архивный пользователь не может войти и не остаётся администратором.
    archiveSet: ', is_active = false, is_admin = false',
    async beforeDelete(tx, row) {
      const { count } = await tx.one(
        `SELECT count(*)::int AS count FROM candidates
         WHERE $1 IN (recruiter_id, hr_responsible_id, tech_interviewer_id)`,
        [row.id]
      );
      if (count) {
        fail(`Пользователь назначен ответственным у кандидатов (${count}). Сначала переназначьте их.`);
      }
    }
  }
};

function entityFor(type) {
  const entity = ENTITIES[type];
  if (!entity) {
    fail('Неизвестный тип записи.');
  }
  return entity;
}

async function lockRow(tx, entity, id) {
  const row = isUuid(id)
    ? await tx.one(`SELECT * FROM ${entity.table} WHERE id = $1 FOR UPDATE`, [id])
    : null;
  if (!row) {
    fail(`${entity.label}: запись не найдена.`, 404);
  }
  return row;
}

export async function archive({ type, id } = {}, actor) {
  const entity = entityFor(type);
  if (entity.adminOnly) requireAdmin(actor);

  return transaction(async tx => {
    const row = await lockRow(tx, entity, id);
    if (row.deleted_at) fail(`${entity.label} в корзине.`);
    if (row.archived_at) return { ok: true };
    if (entity.beforeArchive) await entity.beforeArchive(tx, row, actor);

    await tx.query(
      `UPDATE ${entity.table} SET archived_at = now()${entity.archiveSet || ''} WHERE id = $1`,
      [row.id]
    );
    await notifyLifecycle(tx, type, row, 'archive', actor);
    await recordEvent(tx, { entityType: type, entityId: row.id, action: 'archive', actor });
    return { ok: true };
  });
}

export async function unarchive({ type, id } = {}, actor) {
  const entity = entityFor(type);
  if (entity.adminOnly) requireAdmin(actor);

  return transaction(async tx => {
    const row = await lockRow(tx, entity, id);
    if (row.deleted_at) fail('Сначала восстановите запись из корзины.');
    // Возвращённый из архива пользователь остаётся без доступа — его открывают отдельно.
    if (!row.archived_at) return { ok: true };
    await tx.query(`UPDATE ${entity.table} SET archived_at = NULL WHERE id = $1`, [row.id]);
    await notifyLifecycle(tx, type, row, 'unarchive', actor);
    await recordEvent(tx, { entityType: type, entityId: row.id, action: 'unarchive', actor });
    return { ok: true };
  });
}

export async function moveToTrash({ type, id } = {}, actor) {
  const entity = entityFor(type);
  requireAdmin(actor);

  return transaction(async tx => {
    const row = await lockRow(tx, entity, id);
    if (row.deleted_at) return { ok: true };
    if (!row.archived_at) fail('Удалить можно только архивную запись. Сначала отправьте её в архив.');
    if (entity.beforeDelete) await entity.beforeDelete(tx, row, actor);

    await tx.query(`UPDATE ${entity.table} SET deleted_at = now() WHERE id = $1`, [row.id]);
    await notifyLifecycle(tx, type, row, 'delete', actor);
    await recordEvent(tx, { entityType: type, entityId: row.id, action: 'delete', actor });
    return { ok: true, purgeAfterDays: RETENTION_DAYS };
  });
}

export async function restoreFromTrash({ type, id } = {}, actor) {
  const entity = entityFor(type);
  requireAdmin(actor);

  return transaction(async tx => {
    const row = await lockRow(tx, entity, id);
    // Восстановленная запись возвращается в архив.
    if (!row.deleted_at) return { ok: true };
    await tx.query(`UPDATE ${entity.table} SET deleted_at = NULL WHERE id = $1`, [row.id]);
    await notifyLifecycle(tx, type, row, 'restore', actor);
    await recordEvent(tx, { entityType: type, entityId: row.id, action: 'restore', actor });
    return { ok: true };
  });
}

// ---------- Окончательное удаление из корзины ----------

async function purgeTable(tx, entityType, table, extraWhere = '') {
  const rows = await tx.many(
    `DELETE FROM ${table}
     WHERE deleted_at < now() - make_interval(days => $1) ${extraWhere}
     RETURNING id`,
    [RETENTION_DAYS]
  );
  if (rows.length) {
    await tx.query('DELETE FROM comments WHERE entity_type = $1 AND entity_id = ANY($2)', [
      entityType,
      rows.map(row => row.id)
    ]);
    await purgeAudit(tx, entityType, rows.map(row => row.id));
  }
  return rows.length;
}

export async function purgeExpired() {
  const driveIds = [];

  const removed = await transaction(async tx => {
    // Журнал переходов удаляется только вместе с кандидатом.
    await tx.query("SET LOCAL ats.purge = 'on'");

    const expiredCandidates = await tx.many(
      `SELECT id, drive_folder_id FROM candidates
       WHERE deleted_at < now() - make_interval(days => $1)`,
      [RETENTION_DAYS]
    );
    const candidateIds = expiredCandidates.map(row => row.id);
    driveIds.push(...expiredCandidates.map(row => row.drive_folder_id).filter(Boolean));

    const counts = {};

    if (candidateIds.length) {
      await tx.query(
        `DELETE FROM comments WHERE entity_type = 'interview'
         AND entity_id IN (SELECT id FROM interviews WHERE candidate_id = ANY($1))`,
        [candidateIds]
      );
      await tx.query(
        `DELETE FROM audit_log WHERE entity_type = 'interview'
         AND entity_id IN (SELECT id FROM interviews WHERE candidate_id = ANY($1))`,
        [candidateIds]
      );
      const files = await tx.many(
        'SELECT file_id FROM candidate_resumes WHERE candidate_id = ANY($1)',
        [candidateIds]
      );
      counts.candidates = await purgeTable(tx, 'candidate', 'candidates');
      // Файлы резюме удалённых кандидатов больше ни на что не ссылаются.
      await tx.query(
        `DELETE FROM files f WHERE f.id = ANY($1)
         AND NOT EXISTS (SELECT 1 FROM candidate_resumes cr WHERE cr.file_id = f.id)
         AND NOT EXISTS (SELECT 1 FROM candidate_drafts d WHERE d.resume_file_id = f.id)`,
        [files.map(row => row.file_id)]
      );
    }

    counts.interviews = await purgeTable(tx, 'interview', 'interviews');
    counts.templates = await purgeTable(tx, 'template', 'interview_templates');
    // Вакансии и пользователи, на которых ещё ссылаются кандидаты, ждут их удаления.
    counts.vacancies = await purgeTable(
      tx,
      'vacancy',
      'vacancies',
      'AND NOT EXISTS (SELECT 1 FROM candidates c WHERE c.vacancy_id = vacancies.id)'
    );
    counts.sources = await purgeTable(tx, 'source', 'sources');
    counts.users = await purgeTable(
      tx,
      'user',
      'users',
      `AND NOT EXISTS (SELECT 1 FROM candidates c
         WHERE users.id IN (c.recruiter_id, c.hr_responsible_id, c.tech_interviewer_id))`
    );

    return counts;
  });

  // Папки кандидатов в Drive — в корзину Drive (после фиксации транзакции).
  for (const folderId of driveIds) {
    await trashFile(folderId).catch(() => {});
  }

  return { ok: true, removed };
}

const PURGE_INTERVAL_MS = 12 * 60 * 60 * 1000;
let lastPurgeAt = 0;
let purgeInProgress = false;

// Запускается при открытии приложения, не чаще раза в 12 часов (без таймеров,
// которые на serverless-хостингах не получают CPU).
export function purgeIfDue() {
  if (purgeInProgress || Date.now() - lastPurgeAt < PURGE_INTERVAL_MS) {
    return;
  }

  lastPurgeAt = Date.now();
  purgeInProgress = true;

  purgeExpired()
    .then(({ removed }) => {
      const total = Object.values(removed).reduce((sum, count) => sum + count, 0);
      if (total) console.log('Purge: removed', removed);
      return purgeOldNotifications();
    })
    .then(count => {
      if (count) console.log('Purge: old notifications removed:', count);
    })
    .catch(error => console.error('Purge failed:', error.message))
    .finally(() => {
      purgeInProgress = false;
    });
}
