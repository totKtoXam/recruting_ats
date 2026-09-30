// OAuth 2.1 для MCP-клиентов (Claude Code, Claude Desktop и др.): регистрация клиента,
// коды авторизации с PKCE, выдача и ротация токенов, проверка Bearer-токена, отзыв.
// Токены — случайные строки; в БД хранится только их SHA-256.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { db, transaction } from '../db/pool.js';
import { formatDateTime } from '../lib/dates.js';
import { AppError, fail } from '../lib/errors.js';
import { clean, isUuid } from '../lib/validation.js';
import { getActiveUser } from './users.js';

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_DAYS = 90;
const CODE_TTL_MINUTES = 10;
const MAX_REDIRECT_URIS = 10;

// Ошибка протокола OAuth: { error, error_description } и HTTP-статус (RFC 6749, 5.2).
export class OAuthError extends Error {
  constructor(error, description, status = 400) {
    super(description);
    this.name = 'OAuthError';
    this.error = error;
    this.status = status;
  }
}

const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
const newToken = prefix => prefix + randomBytes(32).toString('base64url');

// Разрешены https и loopback-адреса (нативные клиенты поднимают локальный порт, RFC 8252).
export function isAllowedRedirectUri(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.hash) return false;
  if (url.protocol === 'https:') return true;

  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

// Loopback-адрес сравнивается без порта: клиент может получить другой свободный порт (RFC 8252, 7.3).
function redirectMatches(registered, requested) {
  if (registered === requested) return true;

  try {
    const a = new URL(registered);
    const b = new URL(requested);

    return (
      a.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(a.hostname) &&
      a.hostname === b.hostname &&
      a.protocol === b.protocol &&
      a.pathname === b.pathname &&
      a.search === b.search
    );
  } catch {
    return false;
  }
}

// ---------- Клиенты ----------

export async function registerClient(input) {
  const body = input && typeof input === 'object' ? input : {};
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];

  if (!uris.length || uris.length > MAX_REDIRECT_URIS || !uris.every(isAllowedRedirectUri)) {
    throw new OAuthError(
      'invalid_redirect_uri',
      'redirect_uris: от 1 до 10 адресов, только https:// или http://localhost.'
    );
  }

  const method = body.token_endpoint_auth_method || 'none';
  if (method !== 'none') {
    throw new OAuthError('invalid_client_metadata', 'Поддерживаются только публичные клиенты (token_endpoint_auth_method=none).');
  }

  const id = 'mcp_' + randomBytes(16).toString('hex');
  const name = clean(body.client_name).slice(0, 120);

  await db.query('INSERT INTO oauth_clients (id, name, redirect_uris) VALUES ($1, $2, $3)', [id, name, uris]);

  return {
    client_id: id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name || undefined,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  };
}

export async function getClient(clientId) {
  const id = clean(clientId);
  return id ? db.one('SELECT * FROM oauth_clients WHERE id = $1', [id]) : null;
}

// Проверяет параметры запроса авторизации. Ошибки клиента/redirect_uri показываются
// пользователю (редиректить на непроверенный адрес нельзя), остальные — возвращаются клиенту.
export async function validateAuthorizeRequest(params) {
  const client = await getClient(params.client_id);

  if (!client) {
    throw new AppError('Неизвестное приложение (client_id). Переподключите его в клиенте MCP.', 400);
  }

  const redirectUri = clean(params.redirect_uri);
  if (!redirectUri || !client.redirect_uris.some(uri => redirectMatches(uri, redirectUri))) {
    throw new AppError('Адрес возврата (redirect_uri) не зарегистрирован для этого приложения.', 400);
  }

  const redirectError = (error, description) => ({ redirectUri, error, description });

  if (params.response_type !== 'code') {
    return { client, redirectUri, problem: redirectError('unsupported_response_type', 'Поддерживается только response_type=code.') };
  }

  if (!params.code_challenge || params.code_challenge_method !== 'S256') {
    return { client, redirectUri, problem: redirectError('invalid_request', 'Требуется PKCE: code_challenge с методом S256.') };
  }

  return { client, redirectUri, problem: null };
}

// ---------- Коды авторизации ----------

