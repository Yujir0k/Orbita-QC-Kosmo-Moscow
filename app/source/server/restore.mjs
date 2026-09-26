import { readFile } from 'node:fs/promises';
import { createDatabase, transaction } from './db.mjs';
import { loadCrypto, digest } from './crypto.mjs';
import { createRepository } from './repository.mjs';

const tableOrder = ['documents', 'stream_heads', 'journal', 'events', 'ingest_receipts', 'commands', 'outbox'];

/** Restore only into empty, migrated databases. Never clears or overwrites existing evidence. */
export async function restoreBackup(pool, mediaPool, crypto, bytes, expectedHash) {
  if (!expectedHash || digest(bytes) !== expectedHash) throw new Error('Backup SHA256 mismatch');
  const backup = JSON.parse(bytes.toString('utf8'));
  if (backup.format !== 'orbita-db-backup-v1') throw new Error('Unsupported backup format');
  const insert = async (client, table, rows) => {
    const columns = (await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2', ['public', table])).rows.map(row => row.column_name);
    if (Number((await client.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n)) throw new Error(`Restore target is not empty: ${table}`);
    for (const row of rows) {
      const names = Object.keys(row);
      if (!names.length || names.some(name => !columns.includes(name))) throw new Error(`Unknown backup column in ${table}`);
      await client.query(`INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map((_, i) => '$' + (i + 1)).join(',')})`, names.map(name => row[name]));
    }
  };
  // Independent media records are immutable. A partial failure leaves an isolated restore target,
  // never the live databases. Do not serve a target until the full verification succeeds.
  await transaction(mediaPool, client => insert(client, 'media', backup.media));
  await transaction(pool, async client => {
    for (const table of tableOrder) await insert(client, table, backup.tables[table]);
    for (const table of ['journal', 'ingest_receipts']) {
      // Identity sequences need to follow the imported IDs.
      const sequence = (await client.query('SELECT pg_get_serial_sequence($1,$2) AS name', [table, 'id'])).rows[0].name;
      if (sequence) await client.query(`SELECT setval($1::regclass, COALESCE((SELECT MAX(id) FROM ${table}),1), EXISTS(SELECT 1 FROM ${table}))`, [sequence]);
    }
    const check = await createRepository(crypto).verify(client);
    if (!check.valid) throw new Error('Restored journal failed integrity verification');
  });
  for (const row of backup.media) {
    const content = Buffer.from(crypto.open(row.payload, `media:${row.id}`).data, 'base64');
    if (digest(content) !== row.sha256) throw new Error(`Restored media integrity failed: ${row.id}`);
  }
  return { backupId: backup.backupId, events: backup.tables.events.length, media: backup.media.length, verified: true };
}

if (process.argv.includes('--restore-empty')) {
  const file = process.argv[process.argv.indexOf('--restore-empty') + 1];
  const pool = await createDatabase(), media = await createDatabase('MEDIA_DB');
  try {
    const result = await restoreBackup(pool, media, await loadCrypto(process.env.KEYRING_FILE), await readFile(file), process.env.BACKUP_SHA256);
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally { await pool.end(); await media.end(); }
}
