import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import connectPgSimple from 'connect-pg-simple';
import express from 'express';
import session from 'express-session';
import { config, withBase } from './config.js';
import { pool } from './db/pool.js';
import { toPublicError } from './lib/errors.js';
import { rpcHandlers } from './rpc.js';
import { handleEvents } from './services/realtime.js';
import { authRouter, loadUser, requireUserApi, requireUserPage } from './routes/auth.js';
import { filesRouter } from './routes/files.js';
import { escapeJsString } from './routes/html.js';
import { intakeRouter } from './routes/intake.js';
import { legalRouter } from './routes/legal.js';
import { mcpRouter } from './routes/mcp.js';
import { oauthRouter, wellKnownHandler } from './routes/oauth.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

// Сборка Index.html: те же include-директивы, что поддерживал HtmlService в Apps Script.
function buildIndexTemplate() {
  const read = name => fs.readFileSync(path.join(WEB_DIR, name + '.html'), 'utf8');

  return read('Index').replace(/<\?!=\s*include\('([A-Za-z]+)'\);?\s*\?>/g, (_match, name) => read(name));
}

let cachedTemplate = null;

function renderIndex(query) {
  const template =
    config.env === 'production'
      ? (cachedTemplate ||= buildIndexTemplate())
      : buildIndexTemplate();

  const initialRoute = query.page === 'admin' ? 'admin' : 'candidates';
  const initialDraftToken = typeof query.draft === 'string' ? query.draft : '';

  return template
    .replace('<?= initialRoute ?>', escapeJsString(initialRoute))
    .replace('<?= initialDraftToken ?>', escapeJsString(initialDraftToken))
    .replaceAll('<?= basePath ?>', config.basePath);
}

export function createApp() {
  const app = express();
  const PgStore = connectPgSimple(session);

  app.disable('x-powered-by');

  if (config.trustProxy) {
    app.set('trust proxy', 1);
  }

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin'
    });
    next();
  });

  // Все маршруты приложения живут под BASE_PATH (пусто — в корне домена).
  const router = express.Router();

  router.use(legalRouter());

  router.get('/healthz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // Intake API авторизуется ключом и не использует cookie-сессию.
  router.use('/intake', intakeRouter());

  // MCP-сервер для Claude и других AI-клиентов: OAuth Bearer-токен, без cookie-сессии.
  router.use(wellKnownHandler);
  router.use(mcpRouter());

  router.use(
    session({
      name: config.sessionCookieName,
      store: new PgStore({ pool, tableName: 'session', createTableIfMissing: false }),
      secret: config.sessionSecret || 'dev-only-insecure-secret',
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        path: config.basePath || '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.env === 'production',
        maxAge: config.sessionMaxAgeDays * 24 * 60 * 60 * 1000
      }
    })
  );

  router.use(loadUser);
  router.use(authRouter());
  router.use(oauthRouter());
  router.use(filesRouter());

  router.get('/api/events', requireUserApi, handleEvents);

  router.post(
    '/api/rpc/:name',
    requireUserApi,
    express.json({ limit: '20mb' }),
    async (req, res) => {
      const handler = Object.hasOwn(rpcHandlers, req.params.name)
        ? rpcHandlers[req.params.name]
        : null;

      if (!handler) {
        return res.status(404).json({ error: { message: 'Неизвестный метод.' } });
      }

      // Только JSON: простые кросс-сайтовые формы не пройдут без CORS preflight.
      if (!req.is('application/json')) {
        return res.status(415).json({ error: { message: 'Ожидается application/json.' } });
      }

      try {
        const result = await handler(req.body ? req.body.args : undefined, { user: req.user });
        res.json({ result: result === undefined ? null : result });
      } catch (error) {
        const publicError = toPublicError(error);

        if (!publicError) {
          console.error(`RPC ${req.params.name} failed:`, error);
        }

        res
          .status(publicError ? publicError.status : 500)
          .json({ error: { message: publicError ? publicError.message : 'Внутренняя ошибка сервера.' } });
      }
    }
  );

  router.get('/', requireUserPage, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderIndex(req.query));
  });

  router.use((error, req, res, _next) => {
    // Ошибки express.json: невалидный JSON и превышение лимита тела запроса.
    const bodyErrors = {
      'entity.parse.failed': [400, 'Body должен быть корректным JSON.'],
      'entity.too.large': [413, 'Слишком большой запрос. Размер резюме не должен превышать 10 МБ.']
    };
    const [status, message] = bodyErrors[error && error.type] || [500, 'Внутренняя ошибка сервера.'];

    if (status === 500) {
      console.error(error);
    }

    if (req.path.startsWith('/intake')) {
      return res.status(status).json({ ok: false, error: message });
    }

    if (req.path.startsWith('/mcp')) {
      return res.status(status).json({ jsonrpc: '2.0', id: null, error: { code: status === 400 ? -32700 : -32603, message } });
    }

    if (req.path.startsWith('/oauth/')) {
      return res.status(status).json({ error: status === 500 ? 'server_error' : 'invalid_request', error_description: message });
    }

    if (req.path.startsWith('/api/')) {
      return res.status(status).json({ error: { message } });
    }

    res.status(status).type('text').send(message);
  });

  // Метаданные OAuth клиенты ищут и в корне домена (/.well-known/...<BASE_PATH>).
  if (config.basePath) {
    app.use(wellKnownHandler);
  }

  app.use(config.basePath || '/', router);

  // Корень домена ведёт в приложение, если оно смонтировано под BASE_PATH.
  if (config.basePath) {
    app.get('/', (_req, res) => res.redirect(withBase('/')));
  }

  return app;
}
