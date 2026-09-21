function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function list(name) {
  return env(name)
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

export const APP_CONFIG = Object.freeze({
  DEFAULT_STATUSES: Object.freeze([
    'Новый',
    'HR screening',
    'Техническое интервью',
    'Финальное интервью',
    'Offer',
    'Hired',
    'Отказ'
  ]),

  PIPELINE_STATUSES: Object.freeze([
    'Новый',
    'HR screening',
    'Техническое интервью',
    'Финальное интервью',
    'Offer',
    'Hired'
  ]),

  VACANCY_STATUSES: Object.freeze(['Открыта', 'На паузе', 'Закрыта']),

  TRANSITIONS: Object.freeze({
    'Новый': ['HR screening'],
    'HR screening': ['Новый', 'Техническое интервью'],
    'Техническое интервью': ['HR screening', 'Финальное интервью'],
    'Финальное интервью': ['Техническое интервью', 'Offer'],
    'Offer': ['Финальное интервью', 'Hired'],
    'Hired': ['Offer']
  }),

  MAX_RESUME_BYTES: 10 * 1024 * 1024,
  ALLOWED_RESUME_EXTENSIONS: Object.freeze(['pdf', 'doc', 'docx']),
  DRAFT_TTL_DAYS: 7,
  LAST_LOGIN_THROTTLE_MINUTES: 30
});

export const config = Object.freeze({
  env: env('NODE_ENV', 'development'),
  port: Number(env('PORT', '3000')),
  publicUrl: env('PUBLIC_URL', 'http://localhost:3000').replace(/\/$/, ''),
  timeZone: env('APP_TIMEZONE', 'Asia/Almaty'),
  trustProxy: env('TRUST_PROXY', 'false') === 'true',

  databaseUrl: env('DATABASE_URL', 'postgres://ats:ats@localhost:5432/ats'),
  databaseSsl: env('DATABASE_SSL', 'false') === 'true',

  sessionSecret: env('SESSION_SECRET'),
  sessionMaxAgeDays: Number(env('SESSION_MAX_AGE_DAYS', '14')),

  auth: Object.freeze({
    // google | dev
    mode: env('AUTH_MODE', 'google'),
    googleClientId: env('GOOGLE_CLIENT_ID'),
    googleClientSecret: env('GOOGLE_CLIENT_SECRET'),
    allowedDomains: list('AUTH_ALLOWED_DOMAINS'),
    allowedEmails: list('AUTH_ALLOWED_EMAILS')
  }),

  drive: Object.freeze({
    // oauth — от имени Google-аккаунта-владельца (refresh token), подходит для обычного Gmail;
    // service_account — сервисный аккаунт, только с общим диском (Shared Drive) Google Workspace.
    auth: env('GOOGLE_DRIVE_AUTH', 'oauth'),
    // Папка «Кандидаты»: в ней создаются папки кандидатов и папка черновиков.
    rootFolderId: env('GOOGLE_DRIVE_ROOT_FOLDER_ID'),
    // OAuth-клиент по умолчанию тот же, что и для входа в приложение.
    clientId: env('GOOGLE_DRIVE_CLIENT_ID', env('GOOGLE_CLIENT_ID')),
    clientSecret: env('GOOGLE_DRIVE_CLIENT_SECRET', env('GOOGLE_CLIENT_SECRET')),
    refreshToken: env('GOOGLE_DRIVE_REFRESH_TOKEN'),
    // JSON-ключ сервисного аккаунта строкой; альтернатива — GOOGLE_APPLICATION_CREDENTIALS (путь к файлу).
    serviceAccountKey: env('GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY'),
    // Только для тестов с эмулятором Drive API (в production запрещено).
    apiUrl: env('GOOGLE_DRIVE_API_URL')
  }),

  intakeApiKey: env('ATS_API_KEY')
});

export function assertProductionConfig() {
  if (config.env !== 'production') {
    return;
  }

  const problems = [];

  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    problems.push('SESSION_SECRET должен быть не короче 32 символов.');
  }

  if (config.auth.mode === 'dev') {
    problems.push('AUTH_MODE=dev запрещён в production.');
  }

  if (
    config.auth.mode === 'google' &&
    (!config.auth.googleClientId || !config.auth.googleClientSecret)
  ) {
    problems.push('Не заданы GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.');
  }

  if (!config.auth.allowedDomains.length && !config.auth.allowedEmails.length) {
    problems.push('Задайте AUTH_ALLOWED_DOMAINS и/или AUTH_ALLOWED_EMAILS: без allowlist войти смог бы любой Google Account.');
  }

  if (config.drive.apiUrl) {
    problems.push('GOOGLE_DRIVE_API_URL предназначен только для тестов.');
  }

  if (problems.length) {
    throw new Error('Некорректная конфигурация:\n- ' + problems.join('\n- '));
  }
}
