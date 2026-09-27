// Настройки интеграций, которые администратор меняет в интерфейсе без перезапуска:
// вход через Google, SMTP (email-уведомления), Telegram-бот.
//
// Значение из БД (app_settings) важнее переменной окружения; «Сбросить к .env» удаляет
// переопределения группы. Секреты хранятся зашифрованными и наружу не отдаются —
// только признак «задан» и последние символы.
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { db, transaction } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import { decryptSecret, encryptSecret } from '../lib/secretbox.js';
import { isoOrEmpty } from '../lib/dates.js';
import { clean, validateEmail } from '../lib/validation.js';
import { userDisplayName } from './mappers.js';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const googleRedirectUri = () => `${config.publicUrl}/auth/google/callback`;

const splitList = value =>
  [...new Set(String(value ?? '').split(/[\s,;]+/).map(item => item.trim().toLowerCase()).filter(Boolean))];

// type: text | secret | number | bool | list
export const FIELDS = {
  'auth.googleClientId': {
    group: 'auth', type: 'text', env: 'GOOGLE_CLIENT_ID', label: 'Client ID',
    placeholder: '1234567890-abc.apps.googleusercontent.com',
    envValue: () => config.auth.googleClientId
  },
  'auth.googleClientSecret': {
    group: 'auth', type: 'secret', env: 'GOOGLE_CLIENT_SECRET', label: 'Client secret',
    envValue: () => config.auth.googleClientSecret
  },
  'auth.allowedDomains': {
    group: 'auth', type: 'list', env: 'AUTH_ALLOWED_DOMAINS', label: 'Домены с автоматическим доступом',
    placeholder: 'company.kz, partner.com',
    hint: 'Пользователи с email на этих доменах получают доступ сразу при первом входе. Пусто — доступ выдаёт администратор.',
    envValue: () => config.auth.allowedDomains
  },
  'auth.allowedEmails': {
    group: 'auth', type: 'list', env: 'AUTH_ALLOWED_EMAILS', label: 'Email с автоматическим доступом',
    placeholder: 'name@gmail.com',
    envValue: () => config.auth.allowedEmails
  },

  'smtp.host': {
    group: 'smtp', type: 'text', env: 'SMTP_HOST', label: 'SMTP-сервер', placeholder: 'smtp.gmail.com',
    envValue: () => config.smtp.host
  },
  'smtp.port': {
    group: 'smtp', type: 'number', env: 'SMTP_PORT', label: 'Порт', placeholder: '465',
    envValue: () => config.smtp.port
  },
  'smtp.secure': {
    group: 'smtp', type: 'bool', env: 'SMTP_SECURE', label: 'TLS сразу (порт 465)',
    hint: 'Выключено — STARTTLS (обычно порт 587).',
    envValue: () => config.smtp.secure
  },
  'smtp.user': {
    group: 'smtp', type: 'text', env: 'SMTP_USER', label: 'Логин', placeholder: 'noreply@company.kz',
    envValue: () => config.smtp.user
  },
  'smtp.pass': {
    group: 'smtp', type: 'secret', env: 'SMTP_PASS', label: 'Пароль',
    hint: 'Для Google Workspace — пароль приложения (Аккаунт Google → Безопасность → Пароли приложений).',
    envValue: () => config.smtp.pass
  },
  'smtp.from': {
    group: 'smtp', type: 'text', env: 'MAIL_FROM', label: 'Отправитель',
    placeholder: 'Recruiting ATS <noreply@company.kz>',
    envValue: () => config.smtp.from
  },

  'telegram.botToken': {
    group: 'telegram', type: 'secret', env: 'TELEGRAM_BOT_TOKEN', label: 'Токен бота',
    hint: 'Telegram → @BotFather → /newbot. Токен вида 123456789:AA…',
    envValue: () => config.telegram.botToken
  },
  'telegram.polling': {
    group: 'telegram', type: 'bool', env: 'TELEGRAM_POLLING', label: 'Принимать сообщения бота (long polling)',
    hint: 'Нужно для привязки аккаунтов. Выключите на всех экземплярах приложения, кроме одного.',
    envValue: () => config.telegram.polling
  }
};

export const GROUPS = {
  auth: {
    title: 'Вход через Google',
    description: 'OAuth-клиент для входа в ATS и правила автоматического доступа.'
  },
  smtp: {
    title: 'Эл. почта (SMTP)',
    description: 'Отправка email-уведомлений.'
  },
  telegram: {
    title: 'Telegram-бот',
    description: 'Привязка Telegram пользователей и уведомления в Telegram.'
  }
};

