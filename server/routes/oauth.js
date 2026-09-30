// OAuth 2.1 для MCP: метаданные (RFC 8414, RFC 9728), регистрация клиента (RFC 7591),
// страница согласия, выдача и отзыв токенов. Пользователь входит в ATS как обычно (Google),
// поэтому MCP-клиент действует от его имени и с его правами.
import { randomBytes } from 'node:crypto';
import express from 'express';
import { config } from '../config.js';
import { toPublicError } from '../lib/errors.js';
import {
  OAuthError,
  cleanupOAuth,
  createAuthorizationCode,
  exchangeAuthorizationCode,
  refreshAccessToken,
  registerClient,
  revokeToken,
  validateAuthorizeRequest
} from '../services/oauth.js';
import { userDisplayName } from '../services/mappers.js';
import { authCardPage, requireUserPage } from './auth.js';
import { escapeHtml } from './html.js';

export const mcpResourceUrl = () => `${config.publicUrl}/mcp`;
export const protectedResourceMetadataUrl = () => `${config.publicUrl}/.well-known/oauth-protected-resource`;

function authorizationServerMetadata() {
  const base = config.publicUrl;

  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['ats'],
    service_documentation: `${base}/`
  };
}

// Тот же документ по адресу OpenID Discovery. За reverse proxy под BASE_PATH клиенту часто
// доступен только {PUBLIC_URL}/.well-known/openid-configuration, а MCP SDK проверяет его
// по схеме OpenID Provider — там обязательны jwks_uri, subject_types_supported и
// id_token_signing_alg_values_supported. ID-токены ATS не выдаёт, набор ключей пуст.
export function openIdConfiguration() {
  return {
    ...authorizationServerMetadata(),
    jwks_uri: `${config.publicUrl}/oauth/jwks`,
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256']
  };
}

function protectedResourceMetadata() {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [config.publicUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: ['ats'],
    resource_name: 'Recruiting ATS'
  };
}

// Токены и метаданные читают нативные и браузерные клиенты; cookie здесь не используются.
export function allowAnyOrigin(req, res, next) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, X-ATS-Token',
    'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id'
  });

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
}

// /.well-known/* ищется клиентами и в корне домена (с путём BASE_PATH в конце, RFC 8414),
// и под BASE_PATH (OpenID-вариант), поэтому обработчик монтируется в обоих местах.
export function wellKnownHandler(req, res, next) {
  const path = req.path;

  if (path.startsWith('/.well-known/oauth-protected-resource')) {
    return allowAnyOrigin(req, res, () => res.json(protectedResourceMetadata()));
  }

  if (path.startsWith('/.well-known/oauth-authorization-server')) {
    return allowAnyOrigin(req, res, () => res.json(authorizationServerMetadata()));
  }

  if (path.startsWith('/.well-known/openid-configuration')) {
    return allowAnyOrigin(req, res, () => res.json(openIdConfiguration()));
  }

  next();
}

// Регистрация клиента не требует входа — ограничиваем частоту по IP (в памяти процесса).
const REGISTER_LIMIT = 20;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const registerHits = new Map();

function registerRateLimited(ip) {
  const now = Date.now();
  const entry = registerHits.get(ip);

  if (!entry || entry.resetAt < now) {
    if (registerHits.size > 10000) registerHits.clear();
    registerHits.set(ip, { count: 1, resetAt: now + REGISTER_WINDOW_MS });
    return false;
  }

  entry.count += 1;
  return entry.count > REGISTER_LIMIT;
}

function sendOAuthError(res, error) {
  if (error instanceof OAuthError) {
    return res.status(error.status).json({ error: error.error, error_description: error.message });
  }

  console.error('OAuth failed:', error);
  res.status(500).json({ error: 'server_error', error_description: 'Внутренняя ошибка сервера.' });
}

function redirectWithParams(res, redirectUri, params) {
  const url = new URL(redirectUri);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }

  url.searchParams.set('iss', config.publicUrl);
  res.redirect(url.toString());
}

function errorPage(res, status, message) {
  res.status(status).type('html').send(authCardPage({ title: 'Подключение', error: message }));
}

