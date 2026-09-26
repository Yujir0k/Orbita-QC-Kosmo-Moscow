import { isProduction, secureFetch } from './security-client';
import { executiveActions, managerSnapshot } from './managerMockData';
import { signExecutivePayload, verifyExecutivePayload, type ExecutiveSignature } from './executive-signature';

export interface ExecutiveApproval {
  actionId: string; actor: string; role: 'leader'; approvedAt: string;
  snapshotId: string; basis: string; messageId: string; target: string; delivery: 'queued';
  signature?: ExecutiveSignature;
}
let serverApprovals: ExecutiveApproval[] = [];
const storageKey = 'orbita-executive-approvals-v1';
export function pendingExecutiveActions(verified: Readonly<Record<string, boolean>>): number {
  return executiveActions.filter(action => verified[action.id] !== true).length;
}
export function readExecutiveApprovals(): ExecutiveApproval[] {
  if (isProduction()) return serverApprovals;
  const raw = localStorage.getItem(storageKey);
  if (!raw) return [];
  const rows: unknown = JSON.parse(raw);
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object'
    || !executiveActions.some(action => action.id === row.actionId && action.target === row.target)
    || row.actor !== 'DIRECTOR-DEMO' || row.role !== 'leader' || row.snapshotId !== managerSnapshot.id
    || typeof row.approvedAt !== 'string' || !Number.isFinite(Date.parse(row.approvedAt))
    || typeof row.basis !== 'string' || typeof row.messageId !== 'string' || row.delivery !== 'queued')
    || new Set(rows.map(row => row.actionId)).size !== rows.length) throw new Error('Сохранённый журнал виз повреждён. Решения не перезаписаны.');
  return rows as ExecutiveApproval[];
}
/** One atomic local write contains both the director's approval and its demo outbox record. */
export function approveExecutiveAction(actionId: string, role: string): ExecutiveApproval[] {
  if (role !== 'leader') throw new Error('Виза доступна только руководителю производства.');
  const action = executiveActions.find(row => row.id === actionId);
  if (!action) throw new Error('Неизвестное управленческое решение.');
  const rows = readExecutiveApprovals();
  if (rows.some(row => row.actionId === actionId)) return rows;
  const next: ExecutiveApproval[] = [...rows, {
    actionId, actor: 'DIRECTOR-DEMO', role: 'leader', approvedAt: new Date().toISOString(),
    snapshotId: managerSnapshot.id, basis: action.basis, messageId: `${managerSnapshot.id}:${actionId}`,
    target: action.target, delivery: 'queued',
  }];
  localStorage.setItem(storageKey, JSON.stringify(next));
  return next;
}

function approvalPayload(approval: ExecutiveApproval) {
  const { signature: _signature, ...payload } = approval;
  return payload;
}
export async function verifyExecutiveApproval(approval: ExecutiveApproval): Promise<boolean> {
  return !!approval.signature && await verifyExecutivePayload(approvalPayload(approval), approval.signature);
}
/** Existing unsigned visas remain intact and can be signed without changing their approval time. */
export async function signExecutiveAction(actionId: string, role: string): Promise<ExecutiveApproval[]> {
  if (isProduction()) {
    const response = await secureFetch('/api/executive/approvals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actionId }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    serverApprovals = result.approvals; return serverApprovals;
  }
  if (role !== 'leader') throw new Error('Подпись доступна только руководителю производства.');
  const action = executiveActions.find(row => row.id === actionId);
  if (!action) throw new Error('Неизвестное управленческое решение.');
  const before = readExecutiveApprovals();
  const existing = before.find(row => row.actionId === actionId);
  if (existing?.signature) {
    if (!await verifyExecutiveApproval(existing)) throw new Error('Подпись сохранённой визы не прошла проверку.');
    return before;
  }
  const approval: ExecutiveApproval = existing ?? {
    actionId, actor: 'DIRECTOR-DEMO', role: 'leader', approvedAt: new Date().toISOString(),
    snapshotId: managerSnapshot.id, basis: action.basis, messageId: `${managerSnapshot.id}:${actionId}`, target: action.target, delivery: 'queued',
  };
  const signed = { ...approval, signature: await signExecutivePayload(approvalPayload(approval)) };
  const latest = readExecutiveApprovals();
  const concurrent = latest.find(row => row.actionId === actionId);
  if (concurrent?.signature) {
    if (!await verifyExecutiveApproval(concurrent)) throw new Error('Подпись сохранённой визы не прошла проверку.');
    return latest;
  }
  if (concurrent && JSON.stringify(approvalPayload(concurrent)) !== JSON.stringify(approvalPayload(approval))) throw new Error('Виза изменена в другом окне. Обновите страницу.');
  const next = [...latest.filter(row => row.actionId !== actionId), signed];
  localStorage.setItem(storageKey, JSON.stringify(next));
  return next;
}

/** Read approvals saved by any authorized workstation. */
export async function loadExecutiveApprovals(): Promise<ExecutiveApproval[]> {
  if (!isProduction()) return readExecutiveApprovals();
  const response = await secureFetch('/api/executive/approvals');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  serverApprovals = result.approvals;
  return serverApprovals;
}
