import { cp, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const application = await realpath(path.resolve(source, '..'));
const build = path.join(source, 'dist');
const target = path.join(application, 'site');
if (path.dirname(source) !== application || path.basename(source) !== 'source' || path.basename(target) !== 'site') {
  throw new Error('Unexpected project layout. Refusing to replace the portable site.');
}
await stat(path.join(build, 'index.html'));
try {
  if (await realpath(target) !== target) throw new Error('Portable site must not be a symlink or junction.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await rm(target, { recursive: true, force: true });
await cp(build, target, { recursive: true });
process.stdout.write('Portable site refreshed from the verified build.\n');