export async function createAuthorizationCode({ clientId, userId, redirectUri, codeChallenge }) {
  const code = newToken('atsc_');

  await db.query(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))`,
    [sha256(code), clientId, userId, redirectUri, codeChallenge, CODE_TTL_MINUTES]
  );

  return code;
}

function verifyPkce(verifier, challenge) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier || '')) return false;

  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const expected = Buffer.from(challenge);

  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

async function issueGrant(tx, { grantId, clientId, userId }) {
  const accessToken = newToken('atsa_');
  const refreshToken = newToken('atsr_');
  const values = [sha256(accessToken), ACCESS_TOKEN_TTL_SECONDS, sha256(refreshToken), REFRESH_TOKEN_TTL_DAYS];

  if (grantId) {
    await tx.query(
      `UPDATE oauth_grants SET
         access_token_hash = $1, access_expires_at = now() + make_interval(secs => $2),
         refresh_token_hash = $3, refresh_expires_at = now() + make_interval(days => $4),
         last_used_at = now()
       WHERE id = $5`,
      [...values, grantId]
    );
  } else {
    await tx.query(
      `INSERT INTO oauth_grants
         (client_id, user_id, access_token_hash, access_expires_at, refresh_token_hash, refresh_expires_at)
       VALUES ($5, $6, $1, now() + make_interval(secs => $2), $3, now() + make_interval(days => $4))`,
      [...values, clientId, userId]
    );
  }

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: 'ats'
  };
}

// grant_type=authorization_code: код одноразовый, redirect_uri и PKCE должны совпасть.
export async function exchangeAuthorizationCode(params) {
  return transaction(async tx => {
    const row = await tx.one('DELETE FROM oauth_codes WHERE code_hash = $1 RETURNING *', [sha256(params.code || '')]);

    if (!row || new Date(row.expires_at) < new Date()) {
      throw new OAuthError('invalid_grant', 'Код авторизации недействителен или истёк.');
    }

    if (params.client_id && params.client_id !== row.client_id) {
      throw new OAuthError('invalid_grant', 'Код выдан другому клиенту.');
    }

    if (params.redirect_uri && !redirectMatches(row.redirect_uri, params.redirect_uri)) {
      throw new OAuthError('invalid_grant', 'redirect_uri не совпадает с запросом авторизации.');
    }

    if (!verifyPkce(params.code_verifier, row.code_challenge)) {
      throw new OAuthError('invalid_grant', 'Неверный code_verifier (PKCE).');
    }

    if (!(await getActiveUser(row.user_id))) {
      throw new OAuthError('invalid_grant', 'Доступ пользователя к ATS отключён.');
    }

    return issueGrant(tx, { clientId: row.client_id, userId: row.user_id });
  });
}

// grant_type=refresh_token: выдаёт новую пару, старый refresh-токен перестаёт действовать.
export async function refreshAccessToken(params) {
  return transaction(async tx => {
    const grant = await tx.one(
      `SELECT * FROM oauth_grants
       WHERE refresh_token_hash = $1 AND revoked_at IS NULL AND refresh_expires_at > now()
       FOR UPDATE`,
      [sha256(params.refresh_token || '')]
    );

    if (!grant || (params.client_id && params.client_id !== grant.client_id)) {
      throw new OAuthError('invalid_grant', 'Refresh-токен недействителен, отозван или истёк.');
    }

    if (!(await getActiveUser(grant.user_id))) {
      throw new OAuthError('invalid_grant', 'Доступ пользователя к ATS отключён.');
    }

    return issueGrant(tx, { grantId: grant.id });
  });
}

// ---------- Проверка токена ----------

// Возвращает { user, grantId } по Bearer access-токену или null.
export async function authenticateAccessToken(token) {
  if (!token) return null;

  const grant = await db.one(
    `SELECT id, user_id, last_used_at FROM oauth_grants
     WHERE access_token_hash = $1 AND revoked_at IS NULL AND access_expires_at > now()`,
    [sha256(token)]
  );

  if (!grant) return null;

  const user = await getActiveUser(grant.user_id);
  if (!user) return null;

  // «Последнее использование» обновляется не чаще раза в 5 минут.
  if (!grant.last_used_at || Date.now() - new Date(grant.last_used_at).getTime() > 5 * 60 * 1000) {
    db.query('UPDATE oauth_grants SET last_used_at = now() WHERE id = $1', [grant.id]).catch(() => {});
  }

  return { user, grantId: grant.id };
}

// RFC 7009: отзыв по access- или refresh-токену; неизвестный токен — не ошибка.
export async function revokeToken(token) {
  const hash = sha256(token || '');

  await db.query(
    `UPDATE oauth_grants SET revoked_at = now()
     WHERE (access_token_hash = $1 OR refresh_token_hash = $1) AND revoked_at IS NULL`,
    [hash]
  );
}

// ---------- Личные токены ----------
// Выпускаются в профиле и передаются клиентом в заголовке Authorization как есть.
// Нужны, когда клиент не может пройти OAuth (например, прокси не пропускает /.well-known/*).

const PERSONAL_TOKEN_PREFIX = 'atsp_';
const MAX_PERSONAL_TOKENS = 10;
const PERSONAL_TOKEN_TTL_DAYS = [30, 90, 365, 0];

export const isPersonalToken = token => String(token || '').startsWith(PERSONAL_TOKEN_PREFIX);

export async function createPersonalToken(input, user) {
  const name = clean(input && input.name).slice(0, 80) || 'Claude';
  const days = Number(input && input.expiresInDays);
  const ttlDays = PERSONAL_TOKEN_TTL_DAYS.includes(days) ? days : 90;

  const { count } = await db.one(
    `SELECT count(*)::int AS count FROM mcp_personal_tokens
     WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    [user.id]
  );

  if (count >= MAX_PERSONAL_TOKENS) {
    fail(`Не больше ${MAX_PERSONAL_TOKENS} действующих токенов. Отключите ненужные.`);
  }

  const token = newToken(PERSONAL_TOKEN_PREFIX);

  const row = await db.one(
    `INSERT INTO mcp_personal_tokens (user_id, name, token_hash, token_prefix, expires_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5::int > 0 THEN now() + make_interval(days => $5::int) END)
     RETURNING id, expires_at`,
    [user.id, name, sha256(token), token.slice(0, PERSONAL_TOKEN_PREFIX.length + 6), ttlDays]
  );

  // Сам токен показывается один раз — в БД остаётся только хеш.
  return { id: row.id, token, expiresAt: row.expires_at ? formatDateTime(row.expires_at) : null };
}

