// Swagger UI со спецификацией всего API (server/openapi). Страница и спецификация доступны
// только вошедшим пользователям: «Try it out» идёт на тот же origin с cookie сессии.
import { createRequire } from 'node:module';
import path from 'node:path';
import express from 'express';
import { config, withBase } from '../config.js';
import { buildOpenApiSpec } from '../openapi/index.js';
import { requireUserApi, requireUserPage } from './auth.js';
import { escapeHtml, escapeJsString } from './html.js';

const SWAGGER_UI_DIR = path.dirname(createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'));

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 72 72'%3E%3Cdefs%3E%3ClinearGradient id='atsLogoG' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%2310b981'/%3E%3Cstop offset='1' stop-color='%23047857'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='72' height='72' rx='20' fill='url(%23atsLogoG)'/%3E%3Ccircle cx='31' cy='31' r='14' fill='none' stroke='%23fff' stroke-width='5'/%3E%3Cpath d='M41.5 41.5L55 55' stroke='%23fff' stroke-width='6' stroke-linecap='round'/%3E%3Ccircle cx='31' cy='27' r='4' fill='%23fff'/%3E%3Cpath d='M23 38c1-5 5-6 8-6s7 1 8 6z' fill='%23fff'/%3E%3C/svg%3E";

function docsPage() {
  const assets = withBase('/api/docs/assets');
  const production = config.env === 'production';

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>API · Recruiting ATS</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON}">
<link rel="stylesheet" href="${assets}/swagger-ui.css">
<style>
  body{margin:0;background:#fff}
  .ats-bar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 20px;
    border-bottom:1px solid #e3e8ef;font:14px/1.4 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#172033}
  .ats-bar a{color:#4f46e5;text-decoration:none;font-weight:600}
  .ats-bar a:hover{text-decoration:underline}
  .ats-bar-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .ats-bar-links{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
  .ats-env{padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;background:#eef2ff;color:#4338ca}
  .ats-env.prod{background:#fef2f2;color:#b91c1c}
  .swagger-ui .topbar{display:none}
</style></head>
<body>
<div class="ats-bar">
  <span class="ats-bar-title"><strong>Recruiting ATS · API</strong>
    ${production
      ? '<span class="ats-env prod" title="Запросы из «Try it out» меняют рабочие данные">production — рабочие данные</span>'
      : `<span class="ats-env">${escapeHtml(config.env)}</span>`}</span>
  <span class="ats-bar-links">
    <a href="${withBase('/api/openapi.json')}" download="recruiting-ats-openapi.json">Скачать openapi.json</a>
    <a href="${withBase('/')}">← В приложение</a>
  </span>
</div>
<div id="swagger-ui"></div>
<script src="${assets}/swagger-ui-bundle.js"></script>
<script>
  // Методы с x-ats-writes меняют данные: при SWAGGER_CONFIRM_WRITES запрос уходит только после подтверждения.
  const CONFIRM_WRITES = ${config.swaggerConfirmWrites ? 'true' : 'false'};
  // Клик по Execute перехватывается до кнопки: при отмене Swagger UI не переходит в «выполняется».
  const ConfirmWritesPlugin = () => ({
    wrapComponents: {
      execute: (Original, system) => props => {
        const writes = CONFIRM_WRITES && props.operation && props.operation.get && props.operation.get('x-ats-writes');
        const guard = event => {
          const target = String(props.method || '').toUpperCase() + ' ' + (props.path || '');
          if (!window.confirm('Запрос изменит данные ATS от вашего имени и попадёт в журнал:\\n\\n' + target + '\\n\\nВыполнить?')) {
            event.stopPropagation();
            event.preventDefault();
          }
        };
        const button = system.React.createElement(Original, props);
        return writes ? system.React.createElement('span', { style: { display: 'contents' }, onClickCapture: guard }, button) : button;
      }
    }
  });

  window.ui = SwaggerUIBundle({
    url: '${escapeJsString(withBase('/api/openapi.json'))}',
    dom_id: '#swagger-ui',
    deepLinking: true,
    docExpansion: 'none',
    defaultModelsExpandDepth: 0,
    displayRequestDuration: true,
    filter: true,
    tryItOutEnabled: false,
    plugins: [ConfirmWritesPlugin]
  });
</script>
</body></html>`;
}

export function docsRouter() {
  const router = express.Router();

  router.get('/api/openapi.json', requireUserApi, (_req, res) => {
    res.set('Cache-Control', 'no-store').json(buildOpenApiSpec());
  });

  router.get('/api/docs', requireUserPage, (_req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
    res.type('html').send(docsPage());
  });

  router.use(
    '/api/docs/assets',
    requireUserPage,
    express.static(SWAGGER_UI_DIR, { index: false, maxAge: config.env === 'production' ? '1d' : 0 })
  );

  return router;
}
