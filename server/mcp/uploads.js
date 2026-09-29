// Загрузка файлов резюме для MCP-инструментов без base64 в аргументах: инструмент
// create_upload_link выдаёт одноразовую ссылку, клиент отправляет файл curl-ом
// (POST /mcp/uploads/<token>?name=cv.pdf), а затем передаёт uploadId в инструмент.
// Хранится в памяти процесса 30 минут: файл нужен только до ближайшего вызова инструмента.
import { randomBytes } from 'node:crypto';
import express from 'express';
import { APP_CONFIG, config } from '../config.js';
import { fail } from '../lib/errors.js';

const TTL_MS = 30 * 60 * 1000;
const MAX_PENDING_PER_USER = 5;
const uploads = new Map();

function sweep() {
  const now = Date.now();
  for (const [token, entry] of uploads) {
    if (entry.expiresAt < now) uploads.delete(token);
  }
}

export function createUploadLink(user) {
  sweep();

  const pending = [...uploads.values()].filter(entry => entry.userId === user.id).length;
  if (pending >= MAX_PENDING_PER_USER) {
    fail('Слишком много незавершённых загрузок. Повторите через несколько минут.', 429);
  }

  const token = randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + TTL_MS;
  uploads.set(token, { userId: user.id, expiresAt, file: null });

  const uploadUrl = `${config.publicUrl}/mcp/uploads/${token}`;

  return {
    uploadId: token,
    uploadUrl,
    expiresAt: new Date(expiresAt).toISOString(),
    maxBytes: APP_CONFIG.MAX_RESUME_BYTES,
    allowedExtensions: APP_CONFIG.ALLOWED_RESUME_EXTENSIONS,
    curl: `curl -sS -X POST --data-binary @"<путь к файлу>" -H "Content-Type: application/octet-stream" "${uploadUrl}?name=<имя файла>.pdf"`
  };
}

// Файл в формате, который принимают сервисы ATS: { name, mimeType, base64 }.
export function takeUpload(uploadId, user) {
  sweep();

  const entry = uploads.get(String(uploadId || ''));

  if (!entry || entry.userId !== user.id) {
    fail('Загрузка не найдена или истекла. Создайте новую ссылку (create_upload_link).', 404);
  }

  if (!entry.file) {
    fail('Файл по этой ссылке ещё не загружен.', 400);
  }

  return entry.file;
}

const MIME_BY_EXTENSION = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

export function uploadsRouter() {
  const router = express.Router();

  router.post(
    '/mcp/uploads/:token',
    express.raw({ type: () => true, limit: APP_CONFIG.MAX_RESUME_BYTES + 1024 }),
    (req, res) => {
      sweep();

      const entry = uploads.get(req.params.token);

      if (!entry) {
        return res.status(404).json({ ok: false, error: 'Ссылка загрузки не найдена или истекла.' });
      }

      const name = String(req.query.name || '').trim().slice(0, 200);
      const extension = (name.split('.').pop() || '').toLowerCase();

      if (!name || !APP_CONFIG.ALLOWED_RESUME_EXTENSIONS.includes(extension)) {
        return res.status(400).json({ ok: false, error: 'Укажите ?name=<файл>.pdf|.doc|.docx' });
      }

      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      if (!buffer.length) {
        return res.status(400).json({ ok: false, error: 'Файл пустой.' });
      }

      if (buffer.length > APP_CONFIG.MAX_RESUME_BYTES) {
        return res.status(413).json({ ok: false, error: 'Размер резюме не должен превышать 10 МБ.' });
      }

      entry.file = { name, mimeType: MIME_BY_EXTENSION[extension], base64: buffer.toString('base64') };
      res.json({ ok: true, uploadId: req.params.token, name, size: buffer.length });
    }
  );

  return router;
}
