// Вложения к вопросам шаблонов и к ответам интервью.
//
// Файл загружается отдельным вызовом (uploadAttachment) сразу после выбора в форме и попадает
// в папку «_ATS_Вложения» в Google Drive; форма сохраняет только ссылки { id }. При сохранении
// сервер проверяет ссылки, подставляет имя/тип/размер из БД и отмечает файл использованным
// (linked_at). Файлы, на которые так и не сослались (форму закрыли без сохранения), удаляются
// фоновой очисткой. Использованные файлы не удаляются: на них ссылаются журнал изменений и откат.
import { APP_CONFIG, config } from '../config.js';
import { db } from '../db/pool.js';
import { formatDateTime } from '../lib/dates.js';
import { createFolder, findFolder, trashFile, uploadFile } from '../lib/drive.js';
import { fail } from '../lib/errors.js';
import { clean } from '../lib/validation.js';
import { attachmentOut, normalizeAttachmentRefs } from './mappers.js';

const FOLDER_NAME = '_ATS_Вложения';
const MAX_MB = Math.round(APP_CONFIG.MAX_ATTACHMENT_BYTES / 1024 / 1024);
// Сколько живёт загруженный, но не сохранённый в форме файл.
const UNLINKED_TTL_HOURS = 48;

const extensionOf = name => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');

// Проверяет и декодирует файл из формата UI/API: { name, mimeType, base64 }.
// Тип файла определяется по расширению — mimeType клиента не используется.
export function decodeAttachmentUpload(file) {
  if (!file || typeof file !== 'object' || !file.base64) {
    fail('Файл не передан.');
  }

  const name = clean(file.name).replace(/[\\/]/g, '_').slice(0, 200);
  const mimeType = APP_CONFIG.ATTACHMENT_MIME_TYPES[extensionOf(name)];

  if (!name || !mimeType) {
    fail(
      'Недопустимый формат файла. Можно: ' +
        Object.keys(APP_CONFIG.ATTACHMENT_MIME_TYPES).join(', ').toUpperCase() + '.'
    );
  }

  const base64 = String(file.base64).replace(/^data:[^,]*,/, '');

  // Оценка размера до декодирования, чтобы не выделять память под огромный буфер.
  if (Math.floor((base64.length * 3) / 4) > APP_CONFIG.MAX_ATTACHMENT_BYTES + 3) {
    fail(`Размер файла не должен превышать ${MAX_MB} МБ.`);
  }

  const buffer = Buffer.from(base64, 'base64');

  if (!buffer.length) {
    fail('Файл пустой.');
  }

  if (buffer.length > APP_CONFIG.MAX_ATTACHMENT_BYTES) {
    fail(`Размер файла не должен превышать ${MAX_MB} МБ.`);
  }

  return { buffer, name, mimeType };
}

let folderPromise = null;

function getAttachmentsFolder() {
  folderPromise ||= (async () => {
    const root = config.drive.rootFolderId;
    return (await findFolder(FOLDER_NAME, root)) || createFolder(FOLDER_NAME, root);
  })().catch(error => {
    folderPromise = null;
    throw error;
  });

  return folderPromise;
}

const toRef = row => ({ id: row.id, name: row.original_name, mimeType: row.mime_type, size: row.size_bytes === null ? null : Number(row.size_bytes) });

// RPC: загружает файл и возвращает ссылку { id, name, mimeType, size, url } для формы.
export async function uploadAttachment(input, user) {
  const upload = decodeAttachmentUpload(input);
  const folderId = await getAttachmentsFolder();
  const driveName = formatDateTime(new Date()).replace(/[: ]/g, '-') + ' - ' + upload.name;
  const driveFileId = await uploadFile(folderId, driveName, upload.buffer, upload.mimeType);

  try {
    const row = await db.one(
      `INSERT INTO files (drive_file_id, original_name, mime_type, size_bytes, purpose, uploaded_by)
       VALUES ($1, $2, $3, $4, 'attachment', $5) RETURNING *`,
      [driveFileId, upload.name, upload.mimeType, upload.buffer.length, user ? user.id : null]
    );
    return { ok: true, file: attachmentOut(toRef(row)) };
  } catch (error) {
    await trashFile(driveFileId).catch(() => {});
    throw error;
  }
}

// Заменяет ссылки на вложения у элементов (вопросов или ответов) данными из БД и отмечает файлы
// использованными. Неизвестный id или файл другого назначения (резюме) — ошибка.
// Пустой массив files убирается, чтобы не хранить лишнее.
export async function resolveAttachments(executor, items) {
  const ids = [...new Set(items.flatMap(item => normalizeAttachmentRefs(item.files).map(file => file.id)))];
  const known = new Map();

  if (ids.length) {
    // FOR UPDATE: очистка неиспользованных файлов дождётся транзакции и увидит linked_at.
    const rows = await executor.many(
      `SELECT id, original_name, mime_type, size_bytes FROM files
       WHERE id = ANY($1::uuid[]) AND purpose = 'attachment'
       FOR UPDATE`,
      [ids]
    );

    for (const row of rows) known.set(row.id, toRef(row));

    if (known.size !== ids.length) {
      fail('Вложение не найдено — загрузите файл заново.');
    }

    await executor.query(
      'UPDATE files SET linked_at = now() WHERE id = ANY($1::uuid[]) AND linked_at IS NULL',
      [ids]
    );
  }

  return items.map(item => {
    const { files, ...rest } = item;
    const refs = normalizeAttachmentRefs(files);
    return refs.length ? { ...rest, files: refs.map(file => known.get(file.id)) } : rest;
  });
}

// Элементы без ключа files (например, из MCP-клиента, который вложения не передаёт)
// сохраняют прежние вложения элемента с тем же ключом (текст вопроса). Пропущенный ответ — без файлов.
export function keepPreviousAttachments(items, previous, keyOf) {
  const byKey = new Map();
  for (const item of Array.isArray(previous) ? previous : []) {
    const key = keyOf(item);
    if (item && Array.isArray(item.files) && item.files.length && !byKey.has(key)) byKey.set(key, item.files);
  }
  return items.map(item =>
    Array.isArray(item.files) || item.skipped || !byKey.has(keyOf(item)) ? item : { ...item, files: byKey.get(keyOf(item)) }
  );
}

// Удаляет загруженные, но так и не сохранённые в форме вложения (и их файлы в Drive).
export async function cleanupUnlinkedAttachments() {
  const rows = await db.many(
    `DELETE FROM files
     WHERE purpose = 'attachment' AND linked_at IS NULL
       AND created_at < now() - make_interval(hours => $1)
     RETURNING drive_file_id`,
    [UNLINKED_TTL_HOURS]
  );

  for (const row of rows) {
    if (row.drive_file_id) await trashFile(row.drive_file_id).catch(() => {});
  }

  return { ok: true, removed: rows.length };
}
