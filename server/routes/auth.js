import { randomBytes } from 'node:crypto';
import express from 'express';
import { config } from '../config.js';
import { AppError, toPublicError } from '../lib/errors.js';
import { ACCESS_DENIED_MESSAGE, getActiveUser, upsertUserOnLogin } from '../services/users.js';
import { escapeHtml } from './html.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

const redirectUri = () => `${config.publicUrl}/auth/google/callback`;

// Разрешаем возвращаться только на относительные пути этого приложения.
function safeReturnTo(value) {
  const path = String(value || '');
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\') ? path : '/';
}

function loginPage({ error = '', next = '/' } = {}) {
  const nextField = `<input type="hidden" name="next" value="${escapeHtml(next)}">`;
  const body =
    config.auth.mode === 'dev'
      ? `<form method="post" action="/auth/dev-login">
           ${nextField}
           <input name="email" type="email" placeholder="email" required autofocus>
           <input name="name" placeholder="ФИО (необязательно)">
           <button type="submit">Войти (dev)</button>
         </form>`
      : `<a class="button" href="/auth/google?next=${encodeURIComponent(next)}">Войти через Google</a>`;

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recruiting ATS — вход</title>
<style>
  body{font-family:Inter,Arial,sans-serif;background:#f4f6fb;display:grid;place-items:center;min-height:100vh;margin:0}
  .card{background:#fff;padding:32px;border-radius:16px;box-shadow:0 10px 30px rgba(15,23,42,.08);width:min(360px,calc(100vw - 32px))}
  h1{font-size:20px;margin:0 0 20px}
  .button,button{display:block;width:100%;box-sizing:border-box;text-align:center;padding:12px;border-radius:10px;border:0;background:#2563eb;color:#fff;text-decoration:none;font-size:15px;cursor:pointer}
  input{display:block;width:100%;box-sizing:border-box;padding:10px;margin:0 0 10px;border:1px solid #cbd5e1;border-radius:10px}
  .error{background:#fef2f2;color:#b91c1c;padding:10px 12px;border-radius:10px;margin:0 0 16px;font-size:14px}
</style></head>
<body><div class="card">
  <h1>Recruiting ATS</h1>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  ${body}
</div></body></html>`;
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(error => (error ? reject(error) : resolve()));
  });
}

async function signIn(req, res, identity, returnTo) {
  const user = await upsertUserOnLogin(identity);

  if (user.pendingApproval) {
    throw new AppError(ACCESS_DENIED_MESSAGE, 403);
  }

  await regenerateSession(req);
  req.session.userId = user.id;
  res.redirect(safeReturnTo(returnTo));
}

export function authRouter() {
  const router = express.Router();

  router.get('/auth/login', (req, res) => {
    res.type('html').send(loginPage({ next: safeReturnTo(req.query.next) }));
  });

  router.post('/auth/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('ats.sid');
      res.redirect('/auth/login');
    });
  });

  if (config.auth.mode === 'dev') {
    router.post('/auth/dev-login', express.urlencoded({ extended: false }), async (req, res) => {
      try {
        await signIn(
          req,
          res,
          { subject: null, email: req.body.email, fullName: req.body.name },
          req.body.next
        );
      } catch (error) {
        const publicError = toPublicError(error);

        if (!publicError) {
          console.error(error);
        }

        res
          .status(publicError ? publicError.status : 500)
          .type('html')
          .send(loginPage({ error: publicError ? publicError.message : 'Ошибка входа.' }));
      }
    });

    return router;
  }

  router.get('/auth/google', (req, res) => {
    const state = randomBytes(16).toString('hex');

    req.session.oauthState = state;
    req.session.returnTo = safeReturnTo(req.query.next);

    const params = new URLSearchParams({
      client_id: config.auth.googleClientId,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account'
    });

    res.redirect(`${GOOGLE_AUTH_URL}?${params}`);
  });

  router.get('/auth/google/callback', async (req, res) => {
    try {
      const { code, state, error } = req.query;

      if (error) {
        throw new AppError('Вход через Google отменён.', 401);
      }

      if (!state || state !== req.session.oauthState) {
        throw new AppError('Сессия входа устарела. Попробуйте ещё раз.', 401);
      }

      delete req.session.oauthState;

      const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(code || ''),
          client_id: config.auth.googleClientId,
          client_secret: config.auth.googleClientSecret,
          redirect_uri: redirectUri(),
          grant_type: 'authorization_code'
        })
      });

      if (!tokenResponse.ok) {
        throw new AppError('Не удалось завершить вход через Google.', 401);
      }

      const { access_token: accessToken } = await tokenResponse.json();

      const profileResponse = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      if (!profileResponse.ok) {
        throw new AppError('Не удалось получить профиль Google.', 401);
      }

      const profile = await profileResponse.json();

      if (!profile.email_verified) {
        throw new AppError('Email Google Account не подтверждён.', 403);
      }

      await signIn(
        req,
        res,
        {
          subject: profile.sub,
          email: profile.email,
          fullName: profile.name,
          avatarUrl: profile.picture
        },
        req.session.returnTo
      );
    } catch (error) {
      const publicError = toPublicError(error);
      const status = publicError ? publicError.status : 500;
      const message = publicError ? publicError.message : 'Ошибка входа.';

      if (!publicError) {
        console.error(error);
      }

      res.status(status).type('html').send(loginPage({ error: message }));
    }
  });

  return router;
}

// Загружает пользователя сессии в req.user. Отключённый пользователь разлогинивается.
export async function loadUser(req, _res, next) {
  try {
    req.user = await getActiveUser(req.session.userId);

    if (!req.user && req.session.userId) {
      delete req.session.userId;
    }

    next();
  } catch (error) {
    next(error);
  }
}

export function requireUserApi(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: { message: 'Требуется авторизация.' } });
  }
  next();
}

export function requireUserPage(req, res, next) {
  if (!req.user) {
    return res.redirect(`/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}
