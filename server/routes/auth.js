import { randomBytes } from 'node:crypto';
import express from 'express';
import { config } from '../config.js';
import { AppError, toPublicError } from '../lib/errors.js';
import { runtime } from '../services/settings.js';
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
  // Официальный многоцветный знак Google — по правилам брендинга «Sign in with Google».
  const googleMark = `<svg class="g-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>`;
  const body =
    config.auth.mode === 'dev'
      ? `<form method="post" action="/auth/dev-login">
           ${nextField}
           <label for="email">Email</label>
           <input id="email" name="email" type="email" autocomplete="email" required autofocus>
           <label for="name">ФИО <span class="optional">(необязательно)</span></label>
           <input id="name" name="name" autocomplete="name">
           <button type="submit" class="button button-primary">Войти (dev)</button>
         </form>`
      : `<a class="button button-google" href="/auth/google?next=${encodeURIComponent(next)}">${googleMark}<span>Войти через Google</span></a>`;

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Вход · Recruiting ATS</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<style>
  /* Те же токены, что и в приложении (web/Styles.html). */
  :root{
    --bg:#f3f5f8;--surface:#fff;--line:#e3e8ef;--line-strong:#cbd4e1;
    --text:#172033;--muted:#5d677a;--primary:#4f46e5;--primary-strong:#4338ca;--on-primary:#fff;
    --primary-ring:rgba(79,70,229,.35);--danger:#b91c1c;--danger-tint:#fef2f2;--danger-line:#fecaca;
    --shadow:0 2px 6px rgba(15,23,42,.06),0 12px 32px -8px rgba(15,23,42,.18);
    color-scheme:light
  }
  @media (prefers-color-scheme:dark){
    :root{
      --bg:#0e1116;--surface:#161a21;--line:#2a313c;--line-strong:#3a4350;
      --text:#e6e9ef;--muted:#9aa4b3;--primary:#8b93ff;--primary-strong:#a8aeff;--on-primary:#0d0f24;
      --primary-ring:rgba(139,147,255,.5);--danger:#fca5a5;--danger-tint:rgba(248,113,113,.12);--danger-line:rgba(248,113,113,.3);
      --shadow:0 0 0 1px rgba(255,255,255,.05),0 12px 32px rgba(0,0,0,.6);
      color-scheme:dark
    }
  }
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:16px;
    font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
  .card{width:min(380px,100%);padding:32px 28px 28px;border:1px solid var(--line);border-radius:12px;background:var(--surface);box-shadow:var(--shadow)}
  .brand{display:flex;align-items:center;gap:12px;margin-bottom:20px}
  .brand-mark{width:40px;height:40px;flex:0 0 40px;display:grid;place-items:center;border-radius:10px;background:#4f46e5;color:#fff;font-weight:800;font-size:18px}
  h1{margin:0;font-size:20px;font-weight:700;letter-spacing:-.01em;line-height:1.25}
  .lead{margin:2px 0 0;color:var(--muted);font-size:14px}
  .button{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:44px;padding:10px 16px;
    border-radius:8px;border:1px solid transparent;font:inherit;font-weight:600;text-decoration:none;cursor:pointer;
    transition:background-color 120ms,border-color 120ms,box-shadow 120ms,transform 120ms}
  .button:active{transform:scale(.98)}
  .button:focus-visible{outline:none;box-shadow:0 0 0 2px var(--surface),0 0 0 4px var(--primary-ring)}
  .button-primary{background:var(--primary);color:var(--on-primary)}
  .button-primary:hover{background:var(--primary-strong)}
  .button-google{background:var(--surface);color:var(--text);border-color:var(--line-strong)}
  .button-google:hover{background:var(--bg)}
  .g-mark{width:18px;height:18px;flex:0 0 18px}
  form{display:flex;flex-direction:column;gap:4px}
  label{font-size:12px;font-weight:500;color:var(--muted);margin-top:8px}
  .optional{font-weight:400}
  input{width:100%;min-height:44px;padding:8px 12px;border:1px solid var(--line-strong);border-radius:8px;
    background:var(--surface);color:var(--text);font:inherit;font-size:16px}
  input:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px var(--primary-ring)}
  form .button{margin-top:16px}
  .error{display:flex;gap:8px;align-items:flex-start;margin:0 0 16px;padding:10px 12px;border:1px solid var(--danger-line);
    border-radius:8px;background:var(--danger-tint);color:var(--danger);font-size:14px}
  .note{margin:16px 0 0;color:var(--muted);font-size:12px;text-align:center}
  @media (prefers-reduced-motion:reduce){.button{transition:none}.button:active{transform:none}}
</style></head>
<body><main class="card">
  <div class="brand">
    <div class="brand-mark" aria-hidden="true">R</div>
    <div>
      <h1>Recruiting ATS</h1>
      <p class="lead">Кандидаты и процесс найма</p>
    </div>
  </div>
  ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
  ${body}
  <p class="note">Доступ открывает администратор ATS.</p>
</main></body></html>`;
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
      client_id: runtime.auth().googleClientId,
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
          client_id: runtime.auth().googleClientId,
          client_secret: runtime.auth().googleClientSecret,
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
          givenName: profile.given_name,
          familyName: profile.family_name,
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
