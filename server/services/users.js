import { APP_CONFIG, config } from '../config.js';
import { db, transaction } from '../db/pool.js';
import { AppError, fail } from '../lib/errors.js';
import {
  clean,
  composeFullName,
  normalizeNamePart,
  normalizeTelegramUsername,
  optionalUuid,
  splitFullName,
  validateEmail
} from '../lib/validation.js';
import { toPublicUser, toResponsible } from './mappers.js';
import { runtime } from './settings.js';
import { recordChanges, recordEvent } from './audit.js';
import { normalizeScopes } from '../lib/scopes.js';

export const ACCESS_DENIED_MESSAGE =
  'Доступ для этого Google Account не выдан или отключён. Обратитесь к администратору ATS.';

const isAdminEmail = email => config.auth.adminEmails.includes(email);

// Правила автоматического доступа меняются в «Настройки → Интеграции» без перезапуска.

function isAllowlisted(email) {
  const domain = email.split('@')[1] || '';

  return (
    runtime.auth().allowedEmails.includes(email) ||
    runtime.auth().allowedDomains.includes(domain)
  );
}

// ФИО из Google: family_name / given_name, иначе — разбор полного имени.
function namesFromIdentity(identity, fallbackEmail) {
  const lastName = normalizeNamePart(identity.familyName);
  const firstName = normalizeNamePart(identity.givenName);

  if (lastName || firstName) {
    return { lastName, firstName, middleName: '' };
  }

  const full = clean(identity.fullName);
  if (!full || full === fallbackEmail) {
    return { lastName: '', firstName: '', middleName: '' };
  }

  // В Google полное имя обычно «Имя Фамилия».
  const parts = splitFullName(full);
  return parts.middleName
    ? parts
    : { lastName: parts.firstName, firstName: parts.lastName, middleName: '' };
}

// Находит или создаёт пользователя по Google-идентичности (sub + email).
// Войти может любой Google Account, но доступ получают только:
//   - пользователи, которым администратор открыл доступ в «Настройки → Пользователи»;
//   - AUTH_ADMIN_EMAILS — всегда, с правами администратора (bootstrap);
//   - AUTH_ALLOWED_EMAILS / AUTH_ALLOWED_DOMAINS — автоматически, без прав администратора;
//   - без каких-либо списков (только вне production) — самый первый пользователь.
// Остальные сохраняются со статусом «Ожидает доступа».
export async function upsertUserOnLogin(identity) {
  const email = clean(identity.email).toLowerCase();
  const subject = clean(identity.subject) || null;

  if (!email) {
    throw new AppError('Не удалось определить email Google Account.', 401);
  }

  return transaction(async tx => {
    // Сериализует одновременные первые входы.
    await tx.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');

    const matches = await tx.many(
      `SELECT * FROM users
       WHERE ($1::text IS NOT NULL AND google_subject = $1) OR lower(email) = $2`,
      [subject, email]
    );

    const bySubject = matches.find(user => subject && user.google_subject === subject);
    const existing = bySubject || matches[0] || null;
    const names = namesFromIdentity(identity, email);
    const avatarUrl = clean(identity.avatarUrl);
    const admin = isAdminEmail(email);

    if (existing) {
      // Администратор из AUTH_ADMIN_EMAILS не может потерять доступ (даже из архива).
      const active = (existing.is_active && !existing.archived_at && !existing.deleted_at) || admin;

      if (!active) {
        await tx.query('UPDATE users SET access_requested_at = now() WHERE id = $1', [existing.id]);
        return { ...existing, pendingApproval: true };
      }

      // ФИО, заданное администратором, не перезаписывается данными Google.
      const keepNames = existing.last_name || existing.first_name;

      return tx.one(
        `UPDATE users SET
           google_subject = COALESCE($2, google_subject), email = $3,
           last_name = CASE WHEN $9 THEN last_name ELSE $4 END,
           first_name = CASE WHEN $9 THEN first_name ELSE $5 END,
           middle_name = CASE WHEN $9 THEN middle_name ELSE $6 END,
           full_name = CASE WHEN $9 THEN full_name ELSE $10 END,
           avatar_url = $7, last_login_at = now(),
           is_active = true, is_admin = is_admin OR $8,
           archived_at = CASE WHEN $8 THEN NULL ELSE archived_at END,
           deleted_at = CASE WHEN $8 THEN NULL ELSE deleted_at END,
           access_granted_at = COALESCE(access_granted_at, now())
         WHERE id = $1 RETURNING *`,
        [
          existing.id, subject, email,
          names.lastName, names.firstName, names.middleName,
          avatarUrl, admin, Boolean(keepNames),
          composeFullName(names.lastName, names.firstName, names.middleName) || email
        ]
      );
    }

    const hasLists =
      config.auth.adminEmails.length > 0 ||
      runtime.auth().allowedEmails.length > 0 ||
      runtime.auth().allowedDomains.length > 0;
    const { count } = await tx.one('SELECT count(*)::int AS count FROM users');
    const firstUserBootstrap = !hasLists && count === 0;
    const allowed = admin || isAllowlisted(email) || firstUserBootstrap;

    const created = await tx.one(
      `INSERT INTO users
         (google_subject, email, full_name, last_name, first_name, middle_name, avatar_url,
          is_active, is_admin, access_granted_at, access_requested_at, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               CASE WHEN $8 THEN now() END, CASE WHEN $8 THEN NULL ELSE now() END,
               CASE WHEN $8 THEN now() END)
       RETURNING *`,
      [
        subject, email,
        composeFullName(names.lastName, names.firstName, names.middleName) || email,
        names.lastName, names.firstName, names.middleName, avatarUrl,
        allowed, admin || firstUserBootstrap
      ]
    );

    // Запись без доступа сохраняется, чтобы администратор увидел запрос и открыл доступ.
    return allowed ? created : { ...created, pendingApproval: true };
  });
}

