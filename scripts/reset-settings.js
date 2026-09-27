// Сброс настроек интеграций, сохранённых в интерфейсе (Настройки → Интеграции), к значениям из .env.
// Нужен, если неверные настройки входа через Google закрыли доступ всем.
//
//   npm run settings:reset            — все группы
//   npm run settings:reset -- auth    — только вход через Google (auth | smtp | telegram)
import { pool } from '../server/db/pool.js';

const group = process.argv[2];
const groups = ['auth', 'smtp', 'telegram'];

if (group && !groups.includes(group)) {
  console.error(`Неизвестная группа «${group}». Допустимо: ${groups.join(', ')}.`);
  process.exit(1);
}

const result = group
  ? await pool.query('DELETE FROM app_settings WHERE key LIKE $1', [group + '.%'])
  : await pool.query('DELETE FROM app_settings');

console.log(`Удалено настроек: ${result.rowCount}. Действуют значения из .env — перезапустите сервер.`);
await pool.end();
