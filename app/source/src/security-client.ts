import { useAuthoritativeReceipts, ingestState, useMediaCatalog, mediaIndex, actionDeliveries, cases, performAction, reconcileMobileEvents, reconcileSecureEvents, recordCauseReview, recordManualMeasurement, recordMasterProcessReport, requestInvestigationEvidence, restoreDemoState, snapshotDemoState, useAuthoritativeHistory, type CauseReviewInput, type Delivery, type MasterProcessInput, type MasterReworkDetails, type WorkflowAction } from './domain';
import type { EvidenceRecipient } from './investigation-services';
import type { RoleId } from './navigation';

export type SecuritySession = { authenticated: true; user: { id: string; role: RoleId; lineIds: string[] }; csrfToken: string };
let current: SecuritySession | null = null;
export const isProduction = () => typeof window !== 'undefined' && Boolean((window as unknown as { __ORBITA_PRODUCTION__?: boolean }).__ORBITA_PRODUCTION__);
export const isDemo = () => typeof window !== 'undefined' && Boolean((window as unknown as { __ORBITA_DEMO__?: boolean }).__ORBITA_DEMO__);
let historyCursor = '';
let revisions: Record<string, string> = {};
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
  historyCursor = '';
  useAuthoritativeReceipts({outcomes:[],counts:{accepted:0,late:0,duplicate:0,error:0}});
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
  const result = await json<{ deliveries: Delivery[]; authoritative?: boolean; revisions?: Record<string, string>; media?: typeof mediaIndex; cursor?: string; unchanged?: boolean }>(`/api/security/events?cursor=${encodeURIComponent(historyCursor)}`);
  if (isProduction() && current?.user.role === 'administrator') {
    const receipts = await json<Pick<ReturnType<typeof ingestState>, 'outcomes' | 'counts'>>('/api/events/receipts');
    useAuthoritativeReceipts(receipts);
  }
  if (result.unchanged) return;
  historyCursor = result.cursor ?? '';
  if (result.media) useMediaCatalog(result.media);
  if (result.authoritative) { revisions = result.revisions ?? {}; useAuthoritativeHistory(result.deliveries); return; }
  reconcileSecureEvents(result.deliveries);
  await synchronizeMobileHistory();
}

export async function synchronizeMobileHistory(): Promise<void> {
  if (isProduction()) { await synchronizeSecureHistory(); return; }
  const result = await json<{ deliveries: Delivery[] }>('/api/mobile/events');
  reconcileMobileEvents(result.deliveries);
}

type Approval = { actionId: string; actorId: string; role: RoleId };

async function secureAction<T>(item: string, action: string, reason: string, caseId: string | undefined, record: (approval: Approval) => T, details?: Record<string, unknown>): Promise<T> {
  const statedReason = reason.trim();
  if (isProduction()) {
    const result = await json<{ result: T }>('/api/workflow/commands', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ itemId: item, action, reason: statedReason, caseId, expectedRevision: revisions[item], ...details }),
    });
    await synchronizeSecureHistory();
    return result.result;
  }
  const approval = await json<Approval>('/api/security/actions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId: item, action, reason: statedReason, caseId, ...details }),
  });
  const before = snapshotDemoState();
  try {
    const result = record(approval);
    const deliveries = actionDeliveries(approval.actionId);
    await json('/api/security/actions/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actionId: approval.actionId, deliveries }) });
    return result;
  } catch (error) {
    restoreDemoState(before);
    throw error;
  }
}

