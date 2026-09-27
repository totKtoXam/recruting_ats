// Очередь доставки уведомлений по внешним каналам (email, Telegram).
// Строки notification_deliveries со статусом pending забираются пачками (SKIP LOCKED —
// безопасно при нескольких экземплярах), при ошибке повторяются с растущей паузой.
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { onSettingsChanged, runtime } from './settings.js';
import { db } from '../db/pool.js';
import { candidateLink, onNotificationsCreated, smtpConfigured, telegramConfigured } from './notifications.js';
import { sendTelegramMessage } from './telegram.js';

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 20;
const INTERVAL_MS = 60_000;

let transporter = null;
let running = false;
let rerun = false;
let timer = null;

function getTransporter() {
  if (!transporter) {
    const smtp = runtime.smtp();
    transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined
    });
  }
  return transporter;
}

// Настройки SMTP поменяли в интерфейсе — пересоздаём подключение и досылаем очередь.
onSettingsChanged('smtp', () => {
  if (transporter) transporter.close();
  transporter = null;
  processDeliveryQueue();
});

const escapeHtml = value =>
  String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

function emailContent(notification) {
  const link = notification.candidate_id ? candidateLink(notification.candidate_id) : config.publicUrl;

  return {
    subject: notification.title,
    text: `${notification.title}\n\n${notification.body}\n\nОткрыть в ATS: ${link}\n\n—\nRecruiting ATS. Настроить уведомления: ${config.publicUrl}/#/settings/notifications`,
    html: `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#1f2328">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e5e8;border-radius:10px;padding:20px 24px">
  <div style="font-size:12px;color:#6b7280;margin-bottom:8px">Recruiting ATS</div>
  <div style="font-size:16px;font-weight:600;margin-bottom:8px">${escapeHtml(notification.title)}</div>
  <div style="font-size:14px;line-height:1.5;color:#374151;margin-bottom:16px">${escapeHtml(notification.body)}</div>
  <a href="${escapeHtml(link)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:8px 14px;border-radius:6px;font-size:14px">Открыть в ATS</a>
</div>
<div style="max-width:560px;margin:12px auto 0;font-size:12px;color:#9ca3af;text-align:center">
  <a href="${escapeHtml(config.publicUrl)}/#/settings/notifications" style="color:#9ca3af">Настроить уведомления</a>
</div></body></html>`
  };
}

function telegramContent(notification) {
  const link = notification.candidate_id ? candidateLink(notification.candidate_id) : config.publicUrl;
  return `<b>${escapeHtml(notification.title)}</b>\n${escapeHtml(notification.body)}\n\n<a href="${escapeHtml(link)}">Открыть в ATS</a>`;
}

async function deliver(delivery) {
  const notification = await db.one('SELECT * FROM notifications WHERE id = $1', [delivery.notification_id]);
  const user = notification
    ? await db.one('SELECT * FROM users WHERE id = $1', [notification.user_id])
    : null;

  if (!notification || !user) {
    return { status: 'skipped', error: 'Получатель удалён' };
  }

  if (delivery.channel === 'email') {
    if (!smtpConfigured()) return { status: 'skipped', error: 'SMTP не настроен' };
    if (!user.email || user.email.endsWith('.invalid')) return { status: 'skipped', error: 'Нет email' };

    await getTransporter().sendMail({ from: runtime.smtp().from, to: user.email, ...emailContent(notification) });
    return { status: 'sent', recipient: user.email };
  }

  if (delivery.channel === 'telegram') {
    if (!telegramConfigured()) return { status: 'skipped', error: 'Telegram-бот не настроен' };
    if (!user.telegram_chat_id) return { status: 'skipped', error: 'Telegram не привязан' };

    try {
      await sendTelegramMessage(user.telegram_chat_id, telegramContent(notification));
    } catch (error) {
      // 403 — пользователь заблокировал бота: повторять бессмысленно.
      if (error.code === 403) return { status: 'failed', error: 'Пользователь заблокировал бота' };
      throw error;
    }
    return { status: 'sent', recipient: user.telegram_username ? '@' + user.telegram_username : '' };
  }

  return { status: 'skipped', error: 'Неизвестный канал' };
}

async function claimBatch() {
  return db.many(
    `UPDATE notification_deliveries d
     SET attempts = d.attempts + 1, next_attempt_at = now() + interval '5 minutes', updated_at = now()
     WHERE d.id IN (
       SELECT id FROM notification_deliveries
       WHERE status = 'pending' AND next_attempt_at <= now()
       ORDER BY next_attempt_at
       LIMIT ${BATCH_SIZE}
       FOR UPDATE SKIP LOCKED
     )
     RETURNING d.*`
  );
}

async function processBatch(batch) {
  for (const delivery of batch) {
    try {
      const result = await deliver(delivery);
      await db.query(
        `UPDATE notification_deliveries
         SET status = $2, error = $3, recipient = coalesce(nullif($4, ''), recipient),
             sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END, updated_at = now()
         WHERE id = $1`,
        [delivery.id, result.status, result.error || '', result.recipient || '']
      );
    } catch (error) {
      const final = delivery.attempts >= MAX_ATTEMPTS;
      // Паузы между попытками: 1, 2, 4, 8 минут.
      const delayMinutes = 2 ** (delivery.attempts - 1);

      await db.query(
        `UPDATE notification_deliveries
         SET status = $2, error = $3, next_attempt_at = now() + make_interval(mins => $4), updated_at = now()
         WHERE id = $1`,
        [delivery.id, final ? 'failed' : 'pending', String(error.message || error).slice(0, 500), delayMinutes]
      );
    }
  }
}

export async function processDeliveryQueue() {
  if (running) {
    rerun = true;
    return;
  }

  running = true;

  try {
    do {
      rerun = false;
      let batch;
      while ((batch = await claimBatch()).length) {
        await processBatch(batch);
      }
    } while (rerun);
  } catch (error) {
    console.error('Уведомления: ошибка очереди доставки:', error.message);
  } finally {
    running = false;
  }
}

export function startDeliveryWorker() {
  onNotificationsCreated(() => processDeliveryQueue());
  timer = setInterval(() => processDeliveryQueue(), INTERVAL_MS);
  timer.unref();
  processDeliveryQueue();

  if (smtpConfigured()) {
    getTransporter()
      .verify()
      .then(() => console.log(`Email-уведомления: SMTP ${runtime.smtp().host}:${runtime.smtp().port} доступен`))
      .catch(error => console.error('Email-уведомления: SMTP недоступен:', error.message));
  } else {
    console.log('Email-уведомления: SMTP не настроен (Настройки → Интеграции или SMTP_HOST в .env) — письма не отправляются.');
  }
}

export function stopDeliveryWorker() {
  if (timer) clearInterval(timer);
}
