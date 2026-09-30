// Выгружает спецификацию OpenAPI (как /api/openapi.json) в файл или stdout — для линта в CI
// и генераторов клиентов: node scripts/export-openapi.js [файл]
import fs from 'node:fs';
import { buildOpenApiSpec } from '../server/openapi/index.js';

const json = JSON.stringify(buildOpenApiSpec(), null, 2) + '\n';
const file = process.argv[2];

if (file) {
  fs.writeFileSync(file, json);
  console.error(`OpenAPI записан в ${file}`);
} else {
  process.stdout.write(json);
}

// Импорт сервисов создаёт пул БД; соединений нет, но процесс завершаем явно.
process.exit(0);
