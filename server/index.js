import { assertProductionConfig, config } from './config.js';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { verifyDriveAccess } from './lib/drive.js';
import { startDeliveryWorker, stopDeliveryWorker } from './services/notification-delivery.js';
import { startTelegramBot, stopTelegramBot } from './services/telegram.js';
import { assertAuthConfigured, loadSettings } from './services/settings.js';

async function main() {
  assertProductionConfig();

  // Схема БД накатывается при старте (аналог ensureSchemaVersion_ из Apps Script),
  // доступ к корневой папке Google Drive проверяется сразу, а не при первой загрузке резюме.
  await migrate();
  // Настройки интеграций из БД (Настройки → Интеграции) поверх .env.
  await loadSettings();
  assertAuthConfigured();
  const folder = await verifyDriveAccess();
  console.log(`Google Drive: папка «${folder.name}» доступна`);

  const bot = await startTelegramBot();
  if (bot) console.log(`Telegram: бот @${bot} подключён`);
  startDeliveryWorker();

  const server = createApp().listen(config.port, () => {
    console.log(`Recruiting ATS listening on ${config.publicUrl} (port ${config.port}, auth: ${config.auth.mode})`);
  });

  const shutdown = () => {
    stopTelegramBot();
    stopDeliveryWorker();
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
