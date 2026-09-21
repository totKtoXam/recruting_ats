import pg from 'pg';
import { config } from '../config.js';

// bigint (number, salary) и numeric приходят строками по умолчанию.
pg.types.setTypeParser(pg.types.builtins.INT8, value => Number(value));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 10
});

export function query(text, params) {
  return pool.query(text, params);
}

export async function one(text, params) {
  const result = await pool.query(text, params);
  return result.rows[0] || null;
}

// Выполняет fn(client) в транзакции. client.query/one/many доступны внутри.
export async function transaction(fn) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await fn(withHelpers(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Интерфейс, одинаковый для пула и транзакционного клиента.
export const db = withHelpers(pool);

function withHelpers(executor) {
  return {
    query: (text, params) => executor.query(text, params),
    one: async (text, params) => (await executor.query(text, params)).rows[0] || null,
    many: async (text, params) => (await executor.query(text, params)).rows
  };
}
