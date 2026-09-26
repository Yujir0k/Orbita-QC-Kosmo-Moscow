import pg from 'pg';
import { readFile } from 'node:fs/promises';

/** Bounded TLS pools shared by all repositories. The runtime role cannot mutate history. */
export async function createDatabase(prefix = 'DB') {
  const password = (await readFile(process.env[`${prefix}_PASSWORD_FILE`], 'utf8')).trim();
  const ca = await readFile(process.env.DB_CA_FILE, 'utf8');
  const pool = new pg.Pool({ host: process.env[`${prefix}_HOST`], port: Number(process.env[`${prefix}_PORT`] || 5432),
    database: process.env[`${prefix}_NAME`] || 'orbita', user: process.env[`${prefix}_USER`] || 'orbita_app', password,
    ssl: { ca, rejectUnauthorized: true }, max: Number(process.env.DB_POOL_SIZE || 12),
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 15000, application_name: 'orbita-qc' });
  pool.on('error', () => process.stderr.write('Database pool connection lost\n'));
  return pool;
}

/** All transaction operations use the same connection; rollback also releases advisory locks. */
export async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

export async function lock(client, key) { await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]); }
