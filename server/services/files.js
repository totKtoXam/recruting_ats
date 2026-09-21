import { APP_CONFIG, config } from '../config.js';
import { formatDateTime } from '../lib/dates.js';
import {
  copyFile,
  createFolder,
  findFolder,
  isActiveFolder,
  trashFile,
  uploadFile
} from '../lib/drive.js';
import { fail } from '../lib/errors.js';
import { clean } from '../lib/validation.js';

const MIME_BY_EXTENSION = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

const DRAFTS_FOLDER_NAME = '_ATS_Черновики';

// Проверяет и декодирует файл резюме из формата UI/API: { name, mimeType, base64 }.
export function decodeResumeUpload(file) {
  if (!file || !file.base64) {
    fail('Файл резюме не передан.');
  }

  const name = clean(file.name) || 'resume';
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';

  if (!APP_CONFIG.ALLOWED_RESUME_EXTENSIONS.includes(extension)) {
    fail('Допустимые форматы резюме: PDF, DOC, DOCX.');
  }

  const base64 = String(file.base64).replace(/^data:[^,]*,/, '');

  // Оценка размера до декодирования, чтобы не выделять память под огромный буфер.
  if (Math.floor((base64.length * 3) / 4) > APP_CONFIG.MAX_RESUME_BYTES + 3) {
    fail('Размер резюме не должен превышать 10 МБ.');
  }

  const buffer = Buffer.from(base64, 'base64');

  if (!buffer.length) {
    fail('Файл резюме пустой.');
  }

  if (buffer.length > APP_CONFIG.MAX_RESUME_BYTES) {
    fail('Размер резюме не должен превышать 10 МБ.');
  }

  return {
    buffer,
    name,
    mimeType: MIME_BY_EXTENSION[extension]
  };
}

// Имя папки кандидата, как в исходной версии: "<ФИО> - <первые 8 символов ID>".
export function candidateFolderName(candidateId, fullName) {
  const safeName = (clean(fullName) || 'Кандидат').replace(/[\\/:*?"<>|]/g, '_');
  const shortId = candidateId.replace(/-/g, '').substring(0, 8).toUpperCase();
  return `${safeName} - ${shortId}`;
}

// Drive допускает одинаковые имена, поэтому метка времени нужна только для читаемости.
function versionedName(originalName) {
  return formatDateTime(new Date()).replace(/[: ]/g, '-') + ' - ' + originalName;
}

// Отслеживает файлы и папки, созданные текущим запросом, чтобы убрать их в корзину при ошибке.
// Операции с Drive выполняются до транзакции БД и не держат блокировки строк.
export class UploadTracker {
  constructor() {
    this.createdIds = [];
  }

  track(id) {
    this.createdIds.push(id);
    return id;
  }

  async rollback() {
    await Promise.allSettled(this.createdIds.reverse().map(id => trashFile(id)));
  }
}

// Возвращает активную папку кандидата; пересоздаёт её, если папку удалили в Drive.
export async function ensureCandidateFolder(tracker, candidateId, fullName, existingFolderId) {
  if (await isActiveFolder(existingFolderId)) {
    return existingFolderId;
  }

  const name = candidateFolderName(candidateId, fullName);
  const found = await findFolder(name, config.drive.rootFolderId);

  return found || tracker.track(await createFolder(name, config.drive.rootFolderId));
}

let draftsFolderPromise = null;

function getDraftsFolder() {
  draftsFolderPromise ||= (async () => {
    const root = config.drive.rootFolderId;
    return (await findFolder(DRAFTS_FOLDER_NAME, root)) || createFolder(DRAFTS_FOLDER_NAME, root);
  })().catch(error => {
    draftsFolderPromise = null;
    throw error;
  });

  return draftsFolderPromise;
}

export async function uploadCandidateResume(tracker, folderId, upload) {
  const driveFileId = tracker.track(
    await uploadFile(folderId, versionedName(upload.name), upload.buffer, upload.mimeType)
  );

  return { driveFileId, name: upload.name, mimeType: upload.mimeType, size: upload.buffer.length };
}

export async function uploadDraftResume(tracker, token, upload) {
  const folderId = await getDraftsFolder();
  const driveFileId = tracker.track(
    await uploadFile(folderId, `${token.substring(0, 8)} - ${upload.name}`, upload.buffer, upload.mimeType)
  );

  return { driveFileId, name: upload.name, mimeType: upload.mimeType, size: upload.buffer.length };
}

export async function copyFileToCandidate(tracker, sourceFile, folderId) {
  const driveFileId = tracker.track(
    await copyFile(sourceFile.drive_file_id, folderId, versionedName(sourceFile.original_name))
  );

  return {
    driveFileId,
    name: sourceFile.original_name,
    mimeType: sourceFile.mime_type,
    size: sourceFile.size_bytes
  };
}

// Регистрирует загруженный в Drive файл в таблице files.
export function insertFile(executor, { driveFileId, name, mimeType, size }) {
  return executor.one(
    `INSERT INTO files (drive_file_id, original_name, mime_type, size_bytes)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [driveFileId, name, mimeType, size]
  );
}
