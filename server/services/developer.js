// «Настройки → Для разработчиков»: версия сборки, ссылки на API и исходный код,
// подключение Claude (MCP) и Intake API. Состояние интеграций — только администраторам.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, withBase } from '../config.js';
import { db } from '../db/pool.js';
import { formatDateTime } from '../lib/dates.js';
import { verifyDriveAccess } from '../lib/drive.js';
import { smtpConfigured } from './notifications.js';
import { runtime } from './settings.js';
import { getBotUsername } from './telegram.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STARTED_AT = new Date(Date.now() - process.uptime() * 1000);
const DRIVE_CHECK_TIMEOUT_MS = 5000;

let buildInfo = null;

// Коммит читается один раз: код не меняется, пока процесс не перезапущен.
function readBuildInfo() {
  if (buildInfo) return buildInfo;

  buildInfo = { commit: config.buildCommit, date: null, subject: '' };

  if (!buildInfo.commit) {
    try {
      const [commit, date, subject] = execFileSync('git', ['log', '-1', '--format=%H%n%cI%n%s'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).split('\n');
      buildInfo = { commit, date: date ? new Date(date) : null, subject: subject || '' };
    } catch {
      // Нет git или каталог не репозиторий (Docker) — версия неизвестна.
    }
  }

  return buildInfo;
}

const withTimeout = (promise, ms, message) =>
  Promise.race([promise, new Promise((_resolve, reject) => setTimeout(() => reject(new Error(message)), ms).unref())]);

async function checkDatabase() {
  const started = Date.now();
  const { version } = await db.one('SELECT max(version) AS version FROM schema_migrations');
  return { state: 'ok', detail: `${Date.now() - started} мс · миграция ${version}` };
}

async function checkDrive() {
  const folder = await withTimeout(verifyDriveAccess(), DRIVE_CHECK_TIMEOUT_MS, 'Google Drive не ответил за 5 с.');
  return { state: 'ok', detail: `Папка «${folder.name}» доступна` };
}

function checkTelegram() {
  if (!runtime.telegram().botToken) return { state: 'off', detail: 'Бот не настроен' };
  const bot = getBotUsername();
  return bot ? { state: 'ok', detail: `Бот @${bot}` } : { state: 'error', detail: 'Токен задан, но бот недоступен — см. лог сервера' };
}

function checkSmtp() {
  return smtpConfigured()
    ? { state: 'ok', detail: `${runtime.smtp().host} — проверка письмом: Настройки → Интеграции` }
    : { state: 'off', detail: 'Не настроен — письма не отправляются' };
}

async function safeCheck(check) {
  try {
    return await check();
  } catch (error) {
    return { state: 'error', detail: error.message || String(error) };
  }
}

async function getStatus() {
  const [database, drive] = await Promise.all([safeCheck(checkDatabase), safeCheck(checkDrive)]);

  return [
    { key: 'database', label: 'PostgreSQL', ...database },
    { key: 'drive', label: 'Google Drive', ...drive },
    { key: 'telegram', label: 'Telegram', ...checkTelegram() },
    { key: 'smtp', label: 'Почта (SMTP)', ...checkSmtp() },
    {
      key: 'auth',
      label: 'Вход',
      state: config.auth.mode === 'google' ? 'ok' : 'warn',
      detail: config.auth.mode === 'google' ? 'Через Google' : `AUTH_MODE=${config.auth.mode} — вход без пароля, только для разработки`
    },
    {
      key: 'intake',
      label: 'Intake API',
      state: config.intakeApiKey ? 'ok' : 'off',
      detail: config.intakeApiKey ? 'Ключ ATS_API_KEY задан' : 'Ключ ATS_API_KEY не задан — API отвечает 503'
    }
  ];
}

export async function getDeveloperInfo(_input, user) {
  const build = readBuildInfo();
  const repo = config.repositoryUrl;
  const mcpUrl = `${config.publicUrl}/mcp`;

  return {
    version: {
      commit: build.commit || '',
      commitShort: build.commit ? build.commit.slice(0, 7) : '',
      commitDate: build.date ? formatDateTime(build.date) : '',
      commitSubject: build.subject,
      commitUrl: build.commit && repo ? `${repo}/commit/${build.commit}` : '',
      startedAt: formatDateTime(STARTED_AT),
      node: process.version,
      env: config.env
    },
    links: {
      swagger: withBase('/api/docs'),
      openApi: withBase('/api/openapi.json'),
      repository: repo,
      apiGuide: repo ? `${repo}/blob/main/docs/API.md` : ''
    },
    mcp: {
      url: mcpUrl,
      addCommand: `claude mcp add --transport http recruiting-ats ${mcpUrl}`,
      addCommandWithToken: `claude mcp add --transport http recruiting-ats ${mcpUrl} --header "X-ATS-Token: <токен>"`
    },
    intake: { url: `${config.publicUrl}/intake`, configured: Boolean(config.intakeApiKey) },
    status: user && user.is_admin ? await getStatus() : null
  };
}
