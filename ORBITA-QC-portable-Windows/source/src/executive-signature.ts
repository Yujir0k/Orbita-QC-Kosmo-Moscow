/** Verifiable demo signatures, without a trusted certificate or qualified-signature claims. */
export interface ExecutiveSignature {
  algorithm: 'ECDSA-P256-SHA256'; digest: string; value: string; publicKey: JsonWebKey; signedAt: string;
}
export function canonicalPayload(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPayload).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalPayload(entry)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
function unhex(value: string) {
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) throw new Error('Некорректная подпись.');
  return Uint8Array.from(value.match(/../g)!, byte => parseInt(byte, 16));
}
export async function signExecutivePayload(payload: unknown): Promise<ExecutiveSignature> {
  const data = new TextEncoder().encode(canonicalPayload(payload));
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const digest = hex(await crypto.subtle.digest('SHA-256', data));
  const value = hex(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, data));
  const signature: ExecutiveSignature = { algorithm: 'ECDSA-P256-SHA256', digest, value, publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey), signedAt: new Date().toISOString() };
  if (!await verifyExecutivePayload(payload, signature)) throw new Error('Проверка демонстрационной ЭЦП не пройдена.');
  return signature;
}
export async function verifyExecutivePayload(payload: unknown, signature: ExecutiveSignature): Promise<boolean> {
  try {
    if (signature.algorithm !== 'ECDSA-P256-SHA256') return false;
    const data = new TextEncoder().encode(canonicalPayload(payload));
    if (hex(await crypto.subtle.digest('SHA-256', data)) !== signature.digest) return false;
    const publicKey = await crypto.subtle.importKey('jwk', signature.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, unhex(signature.value), data);
  } catch { return false; }
}
