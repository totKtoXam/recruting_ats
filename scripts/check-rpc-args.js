// Каждый RPC-метод вызывается с пустыми и неверными аргументами (undefined, null, {}, [], строка, число)
// от имени администратора. Ни один вызов не должен закончиться внутренней ошибкой (HTTP 500):
// только понятной ошибкой валидации или успехом. Запускается в CI на пустой БД после миграций.
//
// Методы могут записывать данные, поэтому скрипт работает только с флагом --allow-writes
// и никогда не должен запускаться на рабочей базе.
import { db, pool } from '../server/db/pool.js';
import { toPublicError } from '../server/lib/errors.js';
import { callRpc, rpcHandlers } from '../server/rpc.js';
import { loadSettings } from '../server/services/settings.js';

if (!process.argv.includes('--allow-writes')) {
  console.error('Скрипт вызывает методы записи. Запускайте только на отдельной БД: --allow-writes');
  process.exit(2);
}

const INPUTS = { undefined: undefined, null: null, '{}': {}, '[]': [], string: 'x', number: 1 };
const EMAIL = 'rpc-args-check@example.com';

await loadSettings();
await db.query(
  `INSERT INTO users (email, full_name, is_admin) VALUES ($1, 'RPC args check', true)
   ON CONFLICT DO NOTHING`,
  [EMAIL]
);
const user = await db.one('SELECT * FROM users WHERE lower(email) = $1', [EMAIL]);
const failures = [];

for (const name of Object.keys(rpcHandlers)) {
  for (const [label, args] of Object.entries(INPUTS)) {
    try {
      await callRpc(name, args, { user });
    } catch (error) {
      if (!toPublicError(error)) {
        failures.push(`${name}(${label}): ${error && error.message}`);
      }
    }
  }
}

await pool.end();

if (failures.length) {
  console.error(`RPC-методы с внутренней ошибкой (${failures.length}):\n` + failures.join('\n'));
  process.exit(1);
}

console.log(`OK: ${Object.keys(rpcHandlers).length} методов × ${Object.keys(INPUTS).length} вариантов аргументов без ошибок 500.`);
