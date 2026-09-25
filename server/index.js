import { assertProductionConfig, config } from './config.js';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { verifyDriveAccess } from './lib/drive.js';

async function main() {
  assertProductionConfig();

  // Схема БД накатывается при старте (аналог ensureSchemaVersion_ из Apps Script),
  // доступ к корневой папке Google Drive проверяется сразу, а не при первой загрузке резюме.
  await migrate();
  const folder = await verifyDriveAccess();
  console.log(`Google Drive: папка «${folder.name}» доступна`);

  const listenArgs = config.host ? [config.port, config.host] : [config.port];
  const server = createApp().listen(...listenArgs, () => {
    console.log(`Recruiting ATS listening on ${config.publicUrl} (port ${config.port}, auth: ${config.auth.mode})`);
  });

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