export async function authenticatePersonalToken(token) {
  if (!isPersonalToken(token)) return null;

  const row = await db.one(
    `SELECT id, user_id, last_used_at FROM mcp_personal_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    [sha256(token)]
  );

  if (!row) return null;

  const user = await getActiveUser(row.user_id);
  if (!user) return null;

  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 5 * 60 * 1000) {
    db.query('UPDATE mcp_personal_tokens SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => {});
  }

  return { user, tokenId: row.id };
}

export async function revokePersonalToken(id, user) {
  if (!isUuid(id)) fail('Некорректный идентификатор.');

  const result = await db.query(
    'UPDATE mcp_personal_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
    [id, user.id]
  );

  if (!result.rowCount) fail('Токен не найден.', 404);

  return { ok: true };
}

// Название помогает отличать токены (ноутбук, CI…); сам токен и срок не меняются.
export async function renamePersonalToken(input, user) {
  const id = input && input.id;
  const name = clean(input && input.name).slice(0, 80);

  if (!isUuid(id)) fail('Некорректный идентификатор.');
  if (!name) fail('Введите название токена.');

  const result = await db.query(
    `UPDATE mcp_personal_tokens SET name = $3
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    [id, user.id, name]
  );

  if (!result.rowCount) fail('Токен не найден.', 404);

  return { id, name };
}

// ---------- Подключения пользователя (профиль) ----------

export async function listConnections(_input, user) {
  const rows = await db.many(
    `SELECT g.id, g.created_at, g.last_used_at, c.name AS client_name
     FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
     WHERE g.user_id = $1 AND g.revoked_at IS NULL AND g.refresh_expires_at > now()
     ORDER BY COALESCE(g.last_used_at, g.created_at) DESC`,
    [user.id]
  );

  const tokens = await db.many(
    `SELECT id, name, token_prefix, expires_at, created_at, last_used_at FROM mcp_personal_tokens
     WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
     ORDER BY created_at DESC`,
    [user.id]
  );

  return {
    connections: rows.map(row => ({
      id: row.id,
      clientName: row.client_name || 'MCP-клиент',
      createdAt: formatDateTime(row.created_at),
      lastUsedAt: row.last_used_at ? formatDateTime(row.last_used_at) : null
    })),
    tokens: tokens.map(row => ({
      id: row.id,
      name: row.name,
      prefix: row.token_prefix,
      createdAt: formatDateTime(row.created_at),
      lastUsedAt: row.last_used_at ? formatDateTime(row.last_used_at) : null,
      expiresAt: row.expires_at ? formatDateTime(row.expires_at) : null
    }))
  };
}

export async function revokeConnection(id, user) {
  if (!isUuid(id)) fail('Некорректный идентификатор.');

  const result = await db.query(
    'UPDATE oauth_grants SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
    [id, user.id]
  );

  if (!result.rowCount) fail('Подключение не найдено.', 404);

  return { ok: true };
}

// Уборка: истёкшие коды, мёртвые подключения и клиенты, которые так и не получили доступ.
export async function cleanupOAuth() {
  await db.query('DELETE FROM oauth_codes WHERE expires_at < now()');
  await db.query(
    `DELETE FROM mcp_personal_tokens
     WHERE revoked_at < now() - interval '7 days' OR expires_at < now() - interval '7 days'`
  );
  await db.query(
    `DELETE FROM oauth_grants
     WHERE refresh_expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`
  );
  await db.query(
    `DELETE FROM oauth_clients c
     WHERE c.created_at < now() - interval '1 day'
       AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM oauth_codes o WHERE o.client_id = c.id)`
  );
}
