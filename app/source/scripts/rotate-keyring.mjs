import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const filename = path.resolve(process.argv[2] ?? '../../../.secrets/keyring.json');
const original = await readFile(filename, 'utf8');
const ring = JSON.parse(original);
if (!ring.keys?.[ring.active]) throw new Error('Invalid keyring');
const id = 'data-' + Date.now();
await writeFile(filename + '.' + id + '.backup', original, { mode: 0o600, flag: 'wx' });
ring.keys[id] = randomBytes(32).toString('hex');
ring.active = id;
await writeFile(filename + '.next', JSON.stringify(ring), { mode: 0o600, flag: 'wx' });
await rename(filename + '.next', filename);
process.stdout.write(`Active key: ${id}. Retained ${Object.keys(ring.keys).length} versions. Recreate API, initializer and emulator containers to refresh bind mounts.\n`);