// ---------- Кэш значений ----------

// key → { value, encrypted, broken, updatedAt, updatedBy }
let cache = new Map();
const listeners = { auth: [], smtp: [], telegram: [] };

export function onSettingsChanged(group, listener) {
  listeners[group].push(listener);
}

function parseStored(field, raw) {
  switch (field.type) {
    case 'number': return Number(raw);
    case 'bool': return raw === 'true';
    case 'list': return splitList(raw);
    default: return raw;
  }
}

export async function loadSettings() {
  const rows = await db.many(
    `SELECT s.*, u.last_name, u.first_name, u.middle_name, u.full_name, u.email AS updated_by_email
     FROM app_settings s LEFT JOIN users u ON u.id = s.updated_by`
  );
  const next = new Map();

  for (const row of rows) {
    const field = FIELDS[row.key];
    if (!field) continue;
    const raw = row.encrypted ? decryptSecret(row.value) : row.value;

    if (raw === null) {
      console.error(`Настройки: не удалось расшифровать ${row.key} — действует значение из .env. Введите его заново.`);
    }

    next.set(row.key, {
      value: raw === null ? undefined : parseStored(field, raw),
      broken: raw === null,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by ? userDisplayName({ ...row, email: row.updated_by_email }) : ''
    });
  }

  cache = next;
}

function value(key) {
  const entry = cache.get(key);
  return entry && !entry.broken ? entry.value : FIELDS[key].envValue();
}

// Действующие значения — их читают вход, отправка почты и бот.
export const runtime = {
  auth: () => ({
    mode: config.auth.mode,
    googleClientId: value('auth.googleClientId'),
    googleClientSecret: value('auth.googleClientSecret'),
    allowedDomains: value('auth.allowedDomains'),
    allowedEmails: value('auth.allowedEmails'),
    // Администраторы из .env — страховка от потери доступа, в интерфейсе не меняются.
    adminEmails: config.auth.adminEmails
  }),
  smtp: () => {
    const user = value('smtp.user');
    return {
      host: value('smtp.host'),
      port: value('smtp.port'),
      secure: value('smtp.secure'),
      user,
      pass: value('smtp.pass'),
      from: value('smtp.from') || user
    };
  },
  telegram: () => ({
    botToken: value('telegram.botToken'),
    polling: value('telegram.polling'),
    apiUrl: config.telegram.apiUrl
  })
};

// ---------- Для администратора ----------

function requireAdminUser(actor) {
  if (!actor || !actor.is_admin) fail('Доступно только администраторам.', 403);
}

const secretHint = secret => (secret ? '••••' + String(secret).slice(-4) : '');

function describeField(key) {
  const field = FIELDS[key];
  const entry = cache.get(key);
  const fromDb = Boolean(entry && !entry.broken);
  const envValue = field.envValue();
  const envSet = field.type === 'bool' ? process.env[field.env] !== undefined && process.env[field.env] !== ''
    : Array.isArray(envValue) ? envValue.length > 0 : Boolean(envValue);
  const current = value(key);

  const result = {
    key,
    label: field.label,
    type: field.type,
    env: field.env,
    hint: field.hint || '',
    placeholder: field.placeholder || '',
    // default — переменная не задана, но у поля есть значение по умолчанию (порт, переключатели).
    source: fromDb ? 'db' : envSet ? 'env' : field.type === 'bool' || field.type === 'number' ? 'default' : 'none',
    broken: Boolean(entry && entry.broken)
  };

  if (field.type === 'secret') {
    result.isSet = Boolean(current);
    result.hintValue = secretHint(current);
  } else {
    result.value = Array.isArray(current) ? current.join(', ') : current ?? '';
  }

  return result;
}

export function getIntegrationSettings(_input, actor) {
  requireAdminUser(actor);

  return {
    groups: Object.entries(GROUPS).map(([key, group]) => {
      const keys = Object.keys(FIELDS).filter(fieldKey => FIELDS[fieldKey].group === key);
      const updated = keys
        .map(fieldKey => cache.get(fieldKey))
        .filter(Boolean)
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];

      return {
        key,
        ...group,
        fields: keys.map(describeField),
        overridden: keys.some(fieldKey => cache.has(fieldKey)),
        updatedAt: updated ? isoOrEmpty(updated.updatedAt) : '',
        updatedBy: updated ? updated.updatedBy : ''
      };
    }),
    info: {
      authMode: config.auth.mode,
      redirectUri: googleRedirectUri(),
      javascriptOrigin: config.publicUrl,
      adminEmails: config.auth.adminEmails,
      encryptionKey: config.settingsEncryptionKey ? 'SETTINGS_ENCRYPTION_KEY' : config.sessionSecret ? 'SESSION_SECRET' : 'dev'
    }
  };
}