export async function getActiveUser(userId) {
  if (!userId) {
    return null;
  }

  const user = await db.one('SELECT * FROM users WHERE id = $1', [userId]);

  return user && user.is_active && !user.archived_at && !user.deleted_at ? user : null;
}

// "Последний вход" обновляется не чаще раза в 30 минут.
export async function touchLastLogin(userId) {
  await db.query(
    `UPDATE users SET last_login_at = now()
     WHERE id = $1
       AND (last_login_at IS NULL OR last_login_at < now() - make_interval(mins => $2))`,
    [userId, APP_CONFIG.LAST_LOGIN_THROTTLE_MINUTES]
  );
}

// Пользователи с доступом — для привязок и упоминаний.
export async function getUsers() {
  const rows = await db.many(
    'SELECT * FROM users WHERE is_active AND archived_at IS NULL AND deleted_at IS NULL'
  );

  return rows
    .map(toPublicUser)
    .sort((left, right) =>
      String(left['ФИО'] || left.Email).localeCompare(String(right['ФИО'] || right.Email), 'ru')
    );
}

// Ответственные — пользователи с хотя бы одним этапом (доступ в ATS им не обязателен).
export async function getResponsibles() {
  const rows = await db.many(
    `SELECT * FROM users
     WHERE cardinality(stages) > 0 AND archived_at IS NULL AND deleted_at IS NULL
     ORDER BY last_name, first_name`
  );
  return rows.map(toResponsible);
}

export function requireAdmin(user) {
  if (!user || !user.is_admin) {
    fail('Недостаточно прав: действие доступно только администраторам.', 403);
  }
}

function normalizeStages(stages) {
  const list = Array.isArray(stages) ? [...new Set(stages.map(clean).filter(Boolean))] : [];
  const invalid = list.filter(stage => !APP_CONFIG.PIPELINE_STATUSES.includes(stage));

  if (invalid.length) {
    fail('Некорректные этапы: ' + invalid.join(', '));
  }

  // Порядок как в воронке.
  return APP_CONFIG.PIPELINE_STATUSES.filter(stage => list.includes(stage));
}

