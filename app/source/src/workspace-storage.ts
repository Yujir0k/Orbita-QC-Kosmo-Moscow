import { currentSecurityUser, isProduction, secureFetch } from './security-client';
type Saved = { value: unknown; revision: number };
const revisions = new Map<string, number>();
const pending = new Map<string, Promise<void>>();
const runtime = () => (window as unknown as { __ORBITA_PREFERENCES__?: Record<string, Saved> }).__ORBITA_PREFERENCES__ ?? {};

/** Read the authenticated user's server snapshot; browser storage is used only in portable tests. */
export function readWorkspaceValue(key: string): unknown {
  if (isProduction()) {
    const saved = runtime()[key]; revisions.set(key, saved?.revision ?? 0); return saved?.value ?? null;
  }
  return JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
}

/** Serialize autosaves and preserve optimistic concurrency between browser windows. */
export async function saveWorkspaceValue(key: string, value: unknown): Promise<void> {
  if (!isProduction()) { localStorage.setItem(key, JSON.stringify(value)); return; }
  const before = pending.get(key) ?? Promise.resolve();
  const actor = currentSecurityUser()?.id;
  const task = (async () => {
    await before;
    if (currentSecurityUser()?.id !== actor) throw new Error('Рабочее место изменилось. Откройте черновик в исходной роли.');
    const response = await secureFetch(`/api/preferences/${encodeURIComponent(key)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value, revision: revisions.get(key) ?? 0 }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Не удалось сохранить запись');
    revisions.set(key, result.revision);
    runtime()[key] = result as Saved;
  })();
  pending.set(key, task);
  try { await task; } finally { if (pending.get(key) === task) pending.delete(key); }
}