// Нормализация и проверка введённого значения. undefined — «не менять».
function normalizeInput(key, raw) {
  const field = FIELDS[key];

  if (field.type === 'secret') {
    const secret = clean(raw);
    return secret ? secret : undefined; // пустое поле секрета — оставить как есть
  }

  if (field.type === 'bool') return raw === true || raw === 'true';

  if (field.type === 'number') {
    const number = Number(raw);
    if (!Number.isInteger(number) || number < 1 || number > 65535) fail(`${field.label}: укажите число от 1 до 65535.`);
    return number;
  }

  if (field.type === 'list') {
    const items = splitList(raw);
    if (key === 'auth.allowedDomains') {
      const bad = items.find(item => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(item));
      if (bad) fail(`Некорректный домен: ${bad}`);
    }
    if (key === 'auth.allowedEmails') items.forEach(item => validateEmail(item));
    return items;
  }

  return clean(raw);
}

function serialize(field, normalized) {
  if (field.type === 'list') return normalized.join(',');
  return String(normalized);
}

function validateGroup(group, merged) {
  if (group === 'auth') {
    if (config.auth.mode === 'google' && (!merged['auth.googleClientId'] || !merged['auth.googleClientSecret'])) {
      fail('Для входа через Google нужны Client ID и Client secret.');
    }
    if (merged['auth.googleClientId'] && !/\.apps\.googleusercontent\.com$/.test(merged['auth.googleClientId'])) {
      fail('Client ID должен оканчиваться на .apps.googleusercontent.com');
    }
  }

  if (group === 'smtp' && merged['smtp.host']) {
    if (!/^[A-Za-z0-9.-]+$/.test(merged['smtp.host'])) fail('SMTP-сервер: укажите имя хоста, например smtp.gmail.com');
    if (!merged['smtp.from'] && !merged['smtp.user']) fail('Укажите отправителя или логин.');
    const from = merged['smtp.from'] || merged['smtp.user'];
    const address = (from.match(/<([^>]+)>/) || [null, from])[1];
    validateEmail(address);
  }

  if (group === 'telegram' && merged['telegram.botToken'] && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(merged['telegram.botToken'])) {
    fail('Токен бота должен иметь вид 123456789:AA… (выдаёт @BotFather).');
  }
}

// Значения группы с учётом введённых (ещё не сохранённых) изменений.
function mergeGroup(group, values = {}) {
  const merged = {};
  const changes = {};

  for (const key of Object.keys(FIELDS).filter(fieldKey => FIELDS[fieldKey].group === group)) {
    const normalized = Object.prototype.hasOwnProperty.call(values, key) ? normalizeInput(key, values[key]) : undefined;
    if (normalized !== undefined) changes[key] = normalized;
    merged[key] = normalized !== undefined ? normalized : value(key);
  }

  return { merged, changes };
}

function assertGroup(group) {
  if (!GROUPS[group]) fail('Неизвестная группа настроек.');
}

// ---------- Проверки подключения ----------

// Проверка пары Client ID / secret без входа: обмен заведомо неверного кода.
// Google отвечает invalid_grant, если клиент настоящий, и invalid_client — если нет.
export async function verifyGoogleClient(clientId, clientSecret) {
  let response;
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: 'ats-credentials-check',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: googleRedirectUri(),
        grant_type: 'authorization_code'
      }),
      signal: AbortSignal.timeout(10_000)
    });
  } catch (error) {
    fail('Не удалось связаться с Google для проверки: ' + error.message);
  }

  const data = await response.json().catch(() => ({}));

  if (data.error === 'invalid_grant') return { ok: true, message: 'Google принял Client ID и Client secret.' };
  if (data.error === 'invalid_client' || data.error === 'unauthorized_client') {
    fail('Google отклонил Client ID или Client secret (' + data.error + '). Проверьте значения в Google Cloud Console.');
  }
  if (data.error === 'redirect_uri_mismatch') {
    fail('Клиент настоящий, но в нём не указан Redirect URI ' + googleRedirectUri() + ' (Google Cloud Console → Clients → Authorized redirect URIs).');
  }
  fail('Неожиданный ответ Google: ' + (data.error_description || data.error || response.status));
}