// Карточка пользователя: ФИО, email, этапы ответственного, права администратора.
// Доступ в ATS переключается отдельно (setUserAccess) — переключателем в списке.
export async function saveUser(input = {}, actor) {
  requireAdmin(actor);

  const id = optionalUuid(input.id, 'Пользователь не найден.');
  const lastName = normalizeNamePart(input.lastName);
  const firstName = normalizeNamePart(input.firstName);
  const middleName = normalizeNamePart(input.middleName);
  const stages = normalizeStages(input.stages);
  const isAdmin = input.isAdmin === true;
  // Доступ к данным по scope (ЗП ожидания); не передан — не меняется.
  const scopes = input.scopes === undefined ? undefined : normalizeScopes(input.scopes);
  // Ник, указанный администратором, — не подтверждён; подтверждение — привязкой через бота.
  const telegram = input.telegram === undefined ? undefined : normalizeTelegramUsername(input.telegram);

  if (!lastName || !firstName) {
    fail('Фамилия и имя обязательны.');
  }

  return transaction(async tx => {
    if (!id) {
      const email = validateEmail(input.email);

      if (!email) {
        fail('Укажите email Google Account.');
      }

      const duplicate = await tx.one('SELECT id FROM users WHERE lower(email) = $1', [email]);

      if (duplicate) {
        fail('Пользователь с таким email уже есть в списке.', 409);
      }

      // Новый пользователь сразу получает доступ, если выбран «Открыть доступ» или он администратор.
      const isActive = input.isActive === true || isAdmin;

      const created = await tx.one(
        `INSERT INTO users
           (email, full_name, last_name, first_name, middle_name, stages,
            is_active, is_admin, access_granted_at, access_granted_by, telegram_username, scopes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 CASE WHEN $7 THEN now() END, CASE WHEN $7 THEN $9::uuid END, $10, $11)
         RETURNING *`,
        [
          email, composeFullName(lastName, firstName, middleName), lastName, firstName,
          middleName, stages, isActive, isAdmin, actor.id, telegram || '', scopes || []
        ]
      );

      await recordEvent(tx, {
        entityType: 'user', entityId: created.id, action: 'create',
        newDisplay: created.email, actor
      });

      return { ok: true, user: toPublicUser(created) };
    }

    const existing = await tx.one('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id]);

    if (!existing) {
      fail('Пользователь не найден.', 404);
    }

    if (existing.id === actor.id && !isAdmin) {
      fail('Нельзя снять права администратора с самого себя.');
    }

    if (existing.is_admin && !isAdmin) {
      await assertAnotherAdmin(tx, id);
    }

    // Email можно поправить, пока человек ни разу не входил (например, временный адрес).
    let email = existing.email;
    if (!existing.google_subject && clean(input.email)) {
      email = validateEmail(input.email);
      const duplicate = await tx.one(
        'SELECT id FROM users WHERE lower(email) = $1 AND id <> $2',
        [email, id]
      );
      if (duplicate) {
        fail('Пользователь с таким email уже есть в списке.', 409);
      }
    }

    // Права администратора подразумевают доступ.
    const grantAccess = isAdmin && !existing.is_active;

    // Новый ник снимает подтверждение: привязанный чат принадлежит прежнему аккаунту.
    const telegramChanged =
      telegram !== undefined && telegram.toLowerCase() !== (existing.telegram_username || '').toLowerCase();

    const updated = await tx.one(
      `UPDATE users SET
         email = $2, last_name = $3, first_name = $4, middle_name = $5, full_name = $6,
         stages = $7, is_admin = $8,
         is_active = is_active OR $9,
         access_granted_at = CASE WHEN $9 THEN now() ELSE access_granted_at END,
         access_granted_by = CASE WHEN $9 THEN $10::uuid ELSE access_granted_by END,
         telegram_username = CASE WHEN $11 THEN $12 ELSE telegram_username END,
         telegram_chat_id = CASE WHEN $11 THEN NULL ELSE telegram_chat_id END,
         telegram_verified_at = CASE WHEN $11 THEN NULL ELSE telegram_verified_at END,
         scopes = COALESCE($13::text[], scopes)
       WHERE id = $1 RETURNING *`,
      [
        id, email, lastName, firstName, middleName,
        composeFullName(lastName, firstName, middleName), stages, isAdmin,
        grantAccess, actor.id, telegramChanged, telegram || '', scopes ?? null
      ]
    );

    await recordChanges(tx, 'user', existing, updated, actor);
    if (grantAccess) {
      await recordEvent(tx, {
        entityType: 'user', entityId: id, action: 'status', field: 'access', fieldLabel: 'Доступ в ATS',
        oldDisplay: accessLabel(existing), newDisplay: accessLabel(updated), actor
      });
    }

    return { ok: true, user: toPublicUser(updated) };
  });
}

// Статус доступа для журнала изменений.
function accessLabel(row) {
  if (row.is_active) return 'Открыт';
  return row.access_granted_at ? 'Закрыт' : 'Ожидает';
}

async function assertAnotherAdmin(tx, userId) {
  const { count } = await tx.one(
    'SELECT count(*)::int AS count FROM users WHERE is_admin AND is_active AND id <> $1',
    [userId]
  );

  if (count === 0) {
    fail('Нельзя снять права с последнего администратора.');
  }
}

// Переключатель «Доступ в ATS» в списке пользователей.
export async function setUserAccess(input = {}, actor) {
  requireAdmin(actor);

  const id = optionalUuid(input.id, 'Пользователь не найден.');
  const isActive = input.isActive === true;

  return transaction(async tx => {
    const existing = id ? await tx.one('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id]) : null;

    if (!existing) {
      fail('Пользователь не найден.', 404);
    }

    if (existing.archived_at || existing.deleted_at) {
      fail('Сначала верните пользователя из архива.');
    }

    if (existing.id === actor.id && !isActive) {
      fail('Нельзя закрыть доступ самому себе.');
    }

    if (existing.is_admin && !isActive) {
      await assertAnotherAdmin(tx, id);
    }

    const grantNow = isActive && !existing.is_active;

    const updated = await tx.one(
      `UPDATE users SET
         is_active = $2,
         is_admin = is_admin AND $2,
         access_granted_at = CASE WHEN $3 THEN now() ELSE access_granted_at END,
         access_granted_by = CASE WHEN $3 THEN $4::uuid ELSE access_granted_by END
       WHERE id = $1 RETURNING *`,
      [id, isActive, grantNow, actor.id]
    );

    if (existing.is_active !== updated.is_active) {
      await recordEvent(tx, {
        entityType: 'user', entityId: id, action: 'status', field: 'access', fieldLabel: 'Доступ в ATS',
        oldDisplay: accessLabel(existing), newDisplay: accessLabel(updated), actor
      });
    }

    return { ok: true, user: toPublicUser(updated) };
  });
}

export { toPublicUser };
