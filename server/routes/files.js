import { pipeline } from 'node:stream/promises';
import express from 'express';
import { db } from '../db/pool.js';
import { formatDateTime } from '../lib/dates.js';
import { downloadStream, driveFolderUrl, getFileMeta, isNotFound } from '../lib/drive.js';
import { composeFullName, isUuid } from '../lib/validation.js';
import { fileUrl } from '../services/mappers.js';
import { requireUserPage } from './auth.js';
import { escapeHtml } from './html.js';

// Внешние ссылки (импорт) допускаются только со схемой http(s).
const safeExternalUrl = url => (/^https?:\/\//i.test(String(url || '')) ? url : '');

const INLINE_MIME = new Set(['application/pdf']);

function contentDisposition(fileName, mimeType) {
  const type = INLINE_MIME.has(mimeType) ? 'inline' : 'attachment';
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function filesRouter() {
  const router = express.Router();

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
