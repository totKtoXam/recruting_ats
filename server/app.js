import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import connectPgSimple from 'connect-pg-simple';
import express from 'express';
import session from 'express-session';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { toPublicError } from './lib/errors.js';
import { rpcHandlers } from './rpc.js';
import { authRouter, loadUser, requireUserApi, requireUserPage } from './routes/auth.js';
import { filesRouter } from './routes/files.js';
import { escapeJsString } from './routes/html.js';
import { intakeRouter } from './routes/intake.js';

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
    .replace('<?= initialDraftToken ?>', escapeJsString(initialDraftToken));
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

  app.get('/healthz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // Intake API авторизуется ключом и не использует cookie-сессию.
  app.use('/intake', intakeRouter());

  app.use(
    session({
      name: 'ats.sid',
      store: new PgStore({ pool, tableName: 'session', createTableIfMissing: false }),
      secret: config.sessionSecret || 'dev-only-insecure-secret',
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.env === 'production',
        maxAge: config.sessionMaxAgeDays * 24 * 60 * 60 * 1000
      }
    })
  );

  app.use(loadUser);
  app.use(authRouter());
  app.use(filesRouter());

  app.post(
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

  app.get('/', requireUserPage, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderIndex(req.query));
  });

  app.use((error, req, res, _next) => {
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

    if (req.path.startsWith('/api/')) {
      return res.status(status).json({ error: { message } });
    }

    res.status(status).type('text').send(message);
  });

  return app;
}
