// Шифрование секретов настроек в БД: AES-256-GCM, ключ выводится (HKDF-SHA256) из
// SETTINGS_ENCRYPTION_KEY, а если он не задан — из SESSION_SECRET.
// Смена ключа делает сохранённые секреты нечитаемыми: они считаются незаданными
// (действует значение из .env), администратор вводит их заново.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const VERSION = 'v1';

function key() {
  const material = config.settingsEncryptionKey || config.sessionSecret || 'dev-only-insecure-secret';
  return Buffer.from(hkdfSync('sha256', material, 'recruiting-ats', 'app-settings', 32));
}

export function encryptSecret(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

// null — не удалось расшифровать (другой ключ или повреждённые данные).
export function decryptSecret(stored) {
  try {
    const [version, iv, tag, data] = String(stored).split(':');
    if (version !== VERSION) return null;
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
