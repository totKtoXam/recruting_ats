// Удаляет использованные и просроченные черновики кандидатов, их файлы переносит в корзину Google Drive.
// Запускать по расписанию (cron / Kubernetes CronJob): npm run cleanup-drafts
import { pool } from '../server/db/pool.js';
import { cleanupExpiredCandidateDrafts } from '../server/services/drafts.js';

try {
  const result = await cleanupExpiredCandidateDrafts();
  console.log(`Removed drafts: ${result.removed}`);
} finally {
  await pool.end();
}
