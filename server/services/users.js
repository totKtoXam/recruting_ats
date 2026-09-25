import { APP_CONFIG, config } from '../config.js';
import { db, transaction } from '../db/pool.js';
import { AppError, fail } from '../lib/errors.js';
import { clean, optionalUuid, validateEmail } from '../lib/validation.js';
import { toPublicUser } from './mappers.js';

export const ACCESS_DENIED_MESSAGE =
  'Доступ для этого Google Account не выдан или отключён. Обратитесь к администратору ATS.';

const isAdminEmail = email => config.auth.adminEmails.includes(email);

function isAllowlisted(email) {
  const domain = email.split('@')[1] || '';

  return (
    config.auth.allowedEmails.includes(email) ||
    config.auth.allowedDomains.includes(domain)
  );
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
    const fullName = clean(identity.fullName) || (existing && existing.full_name) || email;
    const avatarUrl = clean(identity.avatarUrl);
    const admin = isAdminEmail(email);

    if (existing) {
      // Администратор из AUTH_ADMIN_EMAILS не может потерять доступ.
      const active = existing.is_active || admin;

      if (!active) {
        await tx.query('UPDATE users SET access_requested_at = now() WHERE id = $1', [existing.id]);
        return { ...existing, pendingApproval: true };
      }

      return tx.one(
        `UPDATE users
         SET google_subject = COALESCE($2, google_subject), email = $3,
             full_name = $4, avatar_url = $5, last_login_at = now(),
             is_active = true, is_admin = is_admin OR $6,
             access_granted_at = COALESCE(access_granted_at, now())
         WHERE id = $1 RETURNING *`,
        [existing.id, subject, email, fullName, avatarUrl, admin]
      );
    }

    const hasLists =
      config.auth.adminEmails.length > 0 ||
      config.auth.allowedEmails.length > 0 ||
      config.auth.allowedDomains.length > 0;
    const { count } = await tx.one('SELECT count(*)::int AS count FROM users');
    const firstUserBootstrap = !hasLists && count === 0;
    const allowed = admin || isAllowlisted(email) || firstUserBootstrap;

    const created = await tx.one(
      `INSERT INTO users
         (google_subject, email, full_name, avatar_url, is_active, is_admin,
          access_granted_at, access_requested_at, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6,
               CASE WHEN $5 THEN now() END, CASE WHEN $5 THEN NULL ELSE now() END,
               CASE WHEN $5 THEN now() END)
       RETURNING *`,
      [subject, email, fullName, avatarUrl, allowed, admin || firstUserBootstrap]
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

  return user && user.is_active ? user : null;
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

// Пользователи с доступом — для привязки к ответственным.
export async function getUsers() {
  const rows = await db.many('SELECT * FROM users WHERE is_active');

  return rows
    .map(toPublicUser)
    .sort((left, right) =>
      String(left['ФИО'] || left.Email).localeCompare(String(right['ФИО'] || right.Email), 'ru')
    );
}

export function requireAdmin(user) {
  if (!user || !user.is_admin) {
    fail('Недостаточно прав: раздел доступен только администраторам.', 403);
  }
}

// Добавление пользователя по email (до его первого входа) и выдача/отзыв доступа.
export async function saveUser(input = {}, actor) {
  requireAdmin(actor);

  const id = optionalUuid(input.id, 'Пользователь не найден.');
  const isActive = input.isActive === true;
  const isAdmin = input.isAdmin === true;

  if (isAdmin && !isActive) {
    fail('Администратор должен иметь доступ.');
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

      const created = await tx.one(
        `INSERT INTO users (email, full_name, is_active, is_admin, access_granted_at, access_granted_by)
         VALUES ($1, $2, $3, $4, CASE WHEN $3 THEN now() END, CASE WHEN $3 THEN $5::uuid END)
         RETURNING *`,
        [email, clean(input.fullName), isActive, isAdmin, actor.id]
      );

      return { ok: true, user: toPublicUser(created) };
    }

    const existing = await tx.one('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id]);

    if (!existing) {
      fail('Пользователь не найден.', 404);
    }

    if (existing.id === actor.id && (!isActive || !isAdmin)) {
      fail('Нельзя отключить доступ или права администратора самому себе.');
    }

    if (existing.is_admin && !isAdmin) {
      const { count } = await tx.one(
        'SELECT count(*)::int AS count FROM users WHERE is_admin AND id <> $1',
        [id]
      );

      if (count === 0) {
        fail('Нельзя снять права с последнего администратора.');
      }
    }

    const grantNow = isActive && !existing.is_active;

    const updated = await tx.one(
      `UPDATE users SET
         full_name = CASE WHEN google_subject IS NULL AND $2 <> '' THEN $2 ELSE full_name END,
         is_active = $3,
         is_admin = $4,
         access_granted_at = CASE WHEN $5 THEN now() ELSE access_granted_at END,
         access_granted_by = CASE WHEN $5 THEN $6::uuid ELSE access_granted_by END
       WHERE id = $1 RETURNING *`,
      [id, clean(input.fullName), isActive, isAdmin, grantNow, actor.id]
    );

    return { ok: true, user: toPublicUser(updated) };
  });
}

export { toPublicUser };
