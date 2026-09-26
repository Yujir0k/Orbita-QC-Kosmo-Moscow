import https from 'node:https';
import { workOrderPayload } from '../../work-order.mjs';
import { readFile } from 'node:fs/promises';
import { createDatabase, transaction, lock } from './db.mjs';
import { loadCrypto, equal, digest } from './crypto.mjs';
import { createRepository } from './repository.mjs';
import { readJsonObject } from '../../contract-validator.mjs';
const pool = await createDatabase();
const crypto = await loadCrypto(process.env.KEYRING_FILE);
const repo = createRepository(crypto);
const token = (await readFile(process.env.EMULATOR_TOKEN_FILE, 'utf8')).trim();
https.createServer({ key: await readFile(process.env.TLS_KEY_FILE), cert: await readFile(process.env.TLS_CERT_FILE) }, async (req,res) => {
  try {
    if (req.method === 'GET' && req.url === '/health/ready') {
      await pool.query('SELECT 1');
      res.writeHead(200, {'Content-Type':'application/json'}).end('{"ready":true}');
      return;
    }
    if (!equal(String(req.headers['x-orbita-internal'] ?? ''), token)) { res.writeHead(403).end('{}'); return; }
    const url = new URL(req.url, 'https://emulator');
    const input = req.method === 'POST' ? await readJsonObject(req) : null;
    const result = await transaction(pool, async client => {
      const dataset = (await repo.get(client, 'system', 'dataset')).value;
      if (req.method === 'GET' && url.pathname.startsWith('/api/emulator/orders/')) {
        const id = decodeURIComponent(url.pathname.split('/').at(-1));
        const items = dataset.items.filter(row => row.work_order_id === id);
        if (!items.length) throw new Error('Unknown order');
        return { delivery_id: `ERP-IN-${id}`, deliver_at: '2026-02-17T07:45:00+03:00', message: { message_id: `MSG-${id}`, message_type: 'work_order', schema_version: '1.0', source_system: 'ERP-EMU', sent_at: '2026-02-17T07:45:00+03:00', payload: workOrderPayload(id, items) } };
      }
      if (req.method === 'POST' && url.pathname === '/api/emulator/results') {
        const key = input.correlation_key;
        await lock(client, `emulator:${key}`);
        const existing = (await repo.get(client, 'emulator', key))?.value;
        if (existing && existing.fingerprint !== digest(input)) throw new Error('Correlation conflict');
        const attempt = (existing?.attempt ?? 0) + 1;
        await repo.put(client, 'emulator', key, { message: input, fingerprint: digest(input), attempt });
        return { message_id: `ACK-${key}-${attempt}`, message_type: 'quality_result_ack', schema_version: '1.0', source_system: 'ERP-EMU', correlation_key: key, status: 'accepted', error_code: null, attempt };
      }
      throw new Error('Unknown route');
    });
    res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify(result));
  } catch (error) { res.writeHead(422, {'Content-Type':'application/json'}).end(JSON.stringify({error:error.message})); }
}).listen(8443,'0.0.0.0');
