import { pipeline } from 'node:stream/promises';
import express from 'express';
import { db } from '../db/pool.js';
import { formatDateTime } from '../lib/dates.js';
import { downloadStream, driveFolderUrl, getFileMeta, isNotFound } from '../lib/drive.js';
import { composeFullName, isUuid } from '../lib/validation.js';
import { fileUrl } from '../services/mappers.js';
import { getSourceIcon } from '../services/references.js';
import { requireUserPage } from './auth.js';
import { escapeHtml } from './html.js';

// Внешние ссылки (импорт) допускаются только со схемой http(s).
const safeExternalUrl = url => (/^https?:\/\//i.test(String(url || '')) ? url : '');

// Открываются в браузере; остальное скачивается. SVG и HTML сюда не входят: со своего домена
// они могли бы выполнить скрипт.
const INLINE_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'audio/mpeg', 'audio/mp4', 'video/mp4']);

function contentDisposition(fileName, mimeType) {
  const type = INLINE_MIME.has(mimeType) ? 'inline' : 'attachment';
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function filesRouter() {
  const router = express.Router();

  // Своя иконка источника (PNG 64×64 из БД). Адрес содержит ?v=<время изменения>,
  // поэтому ответ можно кэшировать надолго.
  router.get('/source-icons/:id', requireUserPage, async (req, res, next) => {
    try {
      const png = isUuid(req.params.id) ? await getSourceIcon(req.params.id) : null;
      if (!png) return res.status(404).type('text').send('Иконка не найдена.');
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      res.type('png').send(png);
    } catch (error) {
      next(error);
    }
  });

  // Файлы приватны: сервер отдаёт их из Google Drive только авторизованным пользователям,
  // поэтому пользователям ATS не нужен собственный доступ к папке в Drive.
  router.get('/files/:id', requireUserPage, async (req, res, next) => {
    try {
      const file = isUuid(req.params.id)
        ? await db.one('SELECT * FROM files WHERE id = $1', [req.params.id])
        : null;

      if (!file) {
        return res.status(404).type('text').send('Файл не найден.');
      }

      if (!file.drive_file_id) {
        const url = safeExternalUrl(file.external_url);
        return url ? res.redirect(url) : res.status(404).type('text').send('Файл не найден.');
      }

      let meta;

      try {
        meta = await getFileMeta(file.drive_file_id);
      } catch (error) {
        if (isNotFound(error)) {
          return res.status(404).type('text').send('Файл не найден в Google Drive.');
        }
        throw error;
      }

      if (meta.trashed) {
        return res.status(404).type('text').send('Файл перемещён в корзину Google Drive.');
      }

      // Нативные документы Google (Docs и т.п.) нельзя скачать как есть — открываем в Drive.
      if (String(meta.mimeType).startsWith('application/vnd.google-apps.')) {
        return res.redirect(meta.webViewLink);
      }

      const mimeType = meta.mimeType || file.mime_type || 'application/octet-stream';
      const stream = await downloadStream(file.drive_file_id);

      res.set({
        'Content-Type': mimeType,
        'Content-Disposition': contentDisposition(file.original_name, mimeType),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store'
      });

      await pipeline(stream, res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      next(error);
    }
  });

  // Аналог «папки кандидата»: список всех версий резюме + ссылка на папку в Drive.
  router.get('/candidates/:id/files', requireUserPage, async (req, res, next) => {
    try {
      const candidate = isUuid(req.params.id)
        ? await db.one('SELECT * FROM candidates WHERE id = $1', [req.params.id])
        : null;

      if (!candidate) {
        return res.status(404).type('text').send('Кандидат не найден.');
      }

      const files = await db.many(
        `SELECT f.id, f.original_name, f.size_bytes, f.drive_file_id, f.external_url, cr.uploaded_at
         FROM candidate_resumes cr
         JOIN files f ON f.id = cr.file_id
         WHERE cr.candidate_id = $1
         ORDER BY cr.uploaded_at DESC`,
        [candidate.id]
      );

      const fullName = composeFullName(candidate.last_name, candidate.first_name, candidate.middle_name);
      const rows = files
        .map(file => {
          const href = file.drive_file_id ? fileUrl(file.id) : safeExternalUrl(file.external_url);
          const size = file.size_bytes ? ' · ' + Math.ceil(file.size_bytes / 1024) + ' КБ' : '';
          return `<li><a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(file.original_name)}</a>
            <span>${escapeHtml(formatDateTime(file.uploaded_at))}${size}</span></li>`;
        })
        .join('');

      const folderLink = candidate.drive_folder_id
        ? `<p><a href="${escapeHtml(driveFolderUrl(candidate.drive_folder_id))}" target="_blank" rel="noopener">Открыть папку в Google Drive ↗</a>
           <small>(нужен доступ к папке в Drive)</small></p>`
        : '';

      res.type('html').send(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Файлы кандидата</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 72 72'%3E%3Cdefs%3E%3ClinearGradient id='atsLogoG' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%2310b981'/%3E%3Cstop offset='1' stop-color='%23047857'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='72' height='72' rx='20' fill='url(%23atsLogoG)'/%3E%3Ccircle cx='31' cy='31' r='14' fill='none' stroke='%23fff' stroke-width='5'/%3E%3Cpath d='M41.5 41.5L55 55' stroke='%23fff' stroke-width='6' stroke-linecap='round'/%3E%3Ccircle cx='31' cy='27' r='4' fill='%23fff'/%3E%3Cpath d='M23 38c1-5 5-6 8-6s7 1 8 6z' fill='%23fff'/%3E%3C/svg%3E">
<style>
  body{font-family:Inter,Arial,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#0f172a}
  li{padding:10px 0;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;gap:16px}
  ul{list-style:none;padding:0} span,small{color:#64748b;font-size:14px;white-space:nowrap} a{color:#2563eb}
</style></head>
<body>
  <h1>№${escapeHtml(candidate.number)} · ${escapeHtml(fullName)}</h1>
  ${rows ? `<ul>${rows}</ul>` : '<p>Файлов нет.</p>'}
  ${folderLink}
</body></html>`);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
