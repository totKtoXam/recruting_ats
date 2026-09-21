import { Readable } from 'node:stream';
import { auth, drive as createDrive } from '@googleapis/drive';
import { config } from '../config.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SCOPES = ['https://www.googleapis.com/auth/drive'];

// Общие параметры: поддержка общих дисков (Shared Drives) Google Workspace.
const ALL_DRIVES = { supportsAllDrives: true };

function createAuthClient() {
  const settings = config.drive;

  if (settings.auth === 'service_account') {
    return new auth.GoogleAuth({
      credentials: settings.serviceAccountKey ? JSON.parse(settings.serviceAccountKey) : undefined,
      scopes: SCOPES
    });
  }

  if (settings.auth === 'none') {
    // Только для эмулятора Drive API в тестах.
    if (!settings.apiUrl) {
      throw new Error('GOOGLE_DRIVE_AUTH=none допустим только вместе с GOOGLE_DRIVE_API_URL.');
    }
    return undefined;
  }

  if (!settings.clientId || !settings.clientSecret || !settings.refreshToken) {
    throw new Error(
      'Google Drive не настроен: нужны GOOGLE_DRIVE_REFRESH_TOKEN и OAuth-клиент ' +
        '(GOOGLE_CLIENT_ID/SECRET). Получить токен: npm run drive:auth'
    );
  }

  const client = new auth.OAuth2(settings.clientId, settings.clientSecret);
  client.setCredentials({ refresh_token: settings.refreshToken });
  return client;
}

let driveClient = null;

function drive() {
  driveClient ||= createDrive({
    version: 'v3',
    auth: createAuthClient(),
    rootUrl: config.drive.apiUrl || undefined
  });
  return driveClient;
}

// Экранирование строкового литерала в языке запросов Drive (q).
const quote = value => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function isNotFound(error) {
  const status = error?.code ?? error?.status ?? error?.response?.status;
  return Number(status) === 404;
}

// Проверяет при старте, что корневая папка доступна приложению.
export async function verifyDriveAccess() {
  if (!config.drive.rootFolderId) {
    throw new Error('Не задан GOOGLE_DRIVE_ROOT_FOLDER_ID (ID папки «Кандидаты» в Google Drive).');
  }

  try {
    const { data } = await drive().files.get({
      fileId: config.drive.rootFolderId,
      fields: 'id, name, mimeType, trashed',
      ...ALL_DRIVES
    });

    if (data.mimeType !== FOLDER_MIME || data.trashed) {
      throw new Error('GOOGLE_DRIVE_ROOT_FOLDER_ID указывает не на папку или папка в корзине.');
    }

    return data;
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(
        'Папка GOOGLE_DRIVE_ROOT_FOLDER_ID не найдена или у аккаунта приложения нет к ней доступа.'
      );
    }
    throw error;
  }
}

export async function isActiveFolder(folderId) {
  if (!folderId) {
    return false;
  }

  try {
    const { data } = await drive().files.get({
      fileId: folderId,
      fields: 'id, mimeType, trashed',
      ...ALL_DRIVES
    });
    return data.mimeType === FOLDER_MIME && !data.trashed;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

export async function createFolder(name, parentId) {
  const { data } = await drive().files.create({
    requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
    fields: 'id',
    ...ALL_DRIVES
  });
  return data.id;
}

export async function findFolder(name, parentId) {
  const { data } = await drive().files.list({
    q: `name = ${quote(name)} and ${quote(parentId)} in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
    includeItemsFromAllDrives: true,
    ...ALL_DRIVES
  });
  return data.files && data.files[0] ? data.files[0].id : null;
}

export async function uploadFile(folderId, name, buffer, mimeType) {
  const { data } = await drive().files.create(
    {
      requestBody: { name, parents: [folderId] },
      media: { mimeType, body: Readable.from(buffer) },
      fields: 'id',
      ...ALL_DRIVES
    },
    // URL media-загрузки библиотека строит без учёта глобального rootUrl.
    config.drive.apiUrl ? { rootUrl: config.drive.apiUrl } : {}
  );
  return data.id;
}

export async function copyFile(fileId, folderId, name) {
  const { data } = await drive().files.copy({
    fileId,
    requestBody: { name, parents: [folderId] },
    fields: 'id',
    ...ALL_DRIVES
  });
  return data.id;
}

// Файлы не удаляются безвозвратно, а переносятся в корзину Drive (как в исходной версии).
export async function trashFile(fileId) {
  await drive().files.update({
    fileId,
    requestBody: { trashed: true },
    ...ALL_DRIVES
  });
}

export async function getFileMeta(fileId) {
  const { data } = await drive().files.get({
    fileId,
    fields: 'id, name, mimeType, webViewLink, trashed',
    ...ALL_DRIVES
  });
  return data;
}

export async function downloadStream(fileId) {
  const response = await drive().files.get(
    { fileId, alt: 'media', ...ALL_DRIVES },
    { responseType: 'stream' }
  );
  return response.data;
}

export const driveFolderUrl = folderId =>
  folderId ? `https://drive.google.com/drive/folders/${folderId}` : '';

export const DRIVE_FOLDER_MIME = FOLDER_MIME;
