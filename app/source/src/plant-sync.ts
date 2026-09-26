import { deliveries, events, importText, type Delivery, type QualityEvent } from './domain';
import { currentSecurityUser, secureFetch, isProduction } from './security-client';

type MesConfig = { configured: boolean };
type MesBatch = { deliveries: Delivery[] };

async function post<T>(url: string, body?: unknown): Promise<T> {
  const response = await secureFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? '{}' : JSON.stringify(body) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

/** Move MES facts and recorded quality decisions without a second operator form. */
export function startPlantSync(): () => void {
  if (isProduction()) return () => {}; // The durable server worker owns MES exchange.
  let stopped = false;
  let busy = false;
  const attemptedImports = new Set<string>();
  const sync = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const stateResponse = await secureFetch('/api/plant/mes/configured');
      if (stopped) return;
      if (!stateResponse.ok) return; // Vite-only development mode has no portable API.
      const state = await stateResponse.json() as MesConfig;
      if (!state.configured) return;
      try {
        const batch = await post<MesBatch>('/api/plant/mes/sync');
        if (stopped) return;
        const known = new Set(deliveries.map(row => row.message.event_id));
        const incoming = batch.deliveries.filter(row => !known.has(row.message.event_id) && !attemptedImports.has(row.message.event_id));
        if (incoming.length) {
          for (const row of incoming) attemptedImports.add(row.message.event_id);
          importText(JSON.stringify(incoming));
        }
      } catch { /* Outbound decisions continue even when the inbound MES feed is unavailable. */ }
      if (currentSecurityUser()?.role === 'controller') {
        const decisions = events.filter((event): event is QualityEvent => event.source_id === 'ORBITA-UI' && event.event_type === 'quality_decision' && typeof event.data.security_action_id === 'string');
        for (const event of decisions) await post('/api/plant/mes/decisions', event);
      }
    } catch { /* The server keeps its error and retry journal; the next poll resumes. */ }
    finally { busy = false; }
  };
  void sync();
  const timer = window.setInterval(() => void sync(), 5000);
  return () => { stopped = true; window.clearInterval(timer); };
}
