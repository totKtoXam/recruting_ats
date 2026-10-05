// Шифрование данных в БД: AES-256-GCM, ключ выводится (HKDF-SHA256) из
// SETTINGS_ENCRYPTION_KEY, а если он не задан — из SESSION_SECRET. Для каждого назначения
// (purpose) — свой ключ: секреты настроек и ЗП ожидания кандидатов шифруются разными ключами.
// Смена ключа делает сохранённые значения нечитаемыми: секреты настроек считаются
// незаданными (действует значение из .env), ЗП ожидания — «не расшифровано».
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const VERSION = 'v1';
const keys = new Map();

function key(purpose) {
  const material = config.settingsEncryptionKey || config.sessionSecret || 'dev-only-insecure-secret';
  if (!keys.has(purpose)) {
    keys.set(purpose, Buffer.from(hkdfSync('sha256', material, 'recruiting-ats', purpose, 32)));
  }
  return keys.get(purpose);
}

export function encryptSecret(plain, purpose = 'app-settings') {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(purpose), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

// null — не удалось расшифровать (другой ключ или повреждённые данные).
export function decryptSecret(stored, purpose = 'app-settings') {
  try {
    const [version, iv, tag, data] = String(stored).split(':');
    if (version !== VERSION) return null;
    const decipher = createDecipheriv('aes-256-gcm', key(purpose), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
