import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pool } from './pool.js';

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations'
);

// Миграции — файлы .sql или .js (export default async client => {...}) для изменений,
// которым нужен код приложения (например, шифрование данных ключом из настроек).
// Каждая выполняется в своей транзакции.
async function runMigration(client, file) {
  const fullPath = path.join(MIGRATIONS_DIR, file);

  if (file.endsWith('.js')) {
    const { default: up } = await import(pathToFileURL(fullPath).href);
    await up(client);
    return;
  }

  await client.query(await fs.readFile(fullPath, 'utf8'));
}

// Advisory lock не даёт двум инстансам одновременно накатывать миграции.
const LOCK_KEY = 874_512_001;

export async function migrate({ log = console.log } = {}) {
  const client = await pool.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = new Set(
      (await client.query('SELECT version FROM schema_migrations')).rows.map(row => row.version)
    );

    const files = (await fs.readdir(MIGRATIONS_DIR))
      .filter(name => name.endsWith('.sql') || name.endsWith('.js'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }

      await client.query('BEGIN');

      try {
        await runMigration(client, file);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`Migration applied: ${file}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${error.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => pool.end())
    .catch(error => {
      console.error(error.message);
      process.exit(1);
    });
}
