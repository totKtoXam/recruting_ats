// Telegram-бот ATS.
//
// Привязка аккаунта (она же подтверждение):
//   1. Пользователь в ATS нажимает «Привязать Telegram» — сервер выдаёт одноразовый код на 15 минут
//      и ссылку t.me/<бот>?start=<код>.
//   2. Пользователь открывает ссылку и нажимает «Старт» — Telegram присылает боту «/start <код>»
//      от имени именно этого аккаунта.
//   3. Сервер находит пользователя по коду и сохраняет chat_id и @username — аккаунт подтверждён,
//      и боту есть куда писать (первым написать по нику бот не может).
// Обновления получаем long polling-ом (getUpdates): не нужны вебхук и публичный HTTPS-адрес.
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { db, transaction } from '../db/pool.js';
import { fail } from '../lib/errors.js';
import { userDisplayName } from './mappers.js';
import { onSettingsChanged, runtime } from './settings.js';

const LINK_TTL_MINUTES = 15;

let botUsername = '';
// Поколение цикла опроса: при смене токена старый цикл завершается, запускается новый.
let generation = 0;
let pollAbort = null;

export const getBotUsername = () => botUsername;

export class TelegramError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export async function telegramApi(method, body = {}, signal, token = runtime.telegram().botToken) {
  const response = await fetch(`${config.telegram.apiUrl}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  const data = await response.json().catch(() => ({}));

  if (!data.ok) {
    throw new TelegramError(data.description || `Telegram API: HTTP ${response.status}`, data.error_code || response.status);
  }

  return data.result;
}

export function sendTelegramMessage(chatId, html) {
  return telegramApi('sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true }
  });
}

// ---------- Привязка ----------

export async function createTelegramLink(_input, user) {
  if (!runtime.telegram().botToken) fail('Telegram-бот не настроен (Настройки → Интеграции → Telegram).');
  if (!botUsername) fail('Telegram-бот сейчас недоступен. Попробуйте позже.');

  const token = randomBytes(18).toString('base64url');
  const row = await db.one(
    `UPDATE users SET telegram_link_token = $2,
       telegram_link_expires_at = now() + make_interval(mins => $3)
     WHERE id = $1 RETURNING telegram_link_expires_at`,
    [user.id, token, LINK_TTL_MINUTES]
  );

  return {
    url: `https://t.me/${botUsername}?start=${token}`,
    expiresAt: new Date(row.telegram_link_expires_at).toISOString()
  };
}

export async function unlinkTelegram(_input, user) {
  await db.query(
    `UPDATE users SET telegram_chat_id = NULL, telegram_verified_at = NULL,
       telegram_link_token = NULL, telegram_link_expires_at = NULL
     WHERE id = $1`,
    [user.id]
  );
  return { ok: true };
}

async function linkByToken(token, chatId, username) {
  return transaction(async tx => {
    const user = await tx.one(
      `SELECT * FROM users WHERE telegram_link_token = $1 AND telegram_link_expires_at > now()
         AND archived_at IS NULL AND deleted_at IS NULL FOR UPDATE`,
      [token]
    );

    if (!user) return null;

    // Один Telegram-аккаунт — один пользователь ATS.
    await tx.query(
      `UPDATE users SET telegram_chat_id = NULL, telegram_verified_at = NULL
       WHERE telegram_chat_id = $1 AND id <> $2`,
      [chatId, user.id]
    );
    await tx.query(
      `UPDATE users SET telegram_chat_id = $2, telegram_username = $3, telegram_verified_at = now(),
         telegram_link_token = NULL, telegram_link_expires_at = NULL
       WHERE id = $1`,
      [user.id, chatId, username || '']
    );

    return user;
  });
}

const escapeHtml = value =>
  String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

async function handleMessage(message) {
  if (!message || !message.chat || message.chat.type !== 'private' || typeof message.text !== 'string') {
    return;
  }

  const chatId = message.chat.id;
  const [command, payload] = message.text.trim().split(/\s+/, 2);

  if (command === '/start' && payload) {
    const user = await linkByToken(payload, chatId, message.from && message.from.username);
    await sendTelegramMessage(
      chatId,
      user
        ? `✅ Telegram привязан к Recruiting ATS: <b>${escapeHtml(userDisplayName(user))}</b>.\nСюда будут приходить уведомления. Отключить: /stop`
        : '⚠️ Ссылка недействительна или устарела. Получите новую в ATS: Профиль → Уведомления → «Привязать Telegram».'
    );
    return;
  }

  if (command === '/stop') {
    const result = await db.query(
      'UPDATE users SET telegram_chat_id = NULL, telegram_verified_at = NULL WHERE telegram_chat_id = $1',
      [chatId]
    );
    await sendTelegramMessage(
      chatId,
      result.rowCount ? 'Telegram отвязан от ATS. Уведомления сюда больше не придут.' : 'Этот чат не привязан к ATS.'
    );
    return;
  }

  await sendTelegramMessage(
    chatId,
    'Это бот уведомлений Recruiting ATS. Чтобы привязать аккаунт, откройте в ATS: Профиль → Уведомления → «Привязать Telegram».'
  );
}

// ---------- Long polling ----------

async function pollLoop(loopGeneration) {
  let offset = 0;
  const active = () => loopGeneration === generation;

  while (active()) {
    try {
      pollAbort = new AbortController();
      const updates = await telegramApi(
        'getUpdates',
        { offset, timeout: 25, allowed_updates: ['message'] },
        pollAbort.signal
      );

      if (!active()) break;

      for (const update of updates) {
        offset = update.update_id + 1;
        await handleMessage(update.message).catch(error =>
          console.error('Telegram: ошибка обработки сообщения:', error.message)
        );
      }
    } catch (error) {
      if (!active()) break;
      // 409 — обновления забирает другой экземпляр или настроен вебхук.
      console.error('Telegram: getUpdates:', error.message);
      await new Promise(resolve => setTimeout(resolve, error.code === 409 ? 30_000 : 5_000));
    }
  }
}

export async function startTelegramBot() {
  stopTelegramBot();
  const settings = runtime.telegram();
  if (!settings.botToken) return null;

  try {
    const me = await telegramApi('getMe');
    botUsername = me.username || '';
  } catch (error) {
    console.error('Telegram: бот недоступен:', error.message);
    return null;
  }

  if (settings.polling) {
    pollLoop(generation);
  }

  return botUsername;
}

export function stopTelegramBot() {
  generation += 1;
  botUsername = '';
  if (pollAbort) pollAbort.abort();
}

// Токен или режим поменяли в интерфейсе — перезапускаем бота.
onSettingsChanged('telegram', async () => {
  const bot = await startTelegramBot();
  console.log(bot ? `Telegram: бот @${bot} подключён` : 'Telegram: бот отключён');
});
