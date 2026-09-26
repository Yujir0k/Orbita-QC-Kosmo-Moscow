import { actionDeliveries, performAction, reconcileSecureEvents, restoreDemoState, snapshotDemoState, type Delivery, type WorkflowAction } from './domain';
import type { RoleId } from './navigation';

export type SecuritySession = { authenticated: true; user: { id: string; role: RoleId; lineIds: string[] }; csrfToken: string };
let current: SecuritySession | null = null;
export const currentSecurityUser = () => current?.user ?? null;

export async function secureFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (!['GET', 'HEAD'].includes(method)) {
    if (!current) throw new Error('Сначала войдите в систему');
    headers.set('X-CSRF-Token', current.csrfToken);
  }
  return fetch(input, { ...init, credentials: 'same-origin', headers });
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await secureFetch(url, init);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value as T;
}

export async function loadSecuritySession(): Promise<SecuritySession | null> {
  const result = await json<{ authenticated: boolean } & Partial<SecuritySession>>('/api/security/session');
  current = result.authenticated ? result as SecuritySession : null;
  if (current) await synchronizeSecureHistory();
  return current;
}

export async function loginSecurity(id: string, password: string): Promise<SecuritySession> {
  const response = await fetch('/api/security/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, password }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  current = result as SecuritySession;
  await synchronizeSecureHistory();
  return current;
}

export async function logoutSecurity(): Promise<void> {
  if (!current) return;
  const response = await secureFetch('/api/security/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!response.ok && response.status !== 401) {
    const result = await response.json();
    throw new Error(result.error ?? `HTTP ${response.status}`);
  }
  current = null;
}

export async function synchronizeSecureHistory(): Promise<void> {
  const result = await json<{ deliveries: Delivery[] }>('/api/security/events');
  reconcileSecureEvents(result.deliveries);
}

/** A human action is displayed only after the server authorizes and durably audits it. */
export async function securePerformAction(item: string, role: RoleId, action: WorkflowAction, reason: string, includePhoto = true, caseId?: string): Promise<void> {
  const statedReason = reason.trim();
  const approval = await json<{ actionId: string; actorId: string; role: RoleId }>('/api/security/actions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId: item, action, reason: statedReason, caseId }),
  });
  const before = snapshotDemoState();
  try {
    performAction(item, role, action, statedReason, approval.actorId, includePhoto, caseId, approval);
    const deliveries = actionDeliveries(approval.actionId);
    await json('/api/security/actions/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actionId: approval.actionId, deliveries }) });
  } catch (error) {
    restoreDemoState(before);
    throw error;
  }
}
