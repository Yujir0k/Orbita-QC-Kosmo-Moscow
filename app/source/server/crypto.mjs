import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const canonical = value => JSON.stringify(value, (_key, part) => part && typeof part === 'object' && !Array.isArray(part) ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part);
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
export const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Load versioned keys from a mounted secret; keys never travel with a record. */
export async function loadCrypto(file) {
  const ring = JSON.parse(await readFile(file, 'utf8'));
  if (!ring.active || !ring.keys?.[ring.active] || Object.values(ring.keys).some(key => !/^[a-f0-9]{64}$/.test(key))) throw new Error('Invalid encryption keyring');
  const key = (id, purpose) => {
    if (!ring.keys[id]) throw new Error(`Key unavailable: ${id}`);
    return Buffer.from(hkdfSync('sha256', Buffer.from(ring.keys[id], 'hex'), Buffer.from('orbita-production-v1'), Buffer.from(purpose), 32));
  };
  return {
    keyId: ring.active,
    seal(value, context) {
      const header = { format: 2, profile: 'AES-256-GCM-HKDF-SHA256', key_id: ring.active, context };
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key(header.key_id, 'encryption'), nonce);
      cipher.setAAD(Buffer.from(canonical(header)));
      const ciphertext = Buffer.concat([cipher.update(canonical(value), 'utf8'), cipher.final()]);
      return { ...header, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    },
    open(envelope, context) {
      if (envelope?.format !== 2 || envelope.profile !== 'AES-256-GCM-HKDF-SHA256' || envelope.context !== context) throw new Error('Invalid protected record context');
      const { format, profile, key_id } = envelope;
      const decipher = createDecipheriv('aes-256-gcm', key(key_id, 'encryption'), Buffer.from(envelope.nonce, 'base64'));
      decipher.setAAD(Buffer.from(canonical({ format, profile, key_id, context })));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    },
    mac(value, id = ring.active) { return createHmac('sha256', key(id, 'integrity')).update(canonical(value)).digest('hex'); },
  };
}
