import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDatabase, transaction, lock } from './db.mjs';
import { loadCrypto } from './crypto.mjs';
import { createRepository } from './repository.mjs';
import { initialHistory, domain } from './workflow.mjs';
import { passwordHash, roles } from './auth.mjs';
import { putMedia } from './media.mjs';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const crypto = await loadCrypto(process.env.KEYRING_FILE);
const repo = createRepository(crypto);
const pool = await createDatabase();
const media = await createDatabase('MEDIA_DB');
try {
  const dataset = JSON.parse(await readFile(path.join(directory, 'source/src/demo-data.json'), 'utf8'));
  const seedUsers = JSON.parse(await readFile(process.env.USERS_FILE, 'utf8'));
  await transaction(pool, async client => {
    await lock(client, 'initialize');
    if (await repo.get(client, 'system', 'initialized')) return;
    const metadata = { ...dataset, source: [], seedDecisions: [], contextDeliveries: [] };
    await repo.put(client, 'system', 'dataset', metadata);
    for (const user of seedUsers) {
      if (!roles.includes(user.role) || typeof user.password !== 'string' || user.password.length < 16) throw new Error('Invalid initial user');
      await repo.put(client, 'users', user.id, { ...user, lineIds: user.lineIds ?? dataset.catalogs.lines.map(row => row.id), password: await passwordHash(user.password) });
    }
    const itemLines = new Map(dataset.source.map(row => [row.message.item_id, row.message.line_id]));
    for (const asset of dataset.media) {
      const filename = path.basename(asset.path_from_quality_dataset);
      const bytes = await readFile(path.join(directory, 'source/public/media', filename));
      const type = filename.endsWith('.png') ? 'image/png' : filename.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      await transaction(media, mc => putMedia(mc, crypto, { id: asset.asset_id, item: asset.item_id, line: itemLines.get(asset.item_id), filename, bytes, contentType: type }));
    }
    for (const row of initialHistory) {
      const result = await repo.ingest(client, row, domain.validateDelivery, { trusted: true, actor: 'dataset-import' });
      if (result.kind === 'error') throw new Error(`${row.delivery_id}: ${result.reason}`);
    }
    await repo.put(client, 'system', 'initialized', { at: new Date().toISOString(), provenance: 'synthetic-hackathon-dataset', events: initialHistory.length });
    await repo.append(client, 'security', { type: 'system.initialized', at: new Date().toISOString(), events: initialHistory.length });
  });
  process.stdout.write('Database and encrypted media initialized\n');
} finally { await pool.end(); await media.end(); }
