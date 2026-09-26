import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { executiveActions, managerSnapshot } from './generated/executive.mjs';
import { canonical, digest } from './crypto.mjs';
import { lock } from './db.mjs';
import { fail } from './repository.mjs';

/** Keep the signer in the backend and commit approval, audit and durable delivery in one transaction. */
export async function approveExecutive(client, repo, user, actionId) {
  if (user.role !== 'leader') throw fail(403, 'Нужны права руководителя');
  const action = executiveActions.find(row => row.id === actionId);
  if (!action) throw fail(422, 'Неизвестное решение');
  await lock(client, `executive:${actionId}`);
  const previous = await repo.get(client, 'executive', actionId);
  if (previous) return previous.value;
  const key = createPrivateKey(await readFile(process.env.SIGNING_KEY_FILE));
  const payload = { actionId, actor: user.id, role: 'leader', approvedAt: new Date().toISOString(), snapshotId: managerSnapshot.id,
    basis: action.basis, messageId: `${managerSnapshot.id}:${actionId}`, target: action.target, delivery: 'queued' };
  const data = Buffer.from(canonical(payload));
  const signature = { algorithm: 'ECDSA-P256-SHA256', digest: digest(data), value: sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' }).toString('hex'), publicKey: createPublicKey(key).export({format:'jwk'}), signedAt: new Date().toISOString() };
  const approval = { ...payload, signature };
  await repo.put(client, 'executive', actionId, approval);
  await repo.append(client, 'executive', { type: 'executive.approved', actor: user.id, ...approval });
  await repo.queue(client, payload.messageId, `executive:${actionId}`, 'executive', approval);
  return approval;
}