/** Open or switch a local demonstration role without an account form. */
export async function selectDemoRole(role: RoleId): Promise<SecuritySession> {
  const response = await fetch('/api/security/demo-session', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  historyCursor = '';
  useAuthoritativeReceipts({outcomes:[],counts:{accepted:0,late:0,duplicate:0,error:0}});
  current = result as SecuritySession;
  const bootstrap = await json<{ preferences: unknown }>('/api/data/bootstrap');
  (window as unknown as { __ORBITA_PREFERENCES__: unknown }).__ORBITA_PREFERENCES__ = bootstrap.preferences;
  await synchronizeSecureHistory();
  return current;
}

/** A human action is displayed only after the server authorizes and durably audits it. */
export async function securePerformAction(item: string, role: RoleId, action: WorkflowAction, reason: string, includePhoto = true, caseId?: string, measurement?: { value: number; instrumentId: string; calibrationConfirmed: boolean }, missingPhotoConfirmation?: { observationEventId: string; acknowledged: true }, masterDetails?: MasterReworkDetails): Promise<void> {
  await secureAction(item, action, reason, caseId, approval => {
    performAction(item, role, action, reason.trim(), approval.actorId, includePhoto, caseId, measurement, missingPhotoConfirmation, masterDetails, approval);
  }, { includePhoto, ...(masterDetails ? { masterDetails } : {}), ...(measurement ? { measurement } : {}), ...(missingPhotoConfirmation ? { missingPhotoConfirmation } : {}) });
}

/** Authorize and audit an instrument reading independently of the quality decision. */
export async function secureRecordManualMeasurement(item: string, caseId: string, parameter: string, value: number, instrumentId: string, calibrated: boolean, criteria?: { lower?: number; upper?: number; document: string }): Promise<string> {
  return secureAction(item, 'manual_measurement', `Замер ${parameter}: ${value} мм, прибор ${instrumentId}`, caseId,
    approval => recordManualMeasurement(item, caseId, parameter, value, instrumentId, approval.actorId, calibrated, criteria, approval),
    { measurement: { parameter, value, instrumentId, calibrated, criteria } });
}

/** Save a technologist's conclusion to the shared audited event history. */
export async function secureRecordCauseReview(input: CauseReviewInput): Promise<string> {
  const selected = cases.find(record => record.id === input.caseId);
  if (!selected) throw new Error('Случай не найден');
  return secureAction(selected.item, 'cause_review_detailed', input.reason, input.caseId,
    approval => recordCauseReview({ ...input, actor: approval.actorId }, approval), { details: input });
}

/** Route a request for additional facts to the assigned role and persist it. */
export async function secureRequestInvestigationEvidence(caseId: string, recipient: EvidenceRecipient, reason: string): Promise<string> {
  const selected = cases.find(record => record.id === caseId);
  if (!selected) throw new Error('Случай не найден');
  return secureAction(selected.item, 'evidence_request', reason, caseId,
    approval => requestInvestigationEvidence(caseId, recipient, reason, approval.actorId, approval), { recipient });
}

/** Record the master's factual operation report in the shared history. */
export async function secureRecordMasterProcessReport(input: MasterProcessInput): Promise<string> {
  const selected = cases.find(record => record.id === input.caseId);
  if (!selected) throw new Error('Случай не найден');
  return secureAction(selected.item, 'master_process_report', input.comment, input.caseId,
    approval => recordMasterProcessReport({ ...input, actor: approval.actorId }, approval), { details: input });
}

/** Persist validated event batches, including rejected and duplicate delivery receipts. */
export async function secureImportText(text: string): Promise<{kind: string}[]> {
  let deliveries: unknown[];
  try { const parsed: unknown = JSON.parse(text); deliveries = Array.isArray(parsed) ? parsed : [parsed]; }
  catch { deliveries = text.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line) as unknown; } catch { return { invalid: line }; } }); }
  const outcomes: {kind: string}[] = [];
  for (let offset = 0; offset < deliveries.length; offset += 200) {
    const result = await json<{outcomes: {kind: string}[]}>('/api/events/ingest', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({deliveries:deliveries.slice(offset,offset+200)}) });
    outcomes.push(...result.outcomes);
  }
  await synchronizeSecureHistory();
  return outcomes;
}

/** Upload immutable evidence before linking it from the master's report. */
export async function uploadEvidence(itemId: string, file: File): Promise<string> {
  if (file.size > 12 * 1024 * 1024) throw new Error('Лимит фотографии — 12 МиБ');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const result = await json<{ asset: typeof mediaIndex[number] }>('/api/media', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId, contentType: file.type, data: btoa(binary) }) });
  await synchronizeSecureHistory();
  return result.asset.asset_id;
}
