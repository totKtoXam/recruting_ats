// Resume Intake API для AI-интеграций (раньше — отдельный Apps Script проект api-src).
// Контракт сохранён: ?api=references|meta (GET), ?api=candidate-draft (POST), ключ в api_key/apiKey.
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { config } from '../config.js';
import { AppError, toPublicError } from '../lib/errors.js';
import { getResponsibles, getSources, getVacancies } from '../services/references.js';
import { createCandidateDraft } from '../services/drafts.js';

function requireApiKey(req) {
  if (!config.intakeApiKey) {
    throw new AppError('API не настроен: задайте переменную окружения ATS_API_KEY.', 503);
  }

  const supplied = Buffer.from(
    String(req.get('x-api-key') || req.query.api_key || (req.body && req.body.apiKey) || '')
  );
  const expected = Buffer.from(config.intakeApiKey);

  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new AppError('Некорректный API key.', 401);
  }
}

async function references() {
  const [vacancies, sources, responsibles] = await Promise.all([
    getVacancies(),
    getSources(),
    getResponsibles()
  ]);

  return {
    ok: true,
    webAppUrl: config.publicUrl,
    vacancies: vacancies.map(row => ({
      id: row['Vacancy ID'],
      number: row['№'],
      name: row['Вакансия'],
      status: row['Статус']
    })),
    sources: sources.map(row => ({
      id: row['Source ID'],
      number: row['№'],
      name: row['Название']
    })),
    responsibles: responsibles.map(row => ({
      id: row['Responsible ID'],
      number: row['№'],
      lastName: row['Фамилия'],
      firstName: row['Имя'],
      middleName: row['Отчество'],
      fullName: row['ФИО'],
      stages: row.stages
    }))
  };
}

function sendError(res, error) {
  const publicError = toPublicError(error);

  if (!publicError) {
    console.error(error);
  }

  res
    .status(publicError ? publicError.status : 500)
    .json({ ok: false, error: publicError ? publicError.message : 'Внутренняя ошибка сервера.' });
}

export function intakeRouter() {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      requireApiKey(req);

      const action = String(req.query.api || '').trim();

      if (action === 'references') {
        return res.json(await references());
      }

      if (action === 'meta') {
        return res.json({ ok: true, webAppUrl: config.publicUrl });
      }

      res.status(400).json({ ok: false, error: 'Неизвестный API action.' });
    } catch (error) {
      sendError(res, error);
    }
  });

  // Ключ из заголовка/query проверяется до разбора тела (до 15 МБ).
  const preAuth = (req, res, next) => {
    if (!req.get('x-api-key') && !req.query.api_key) {
      return next();
    }

    try {
      requireApiKey(req);
      next();
    } catch (error) {
      sendError(res, error);
    }
  };

  // Тело разбирается как JSON при любом Content-Type (curl -d по умолчанию шлёт form-urlencoded).
  router.post('/', preAuth, express.json({ limit: '15mb', type: () => true }), async (req, res) => {
    try {
      requireApiKey(req);

      const action = String(req.query.api || (req.body && req.body.action) || '').trim();

      if (action === 'candidate-draft') {
        return res.json(await createCandidateDraft(req.body || {}));
      }

      res.status(400).json({ ok: false, error: 'Неизвестный API action.' });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
