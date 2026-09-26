import { generateKeyPairSync, encapsulate, decapsulate, hkdfSync, randomBytes, createCipheriv, createDecipheriv, createPublicKey, createPrivateKey } from 'node:crypto';
import { canonical, digest } from './crypto.mjs';

/** Exportable archival profile: both X25519 and ML-KEM-768 secrets feed HKDF; private keys stay in the recipient key store. */
export function generateArchiveRecipient(keyId) {
  const classical = generateKeyPairSync('x25519');
  const quantum = generateKeyPairSync('ml-kem-768');
  const exportKey = (key, type) => key.export({ format: 'pem', type });
  return { keyId, public: { x25519: exportKey(classical.publicKey,'spki'), mlkem: exportKey(quantum.publicKey,'spki') },
    private: { x25519: exportKey(classical.privateKey,'pkcs8'), mlkem: exportKey(quantum.privateKey,'pkcs8') } };
}
const derive = (a,b,header) => Buffer.from(hkdfSync('sha256',Buffer.concat([a,b]),Buffer.from('orbita-archive-v1'),Buffer.from(digest(header),'hex'),32));

export function sealArchive(value, recipient, sourceId) {
  const a=encapsulate(createPublicKey(recipient.public.x25519));
  const b=encapsulate(createPublicKey(recipient.public.mlkem));
  const header={format:1,profile:'X25519+ML-KEM-768/HKDF-SHA256/AES-256-GCM',key_id:recipient.keyId,source_id:sourceId,
    encapsulations:{x25519:a.ciphertext.toString('base64'),mlkem:b.ciphertext.toString('base64')}};
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',derive(a.sharedKey,b.sharedKey,header),nonce);
  cipher.setAAD(Buffer.from(canonical(header)));
  const ciphertext=Buffer.concat([cipher.update(canonical(value),'utf8'),cipher.final()]);
  return {...header,nonce:nonce.toString('base64'),ciphertext:ciphertext.toString('base64'),tag:cipher.getAuthTag().toString('base64')};
}

export function openArchive(envelope, recipients) {
  const recipient=recipients[envelope.key_id];
  if (!recipient) throw new Error('Archive recipient key unavailable');
  if(envelope.format!==1 || envelope.profile!=='X25519+ML-KEM-768/HKDF-SHA256/AES-256-GCM') throw new Error('Unsupported archive profile');
  const {format,profile,key_id,source_id,encapsulations}=envelope;
  const header={format,profile,key_id,source_id,encapsulations};
  const a=decapsulate(createPrivateKey(recipient.private.x25519),Buffer.from(encapsulations.x25519,'base64'));
  const b=decapsulate(createPrivateKey(recipient.private.mlkem),Buffer.from(encapsulations.mlkem,'base64'));
  const decipher=createDecipheriv('aes-256-gcm',derive(a,b,header),Buffer.from(envelope.nonce,'base64'));
  decipher.setAAD(Buffer.from(canonical(header)));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString('utf8'));
}