function consentPage({ clientName, user, nonce, redirectUri }) {
  const host = new URL(redirectUri).host;
  const body = `
    <p class="text"><strong>${escapeHtml(clientName)}</strong> запрашивает доступ к Recruiting ATS от вашего имени
      (<strong>${escapeHtml(userDisplayName(user))}</strong>, ${escapeHtml(user.email)}).</p>
    <p class="text">Приложение сможет с вашими правами:</p>
    <ul class="text">
      <li>просматривать кандидатов, вакансии, историю и комментарии;</li>
      <li>создавать и изменять записи, переводить кандидатов по этапам, комментировать.</li>
    </ul>
    <p class="text">Все действия записываются в журнал от вашего имени. Отключить доступ можно в профиле ATS.
      После подтверждения вы вернётесь в приложение (${escapeHtml(host)}).</p>
    <form method="post">
      <input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
      <div class="actions">
        <button type="submit" name="decision" value="deny" class="button button-google">Отмена</button>
        <button type="submit" name="decision" value="allow" class="button button-primary">Разрешить</button>
      </div>
    </form>`;

  return authCardPage({ title: 'Подключение приложения', body });
}

export function oauthRouter() {
  const router = express.Router();
  const formOrJson = [express.urlencoded({ extended: false }), express.json({ limit: '64kb' })];

  router.post('/oauth/register', allowAnyOrigin, express.json({ limit: '64kb' }), async (req, res) => {
    if (registerRateLimited(req.ip)) {
      return res.status(429).json({ error: 'slow_down', error_description: 'Слишком много регистраций. Повторите позже.' });
    }

    try {
      cleanupOAuth().catch(error => console.error('OAuth cleanup failed:', error));
      res.status(201).set('Cache-Control', 'no-store').json(await registerClient(req.body));
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  router.options(['/oauth/register', '/oauth/token', '/oauth/revoke'], allowAnyOrigin);

  router.get('/oauth/jwks', allowAnyOrigin, (_req, res) => res.json({ keys: [] }));

  router.get('/oauth/authorize', requireUserPage, async (req, res) => {
    try {
      const params = Object.fromEntries(
        Object.entries(req.query).map(([key, value]) => [key, typeof value === 'string' ? value : ''])
      );
      const { client, redirectUri, problem } = await validateAuthorizeRequest(params);

      if (problem) {
        return redirectWithParams(res, problem.redirectUri, {
          error: problem.error,
          error_description: problem.description,
          state: params.state
        });
      }

      // Параметры запоминаются в сессии: форма согласия передаёт только одноразовый nonce (CSRF).
      const nonce = randomBytes(16).toString('hex');
      req.session.oauthConsent = {
        nonce,
        clientId: client.id,
        redirectUri,
        codeChallenge: params.code_challenge,
        state: params.state || ''
      };

      res.set({ 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
      res.type('html').send(consentPage({ clientName: client.name || 'MCP-клиент', user: req.user, nonce, redirectUri }));
    } catch (error) {
      const publicError = toPublicError(error);
      if (!publicError) console.error('OAuth authorize failed:', error);
      errorPage(res, publicError ? publicError.status : 500, publicError ? publicError.message : 'Внутренняя ошибка сервера.');
    }
  });

  router.post('/oauth/authorize', requireUserPage, express.urlencoded({ extended: false }), async (req, res) => {
    const pending = req.session.oauthConsent;

    if (!pending || !req.body || req.body.nonce !== pending.nonce) {
      return errorPage(res, 400, 'Запрос на подключение устарел. Запустите подключение в приложении ещё раз.');
    }

    delete req.session.oauthConsent;

    try {
      if (req.body.decision !== 'allow') {
        return redirectWithParams(res, pending.redirectUri, {
          error: 'access_denied',
          error_description: 'Пользователь отклонил доступ.',
          state: pending.state
        });
      }

      const code = await createAuthorizationCode({
        clientId: pending.clientId,
        userId: req.user.id,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge
      });

      redirectWithParams(res, pending.redirectUri, { code, state: pending.state });
    } catch (error) {
      console.error('OAuth authorize failed:', error);
      errorPage(res, 500, 'Внутренняя ошибка сервера.');
    }
  });

  router.post('/oauth/token', allowAnyOrigin, formOrJson, async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });

    try {
      const params = req.body || {};

      if (params.grant_type === 'authorization_code') {
        return res.json(await exchangeAuthorizationCode(params));
      }

      if (params.grant_type === 'refresh_token') {
        return res.json(await refreshAccessToken(params));
      }

      throw new OAuthError('unsupported_grant_type', 'Поддерживаются authorization_code и refresh_token.');
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  router.post('/oauth/revoke', allowAnyOrigin, formOrJson, async (req, res) => {
    try {
      await revokeToken(req.body && req.body.token);
      res.status(200).end();
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  return router;
}
