import { APP_CONFIG, config } from '../config.js';
import { db, transaction } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { clean } from '../lib/validation.js';
import { toPublicUser } from './mappers.js';

export const ACCESS_DENIED_MESSAGE =
  'Доступ для этого Google Account не выдан или отключён. Обратитесь к администратору ATS.';

function isAllowlisted(email) {
  const domain = email.split('@')[1] || '';

  return (
    config.auth.allowedEmails.includes(email) ||
    config.auth.allowedDomains.includes(domain)
  );
}

// Находит или создаёт пользователя по Google-идентичности (sub + email).
// Новые пользователи получают доступ, только если email/домен в allowlist.
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

    if (existing && !existing.is_active) {
      throw new AppError(ACCESS_DENIED_MESSAGE, 403);
    }

    if (existing) {
      return tx.one(
        `UPDATE users
         SET google_subject = COALESCE($2, google_subject), email = $3,
             full_name = $4, avatar_url = $5, last_login_at = now()
         WHERE id = $1 RETURNING *`,
        [existing.id, subject, email, clean(identity.fullName) || email, clean(identity.avatarUrl)]
      );
    }

    // Если allowlist задан, он действует всегда. Без allowlist (разрешено только вне production)
    // доступ получает лишь самый первый пользователь — для локального bootstrap.
    const hasAllowlist = config.auth.allowedEmails.length > 0 || config.auth.allowedDomains.length > 0;
    const { count } = await tx.one('SELECT count(*)::int AS count FROM users');
    const allowed = hasAllowlist ? isAllowlisted(email) : count === 0;

    const created = await tx.one(
      `INSERT INTO users (google_subject, email, full_name, avatar_url, is_active, last_login_at)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING *`,
      [subject, email, clean(identity.fullName) || email, clean(identity.avatarUrl), allowed]
    );

    if (!allowed) {
      // Запись сохраняется (is_active = false), чтобы администратор мог выдать доступ.
      return { ...created, pendingApproval: true };
    }

    return created;
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

export async function getUsers() {
  const rows = await db.many('SELECT * FROM users');

  return rows
    .map(toPublicUser)
    .sort((left, right) =>
      String(left['ФИО'] || left.Email).localeCompare(String(right['ФИО'] || right.Email), 'ru')
    );
}

export { toPublicUser };
