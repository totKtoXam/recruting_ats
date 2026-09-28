function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

// BASE_PATH: префикс, под которым приложение открыто за reverse proxy (например, /hr-ats).
// Пустая строка — приложение в корне домена.
export function normalizeBasePath(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');

  if (!trimmed) {
    return '';
  }

  const withSlash = trimmed.startsWith('/') ? trimmed : '/' + trimmed;

  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(withSlash)) {
    throw new Error('Некорректный BASE_PATH: "' + value + '". Пример: /hr-ats');
  }

  return withSlash;
}

function list(name) {
  return env(name)
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

const PROF_INTERVIEW = 'Проф. интервью';
const REJECTED = 'Отказано';

export const APP_CONFIG = Object.freeze({
  PROF_INTERVIEW_STATUS: PROF_INTERVIEW,

  // Этапы воронки: доступы ответственных и шаблоны интервью привязываются к ним.
  PIPELINE_STATUSES: Object.freeze([
    'Новый',
    'HR screening',
    PROF_INTERVIEW,
    'Финальное интервью',
    'Offer',
    'Hired'
  ]),

  // В «Отказано» можно перевести с любого этапа воронки; вернуть — только
  // на этап, с которого отказали (candidates.rejected_from_status).
  REJECTED_STATUS: REJECTED,

  VACANCY_STATUSES: Object.freeze(['Открыта', 'На паузе', 'Закрыта']),

  TRANSITIONS: Object.freeze({
    'Новый': ['HR screening', REJECTED],
    'HR screening': ['Новый', PROF_INTERVIEW, REJECTED],
    [PROF_INTERVIEW]: ['HR screening', 'Финальное интервью', REJECTED],
    'Финальное интервью': [PROF_INTERVIEW, 'Offer', REJECTED],
    'Offer': ['Финальное интервью', 'Hired', REJECTED],
    'Hired': ['Offer', REJECTED]
  }),

  REJECTED_BY_CANDIDATE: 'candidate',
  REJECTED_BY_RESPONSIBLE: 'responsible',
  REJECTION_REASON_CATEGORIES: Object.freeze({
    candidate: 'Причины отказа: кандидат',
    responsible: 'Причины отказа: компания'
  }),
  OTHER_REASON: 'Другое',

  MAX_RESUME_BYTES: 10 * 1024 * 1024,
  ALLOWED_RESUME_EXTENSIONS: Object.freeze(['pdf', 'doc', 'docx']),
  DRAFT_TTL_DAYS: 7,
  LAST_LOGIN_THROTTLE_MINUTES: 30,
  // Сколько дней удалённое лежит в корзине до окончательного удаления из БД.
  TRASH_RETENTION_DAYS: 30
});

export const config = Object.freeze({
  env: env('NODE_ENV', 'development'),
  port: Number(env('PORT', '3040')),
  // Адрес для прослушивания: 127.0.0.1 — только через reverse proxy. Пусто — все интерфейсы.
  host: env('HOST'),
  publicUrl: env('PUBLIC_URL', 'http://localhost:3040').replace(/\/$/, ''),
  basePath: normalizeBasePath(env('BASE_PATH')),
  timeZone: env('APP_TIMEZONE', 'Asia/Almaty'),
  trustProxy: env('TRUST_PROXY', 'false') === 'true',

  databaseUrl: env('DATABASE_URL', 'postgres://ats:ats@localhost:5432/ats'),
  databaseSsl: env('DATABASE_SSL', 'false') === 'true',

  sessionSecret: env('SESSION_SECRET'),
  // Ключ шифрования секретов, которые администратор сохраняет в интерфейсе (SMTP, Telegram, Google).
  // По умолчанию выводится из SESSION_SECRET; задайте отдельно, чтобы менять SESSION_SECRET без потери секретов.
  settingsEncryptionKey: env('SETTINGS_ENCRYPTION_KEY'),
  sessionMaxAgeDays: Number(env('SESSION_MAX_AGE_DAYS', '14')),
  // Имя cookie сессии: задайте своё, если на одном домене несколько приложений.
  sessionCookieName: env('SESSION_COOKIE_NAME', 'ats.sid'),

  auth: Object.freeze({
    // google | dev
    mode: env('AUTH_MODE', 'google'),
    googleClientId: env('GOOGLE_CLIENT_ID'),
    googleClientSecret: env('GOOGLE_CLIENT_SECRET'),
    // Администраторы ATS: всегда имеют доступ и управляют доступом других пользователей.
    adminEmails: list('AUTH_ADMIN_EMAILS'),
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

  intakeApiKey: env('ATS_API_KEY'),

  // Email-уведомления через SMTP. Без SMTP_HOST канал «Эл. почта» считается не настроенным.
  smtp: Object.freeze({
    host: env('SMTP_HOST'),
    port: Number(env('SMTP_PORT', '587')),
    // true — TLS сразу (порт 465), false — STARTTLS (порт 587).
    secure: env('SMTP_SECURE', env('SMTP_PORT') === '465' ? 'true' : 'false') === 'true',
    user: env('SMTP_USER'),
    pass: env('SMTP_PASS'),
    from: env('MAIL_FROM', env('SMTP_USER'))
  }),

  // Telegram-бот: привязка аккаунтов по ссылке t.me/<бот>?start=<код> и отправка уведомлений.
  telegram: Object.freeze({
    botToken: env('TELEGRAM_BOT_TOKEN'),
    // Получение обновлений long polling-ом: вебхук и публичный адрес не нужны.
    // Выключите (false) на всех экземплярах, кроме одного, если их несколько.
    polling: env('TELEGRAM_POLLING', 'true') === 'true',
    // Только для тестов с эмулятором Bot API (в production запрещено).
    apiUrl: env('TELEGRAM_API_URL', 'https://api.telegram.org').replace(/\/$/, '')
  }),

  // Публичная страница /privacy (требуется Google для публикации OAuth-приложения).
  legal: Object.freeze({
    operatorName: env('LEGAL_OPERATOR_NAME', 'компании'),
    contactEmail: env('LEGAL_CONTACT_EMAIL')
  })
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
    !config.auth.adminEmails.length &&
    !config.auth.allowedDomains.length &&
    !config.auth.allowedEmails.length
  ) {
    problems.push('Задайте AUTH_ADMIN_EMAILS: без администратора некому выдавать доступ пользователям.');
  }

  if (config.drive.apiUrl) {
    problems.push('GOOGLE_DRIVE_API_URL предназначен только для тестов.');
  }

  if (config.basePath && new URL(config.publicUrl).pathname !== config.basePath) {
    problems.push('PUBLIC_URL должен заканчиваться на BASE_PATH (' + config.basePath + ').');
  }

  if (config.telegram.apiUrl !== 'https://api.telegram.org') {
    problems.push('TELEGRAM_API_URL предназначен только для тестов.');
  }

  if (problems.length) {
    throw new Error('Некорректная конфигурация:\n- ' + problems.join('\n- '));
  }
}

// Путь внутри приложения ("/auth/login") -> путь в браузере с учётом BASE_PATH.
export const withBase = path => config.basePath + path;
