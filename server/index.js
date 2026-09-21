import { assertProductionConfig, config } from './config.js';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { verifyDriveAccess } from './lib/drive.js';
import { cleanupExpiredCandidateDrafts } from './services/drafts.js';

// Очистка просроченных черновиков внутри процесса: не нужен отдельный cron
// (на бесплатных тарифах он обычно недоступен). Запускается вскоре после старта
// — это важно для хостингов, где сервер засыпает, — и затем раз в сутки.
function scheduleDraftCleanup() {
  const run = () =>
    cleanupExpiredCandidateDrafts()
      .then(({ removed }) => removed && console.log(`Draft cleanup: removed ${removed}`))
      .catch(error => console.error('Draft cleanup failed:', error.message));

  setTimeout(run, 60_000).unref();
  setInterval(run, 24 * 60 * 60 * 1000).unref();
}

async function main() {
  assertProductionConfig();

  // Схема БД накатывается при старте (аналог ensureSchemaVersion_ из Apps Script),
  // доступ к корневой папке Google Drive проверяется сразу, а не при первой загрузке резюме.
  await migrate();
  const folder = await verifyDriveAccess();
  console.log(`Google Drive: папка «${folder.name}» доступна`);

  const server = createApp().listen(config.port, () => {
    console.log(`Recruiting ATS listening on ${config.publicUrl} (port ${config.port}, auth: ${config.auth.mode})`);
  });

  scheduleDraftCleanup();

  const shutdown = () => {
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
