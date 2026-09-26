import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createDatabase, transaction } from '../server/db.mjs';
import { loadCrypto } from '../server/crypto.mjs';
import { createRepository } from '../server/repository.mjs';
import { dispatchOne } from '../server/worker.mjs';
import { createContractRegistry } from '../../contract-validator.mjs';

const pool = await createDatabase();
const crypto = await loadCrypto(process.env.KEYRING_FILE);
const repo = createRepository(crypto);
process.env.EMULATOR_TOKEN = (await readFile(process.env.EMULATOR_TOKEN_FILE, 'utf8')).trim();
try {
  const original = (await repo.history(pool)).find(row => row.message.event_type === 'quality_decision');
  assert.ok(original, 'Need one persisted QC decision');
  const id = `verify:${randomUUID()}`;
  await transaction(pool, client => repo.queue(client, id, original.message.item_id, 'erp', original.message));
  const contracts = await createContractRegistry('/app');
  let job;
  for (let i = 0; i < 180; i++) {
    await dispatchOne(pool, repo, crypto, '/app', contracts);
    job = (await pool.query('SELECT status,attempts,last_error,receipt FROM outbox WHERE id=$1', [id])).rows[0];
    if (['accepted', 'failed'].includes(job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(job.status, 'accepted', job.last_error);
  process.stdout.write(JSON.stringify({ outbound: job.status, attempts: job.attempts, item: original.message.item_id, receipt: crypto.open(job.receipt, `receipt:${id}`) }) + '\n');
} finally { await pool.end(); }