async function testSmtp(merged, actor) {
  if (!merged['smtp.host']) fail('Укажите SMTP-сервер.');

  const transport = nodemailer.createTransport({
    host: merged['smtp.host'],
    port: merged['smtp.port'],
    secure: merged['smtp.secure'],
    auth: merged['smtp.user'] ? { user: merged['smtp.user'], pass: merged['smtp.pass'] } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000
  });

  try {
    await transport.verify();
    await transport.sendMail({
      from: merged['smtp.from'] || merged['smtp.user'],
      to: actor.email,
      subject: 'Recruiting ATS: проверка SMTP',
      text: 'Это тестовое письмо из «Настройки → Интеграции». Если вы его видите — email-уведомления настроены.'
    });
  } catch (error) {
    fail('SMTP: ' + error.message);
  } finally {
    transport.close();
  }

  return { ok: true, message: `Тестовое письмо отправлено на ${actor.email}.` };
}

async function testTelegram(merged) {
  const token = merged['telegram.botToken'];
  if (!token) fail('Укажите токен бота.');

  let data;
  try {
    const response = await fetch(`${config.telegram.apiUrl}/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
    data = await response.json();
  } catch (error) {
    fail('Не удалось связаться с Telegram: ' + error.message);
  }

  if (!data.ok) fail('Telegram отклонил токен: ' + (data.description || 'ошибка'));
  return { ok: true, message: `Бот @${data.result.username} доступен.`, botUsername: data.result.username };
}

export async function testIntegration({ group, values } = {}, actor) {
  requireAdminUser(actor);
  assertGroup(group);
  const { merged } = mergeGroup(group, values);
  validateGroup(group, merged);

  if (group === 'auth') return verifyGoogleClient(merged['auth.googleClientId'], merged['auth.googleClientSecret']);
  if (group === 'smtp') return testSmtp(merged, actor);
  return testTelegram(merged);
}

// ---------- Сохранение ----------

async function notify(group) {
  for (const listener of listeners[group]) {
    try {
      await listener(runtime[group]());
    } catch (error) {
      console.error(`Настройки ${group}: ошибка применения:`, error.message);
    }
  }
}

export async function saveIntegration({ group, values } = {}, actor) {
  requireAdminUser(actor);
  assertGroup(group);
  const { merged, changes } = mergeGroup(group, values);
  validateGroup(group, merged);

  // Неверный OAuth-клиент закрыл бы вход всем, включая администраторов, — сохраняем только проверенный.
  if (group === 'auth' && ('auth.googleClientId' in changes || 'auth.googleClientSecret' in changes) && config.auth.mode === 'google') {
    await verifyGoogleClient(merged['auth.googleClientId'], merged['auth.googleClientSecret']);
  }

  await transaction(async tx => {
    for (const [key, normalized] of Object.entries(changes)) {
      const field = FIELDS[key];
      const secret = field.type === 'secret';
      const raw = serialize(field, normalized);

      await tx.query(
        `INSERT INTO app_settings (key, value, encrypted, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, encrypted = EXCLUDED.encrypted,
           updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [key, secret ? encryptSecret(raw) : raw, secret, actor.id]
      );
    }
  });

  await loadSettings();
  await notify(group);
  return getIntegrationSettings(null, actor);
}

// «Сбросить к .env»: удалить переопределения группы.
export async function resetIntegration({ group } = {}, actor) {
  requireAdminUser(actor);
  assertGroup(group);

  if (group === 'auth' && config.auth.mode === 'google' && (!config.auth.googleClientId || !config.auth.googleClientSecret)) {
    fail('В .env не заданы GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — после сброса войти будет невозможно.');
  }

  await db.query('DELETE FROM app_settings WHERE key LIKE $1', [group + '.%']);
  await loadSettings();
  await notify(group);
  return getIntegrationSettings(null, actor);
}

// Проверка при старте (после loadSettings): без OAuth-клиента в production никто не войдёт.
export function assertAuthConfigured() {
  const auth = runtime.auth();
  if (config.env === 'production' && auth.mode === 'google' && (!auth.googleClientId || !auth.googleClientSecret)) {
    throw new Error('Не заданы GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (ни в .env, ни в настройках ATS).');
  }
}
