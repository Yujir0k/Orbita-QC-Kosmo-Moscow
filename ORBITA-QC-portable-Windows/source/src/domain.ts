import demo from './demo-data.json';
import type { RoleId } from './navigation';

export interface Finding { finding_id: string; defect_type_id: string; component_id: string; region: string; severity: string }
export interface EventData {
  inspection_result?: string; observation_quality?: string; confidence?: number | null; defects?: Finding[];
  inspection_point_id?: string; method?: string; finding_refs?: string[]; decision?: string; disposition?: string;
  reason?: string; cause_type?: string; status?: string; basis_event_ids?: string[]; evidence_event_ids?: string[];
  evidence_refs?: string[]; triage_priority?: string; capture_context?: Record<string, unknown>;
  operation_id?: string; previous_operation_run_id?: string | null; state?: string; parameter?: string;
  value?: number | boolean; unit?: string; configured_limit?: number; action_type?: string; procedure_step_id?: string; reason_code?: string;
  measurement?: { value: number; unit: string; lower_limit?: number }; executor_id?: string; comment?: string;
  [key: string]: unknown;
}
export interface QualityEvent { event_id: string; event_type: string; schema_version: string; occurred_at: string; source_id: string; item_id: string; item_type_id: string; line_id: string; station_id: string; shift_id: string; operation_run_id?: string; actor_id?: string; equipment_id?: string; analyzer_version?: string; data: EventData }
export interface Delivery { delivery_id: string; deliver_at: string; message: QualityEvent }
export interface Product { id: string; item_type_id: string; work_order_id: string; assembly_revision: string; components: { id: string; component_type_id: string }[] }
export interface MediaAsset { asset_id: string; item_id: string; path_from_quality_dataset: string; capture_source: string; stage: string; description: string }
export type Scope = 'all' | 'SHIFT-A' | 'SHIFT-B';
type OutcomeKind = 'accepted' | 'duplicate' | 'late' | 'error';
export interface IngestOutcome { delivery_id: string; event_id: string; item_id: string; kind: OutcomeKind; reason: string; received_at?: string; source_id?: string }
interface StoredState { sourceIds: string[]; other: Delivery[]; pendingIds: string[]; outcomes: IngestOutcome[]; counts: Record<OutcomeKind, number>; playing: boolean }
const dataset = demo as unknown as { items: Product[]; catalogs: typeof demo.catalogs; media: MediaAsset[]; source: Delivery[]; inspectionPlan: typeof demo.inspectionPlan; profiles: typeof demo.profiles };
const storageKey = 'orbita-qc-expanded-v2';
export const items = dataset.items;
export const catalogs = dataset.catalogs;
export const inspectionPlan = dataset.inspectionPlan;
export const profiles = dataset.profiles.profiles;
export const mediaIndex = dataset.media;
export const sourceDeliveries = dataset.source;
const sourceById = new Map(sourceDeliveries.map(row => [row.delivery_id, row]));
const itemById = new Map(items.map(item => [item.id, item]));
const mediaById = new Map(mediaIndex.map(asset => [asset.asset_id, asset]));
export const defectNames: Record<string, string> = { DENT: 'Вмятина', SCRATCH: 'Царапина', BURR: 'Заусенец', CHIP: 'Скол', UNASSESSABLE: 'Нужна доппроверка' };
export const stationNames: Record<string, string> = Object.fromEntries(catalogs.stations.map(s => [s.id, s.name]));
export const eventNames: Record<string, string> = { item_received: 'Поступление изделия', inspection_result: 'Наблюдение контроля', operation_started: 'Начало операции', operation_finished: 'Завершение операции', operation_paused: 'Пауза операции', quality_decision: 'Решение контролёра', cause_review: 'Заключение технолога', technical_disposition: 'Допустимость доработки', master_action: 'Работа мастера', manual_measurement: 'Ручной замер', machine_state: 'Состояние оборудования', operator_action: 'Наблюдение действия' };
export const decisionNames: Record<string, string> = { confirmed: 'Подтверждено', rejected: 'Признак отклонён', release_after_rework: 'Выпуск после контроля', additional_check: 'Доппроверка', scrap_approved: 'Списание', recheck: 'Повторная проверка' };
export const resultNames: Record<string, string> = { signs_detected: 'Есть признаки', no_signs_detected: 'Признаков не выявлено', unable_to_assess: 'Оценить невозможно' };
export const time = (value: string): string => new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
const validDate = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const textField = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, part: unknown) => part && typeof part === 'object' && !Array.isArray(part) ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part);

/** Validate a delivery before it changes the event history. */
export function validateDelivery(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'Ожидается объект доставки';
  const row = raw as Partial<Delivery>;
  if (!textField(row.delivery_id)) return 'Нет delivery_id';
  if (!validDate(row.deliver_at)) return 'Некорректное deliver_at';
  if (!row.message || typeof row.message !== 'object') return 'Нет message';
  const e = row.message as Partial<QualityEvent>;
  for (const key of ['event_id', 'event_type', 'schema_version', 'occurred_at', 'source_id', 'item_id', 'item_type_id', 'line_id', 'station_id', 'shift_id'] as const) if (!textField(e[key])) return `Нет ${key}`;
  if (!['1.0', '2.0'].includes(e.schema_version!)) return `Неподдерживаемая версия ${e.schema_version}`;
  if (!validDate(e.occurred_at)) return 'Некорректное occurred_at';
  if (!Object.hasOwn(eventNames, e.event_type!)) return `Неизвестный event_type ${e.event_type}`;
  const item = itemById.get(e.item_id!);
  if (!item) return `Неизвестное изделие ${e.item_id}`;
  if (item.item_type_id !== e.item_type_id) return 'Тип изделия не совпадает со справочником';
  if (!catalogs.lines.some(line => line.id === e.line_id)) return `Неизвестная линия ${e.line_id}`;
  if (!catalogs.stations.some(station => station.id === e.station_id)) return `Неизвестный участок ${e.station_id}`;
  if (!catalogs.shifts.some(shift => shift.id === e.shift_id)) return `Неизвестная смена ${e.shift_id}`;
  if (!e.data || typeof e.data !== 'object' || Array.isArray(e.data)) return 'Нет data';
  if (e.event_type === 'inspection_result') {
    const d = e.data;
    if (!textField(d.inspection_point_id) || !['signs_detected', 'no_signs_detected', 'unable_to_assess'].includes(d.inspection_result ?? '') || !['good', 'poor'].includes(d.observation_quality ?? '') || !Array.isArray(d.defects) || !textField(d.method) || !Array.isArray(d.evidence_refs)) return 'Недостаточные поля результата контроля';
    if (d.confidence != null && (typeof d.confidence !== 'number' || d.confidence < 0 || d.confidence > 1)) return 'Уверенность вне диапазона 0–1';
    if (e.schema_version === '2.0' && (!textField(d.triage_priority) || !d.capture_context || typeof d.capture_context !== 'object')) return 'Нет полей результата версии 2.0';
    for (const finding of d.defects) if (!textField(finding.finding_id) || !textField(finding.defect_type_id) || !item.components.some(c => c.id === finding.component_id)) return 'Некорректная ссылка на признак или компонент';
  }
  if (['operation_started', 'operation_finished', 'operation_paused', 'manual_measurement'].includes(e.event_type!) && !textField(e.operation_run_id)) return 'Нет operation_run_id';
  if (['quality_decision', 'master_action', 'technical_disposition', 'manual_measurement'].includes(e.event_type!) && !textField(e.actor_id)) return 'Нет actor_id';
  if (e.data.evidence_refs && (!Array.isArray(e.data.evidence_refs) || e.data.evidence_refs.some(ref => !mediaById.has(ref) || mediaById.get(ref)?.item_id !== e.item_id))) return 'Неизвестное или чужое медиа';
  return null;
}

function emptyState(): StoredState { return { sourceIds: [], other: [], pendingIds: [], outcomes: [], counts: { accepted: 0, duplicate: 0, late: 0, error: 0 }, playing: false }; }
let state: StoredState = emptyState();
let version = 0;
const listeners = new Set<() => void>();
const notify = () => { version += 1; listeners.forEach(listener => listener()); };
export const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
export const getVersion = () => version;
export const ingestState = () => state;
export const snapshotDemoState = (): StoredState => structuredClone(state);
export function restoreDemoState(snapshot: StoredState) { state = structuredClone(snapshot); save(); }
const persist = () => { try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Browser storage may be disabled. */ } };
const save = () => { refresh(); persist(); notify(); };

export let deliveries: Delivery[] = [];
export let events: QualityEvent[] = [];
export let cases: Case[] = [];
export let operations: Operation[] = [];
export let tasks: Task[] = [];
const originalById = () => new Map(events.map(event => [event.event_id, event]));
/** Ingest exact repeats once and place late events by occurrence time in projections. */
function accept(row: Delivery, log = true): IngestOutcome {
  const error = validateDelivery(row);
  const known = originalById().get(row?.message?.event_id);
  const metadata = { received_at: validDate(row?.deliver_at) ? row.deliver_at : new Date().toISOString(), source_id: textField(row?.message?.source_id) ? row.message.source_id : 'UNKNOWN' };
  let outcome: IngestOutcome;
  if (error) outcome = { delivery_id: row?.delivery_id ?? '?', event_id: row?.message?.event_id ?? '?', item_id: row?.message?.item_id ?? '?', kind: 'error', reason: error, ...metadata };
  else if (known && canonical(known) !== canonical(row.message)) outcome = { delivery_id: row.delivery_id, event_id: row.message.event_id, item_id: row.message.item_id, kind: 'error', reason: 'Конфликт: тот же event_id с другим содержимым', ...metadata };
  else if (known) outcome = { delivery_id: row.delivery_id, event_id: row.message.event_id, item_id: row.message.item_id, kind: 'duplicate', reason: 'Точный повтор event_id', ...metadata };
  else {
    const late = events.some(e => e.item_id === row.message.item_id && Date.parse(e.occurred_at) > Date.parse(row.message.occurred_at));
    outcome = { delivery_id: row.delivery_id, event_id: row.message.event_id, item_id: row.message.item_id, kind: late ? 'late' : 'accepted', reason: late ? 'Поздняя доставка; история отсортирована по времени события' : 'Принято', ...metadata };
  }
  if (outcome.kind !== 'error') {
    if (sourceById.has(row.delivery_id)) state.sourceIds.push(row.delivery_id);
    else state.other.push(row);
    state.pendingIds = state.pendingIds.filter(id => id !== row.delivery_id);
    deliveries.push(row);
    if (!known) events.push(row.message);
  }
  state.counts[outcome.kind] += 1;
  if (log) state.outcomes = [outcome, ...state.outcomes].slice(0, 100);
  return outcome;
}
/** Accept JSON or JSONL, keeping invalid rows in the quarantine log. */
export function importText(input: string): IngestOutcome[] {
  const trimmed = input.trim();
  const rows: unknown[] = [];
  try { const parsed: unknown = JSON.parse(trimmed); rows.push(...(Array.isArray(parsed) ? parsed : [parsed])); }
  catch { for (const line of trimmed.split(/\r?\n/)) if (line.trim()) { try { rows.push(JSON.parse(line)); } catch { rows.push({ delivery_id: `PARSE-${rows.length + 1}`, deliver_at: new Date().toISOString(), message: null }); } } }
  const result: IngestOutcome[] = [];
  for (const raw of rows) { result.push(accept(raw as Delivery)); if (result.at(-1)?.kind !== 'error') { events.sort(sortEvents); } }
  save(); return result;
}
/** Server receipts are authoritative for human actions; localStorage is only a view cache. */
export function reconcileSecureEvents(approved: Delivery[]) {
  state.other = state.other.filter(row => row.message?.source_id !== 'ORBITA-UI');
  refresh();
  for (const row of approved) accept(row, false);
  events.sort(sortEvents);
  for (const item of new Set(approved.map(row => row.message.item_id))) advanceItem(item);
  save();
}
/** Rebuild robot observations from the server, never trusting a browser-only copy. */
export function reconcileMobileEvents(received: Delivery[]) {
  state.other = state.other.filter(row => row.message?.source_id !== 'MOBILE-EMU');
  refresh();
  for (const row of received) accept(row, false);
  events.sort(sortEvents);
  save();
}
export const actionDeliveries = (actionId: string): Delivery[] => deliveries.filter(row => row.message.data.security_action_id === actionId);
const sortEvents = (a: QualityEvent, b: QualityEvent) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.event_id.localeCompare(b.event_id);
function refresh() {
  deliveries = [...state.sourceIds.map(id => sourceById.get(id)).filter((row): row is Delivery => !!row), ...state.other];
  const seen = new Set<string>();
  events = deliveries.map(row => row.message).filter(e => { if (seen.has(e.event_id)) return false; seen.add(e.event_id); return true; }).sort(sortEvents);
  cases = projectCases(events); operations = projectOperations(events); tasks = projectTasks(events);
}
function bootstrap() {
  state = emptyState(); refresh();
  const blocked = new Set<string>();
  for (const row of sourceDeliveries) {
    const e = row.message;
    if (blocked.has(e.item_id)) { state.pendingIds.push(row.delivery_id); continue; }
    accept(row, false);
    if (e.event_type === 'inspection_result' && ['signs_detected', 'unable_to_assess'].includes(e.data.inspection_result ?? '')) blocked.add(e.item_id);
  }
  state.outcomes = [];
  save();
}
try {
  const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
  if (saved && typeof saved === 'object' && Array.isArray((saved as StoredState).sourceIds) && Array.isArray((saved as StoredState).pendingIds)) { state = saved as StoredState; state.playing = false; refresh(); }
  else bootstrap();
} catch { bootstrap(); }
/** Reset the built-in stream to open work before any human decisions. */
export function resetDemo() { bootstrap(); }
function hasDecision(item: string, decision: string) { return events.some(e => e.item_id === item && e.event_type === 'quality_decision' && e.data.decision === decision); }
function countDecision(item: string, decision: string) { return events.filter(e => e.item_id === item && e.event_type === 'quality_decision' && e.data.decision === decision).length; }
function allowed(row: Delivery): boolean {
  const e = row.message; const item = e.item_id;
  if (item === 'ITEM-018') return true;
  if (item === 'ITEM-013') return e.data.operation_id === 'OP-REWORK' ? events.some(x => x.item_id === item && x.event_type === 'technical_disposition' && x.data.disposition === 'rework_allowed') : hasDecision(item, 'release_after_rework');
  if (item === 'ITEM-014') { if (e.data.operation_id === 'OP-REWORK') return (e.operation_run_id?.endsWith('-2') ? countDecision(item, 'confirmed') >= 2 : countDecision(item, 'confirmed') >= 1); return hasDecision(item, 'release_after_rework'); }
  if (item === 'ITEM-015') return hasDecision(item, 'additional_check');
  if (item === 'ITEM-016') return hasDecision(item, 'rejected');
  if (item === 'ITEM-017') return e.data.operation_id === 'OP-REWORK' ? hasDecision(item, 'confirmed') : hasDecision(item, 'release_after_rework');
  return events.some(x => x.item_id === item && x.event_type === 'quality_decision');
}
/** Deliver one currently eligible external message. */
export function nextStep(): IngestOutcome | null {
  const id = state.pendingIds.find(pending => { const row = sourceById.get(pending); return row && allowed(row); });
  if (!id) return null;
  const outcome = accept(sourceById.get(id)!); save(); return outcome;
}
/** Release the external operation stage that the last human action unlocked. */
function advanceItem(item: string) {
  for (const id of [...state.pendingIds]) { const row = sourceById.get(id); if (row?.message.item_id === item && allowed(row)) { accept(row); events.sort(sortEvents); } }
}
let timer: number | undefined;
export function setPlaying(playing: boolean) {
  state.playing = playing;
  if (timer) window.clearInterval(timer);
  if (playing) timer = window.setInterval(() => { if (!nextStep()) setPlaying(false); }, 350);
  save();
}
export async function loadErrorDemo(): Promise<IngestOutcome[]> {
  const response = await fetch(`${import.meta.env.BASE_URL}demo/ingest_stream.jsonl`);
  const rows = (await response.text()).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Delivery).filter(row => row.delivery_id.startsWith('BAD-'));
  return importText(rows.map(row => JSON.stringify(row)).join('\n'));
}
/** Return each captured asset once, even when several events cite the same image. */
export function mediaFor(item: string) {
  const seen = new Set<string>();
  return eventsFor(item).flatMap(event => (event.data.evidence_refs ?? []).map(ref => ({ event, asset: mediaById.get(ref) })))
    .filter((entry): entry is { event: QualityEvent; asset: MediaAsset } => {
      if (!entry.asset || seen.has(entry.asset.asset_id)) return false;
      seen.add(entry.asset.asset_id);
      return true;
    });
}
export const mediaUrl = (asset: MediaAsset) => `${import.meta.env.BASE_URL}media/${asset.path_from_quality_dataset.split('/').at(-1)}`;
export function eventsFor(item: string): QualityEvent[] { return events.filter(event => event.item_id === item); }
export function deliveryFor(eventId: string) { return deliveries.find(row => row.message.event_id === eventId); }
export function inScope(event: QualityEvent, scope: Scope): boolean { return scope === 'all' || event.shift_id === scope; }

export interface Case { id: string; item: string; type: string; region: string; component: string; observations: QualityEvent[]; refs: string[]; decisions: QualityEvent[]; review?: QualityEvent; confirmed: boolean; status: string; tone: 'red' | 'green' | 'amber' | 'blue'; severity: string; priority: number; why: string }
/** Keep repeated observations of a defect in one historical case across rework runs. */
export function projectCases(input: QualityEvent[]): Case[] {
  const map = new Map<string, Case>();
  for (const event of input.filter(e => e.event_type === 'inspection_result')) {
    const findings = event.data.defects?.length ? event.data.defects : event.data.inspection_result === 'unable_to_assess' ? [{ finding_id: 'UNABLE', defect_type_id: 'UNASSESSABLE', component_id: '', region: event.data.inspection_point_id ?? '', severity: 'medium' }] : [];
    for (const finding of findings) {
      const key = [event.item_id, finding.component_id, finding.region, finding.defect_type_id].join('|');
      const primaryBody = itemById.get(event.item_id)?.components.find(component => component.component_type_id === 'BODY')?.id;
      const componentSuffix = finding.component_id && finding.component_id !== primaryBody ? `-${finding.component_id}` : '';
      const current = map.get(key) ?? { id: `NC-${event.item_id}-${finding.defect_type_id}-${finding.region}${componentSuffix}`.toUpperCase().replace(/[^A-Z0-9-]/g, ''), item: event.item_id, type: finding.defect_type_id, region: finding.region, component: finding.component_id, observations: [], refs: [], decisions: [], confirmed: false, status: 'На рассмотрении', tone: 'amber', severity: finding.severity, priority: 0, why: '' };
      current.observations.push(event); current.refs.push(`${event.event_id}#${finding.finding_id}`); map.set(key, current);
    }
  }
  return [...map.values()].map(current => {
    const firstUnassessable = input.find(e => e.item_id === current.item && e.event_type === 'inspection_result' && e.data.inspection_result === 'unable_to_assess');
    const legacyUnassessable = current.type === 'UNASSESSABLE' && current.observations[0].event_id === firstUnassessable?.event_id;
    const linked = input.filter(e => e.item_id === current.item && (e.data.finding_refs?.some(ref => current.refs.includes(ref)) || (legacyUnassessable && e.event_type === 'quality_decision' && !e.data.finding_refs?.length)));
    const decisions = linked.filter(e => e.event_type === 'quality_decision');
    const review = linked.filter(e => e.event_type === 'cause_review').at(-1);
    const last = decisions.at(-1)?.data.decision;
    const held = decisions.at(-1)?.data.disposition === 'hold' || decisions.at(-1)?.data.disposition === 'quarantine';
    const poor = current.observations.some(e => e.data.observation_quality === 'poor');
    const lowConfidence = current.observations.some(e => e.data.confidence != null && e.data.confidence < 0.6);
    const machineWarning = input.some(e => e.item_id === current.item && e.event_type === 'machine_state' && e.data.state === 'warning');
    const severity = current.severity;
    const repeat = current.observations.length > 1 && current.observations.at(-1)?.data.inspection_result === 'signs_detected';
    const waiting = Math.max(0, Date.parse(input.at(-1)?.occurred_at ?? '') - Date.parse(current.observations[0].occurred_at)) / 3600000;
    const priority = (severity === 'critical' ? 130 : severity === 'high' ? 70 : severity === 'medium' ? 40 : 20) + (held ? 100 : 0) + (poor ? 20 : 0) + (lowConfidence ? 15 : 0) + (current.type === 'UNASSESSABLE' ? 25 : 0) + (repeat ? 70 : 0) + (machineWarning ? 10 : 0) + Math.min(20, Math.floor(waiting / 2));
    const severityLabel = { critical: 'критическая', high: 'высокая', medium: 'средняя', low: 'низкая', requires_review: 'требует ручной оценки' }[severity] ?? severity;
    const why = [severity === 'critical' ? 'Критический признак' : 'Предварительная тяжесть: ' + severityLabel, held ? 'изделие удержано' : '', current.type === 'UNASSESSABLE' ? 'оценка невозможна' : '', poor ? 'качество кадра ограничено' : '', lowConfidence ? 'низкая уверенность CV: нужна проверка' : '', machineWarning ? 'есть предупреждение станка, причина не доказана' : '', repeat ? 'признак остался после доработки' : '', waiting >= 4 ? 'длительное ожидание' : ''].filter(Boolean).join(' · ');
    const assessed = current.type === 'UNASSESSABLE' && input.some(e => e.item_id === current.item && e.event_type === 'inspection_result' && e.data.method === 'manual_verification');
    return { ...current, decisions, review, confirmed: current.type !== 'UNASSESSABLE' && decisions.some(e => e.data.decision === 'confirmed'), status: assessed ? 'Доппроверка выполнена' : last ? decisionNames[last] ?? last : current.status, tone: assessed ? 'blue' : last === 'confirmed' || last === 'scrap_approved' ? 'red' : last === 'rejected' || last === 'release_after_rework' ? 'green' : 'amber', priority, why };
  });
}
export interface Operation { id: string; item: string; name: string; actor?: string; shift: string; start: string; end?: string; duration?: number; rework: boolean; paused: boolean; station: string }
export function projectOperations(input: QualityEvent[]): Operation[] {
  return input.filter(e => e.event_type === 'operation_started').map(start => {
    const finish = input.find(e => e.event_type === 'operation_finished' && e.operation_run_id === start.operation_run_id);
    return { id: start.operation_run_id!, item: start.item_id, name: start.data.operation_id === 'OP-MILL' ? 'Обработка корпуса' : start.data.operation_id === 'OP-REWORK' ? 'Доработка' : 'Сборка кронштейна', actor: start.actor_id, shift: start.shift_id, start: start.occurred_at, end: finish?.occurred_at, duration: finish ? (Date.parse(finish.occurred_at) - Date.parse(start.occurred_at)) / 60000 : undefined, rework: !!start.data.previous_operation_run_id, paused: !finish && input.some(e => e.event_type === 'operation_paused' && e.operation_run_id === start.operation_run_id), station: start.station_id };
  });
}
export interface Task { id: string; title: string; item: string; role: RoleId; event: QualityEvent; done: boolean; description: string; priority: number; why: string }
export function projectTasks(input: QualityEvent[]): Task[] {
  const result: Task[] = [];
  const byItem = new Map<string, QualityEvent[]>();
  for (const e of input) byItem.set(e.item_id, [...(byItem.get(e.item_id) ?? []), e]);
  for (const [item, own] of byItem) {
    const anomaly = own.filter(e => e.event_type === 'inspection_result' && ['signs_detected', 'unable_to_assess'].includes(e.data.inspection_result ?? '')).at(0);
    if (!anomaly) continue;
    const decisions = own.filter(e => e.event_type === 'quality_decision'); const lastDecision = decisions.at(-1);
    const masters = own.filter(e => e.event_type === 'master_action'); const lastMaster = masters.at(-1);
    const casePriority = Math.max(...cases.filter(c => c.item === item).map(c => c.priority), 30);
    const why = cases.find(c => c.item === item)?.why ?? 'Нужна проверка';
    const add = (role: RoleId, title: string, event: QualityEvent, description: string) => result.push({ id: `TASK-${role}-${item}`, title, item, role, event, done: false, description, priority: casePriority, why });
    if (!lastDecision || (lastMaster && (!lastDecision || Date.parse(lastMaster.occurred_at) > Date.parse(lastDecision.occurred_at)))) add('controller', lastMaster ? 'Провести повторный контроль' : anomaly.data.inspection_result === 'unable_to_assess' ? 'Назначить доппроверку' : 'Рассмотреть признак CV', lastMaster ?? anomaly, why);
    if (lastDecision && ['rework', 'hold', 'quarantine'].includes(lastDecision.data.disposition ?? '') && (!lastMaster || Date.parse(lastMaster.occurred_at) < Date.parse(lastDecision.occurred_at))) add('master', lastDecision.data.disposition === 'rework' ? 'Выполнить доработку и передать контроль' : lastDecision.data.disposition === 'hold' ? 'Организовать очную проверку' : 'Организовать карантин', lastDecision, 'Решение контролёра. Работа мастера не означает выпуск.');
    if (item === 'ITEM-013' && lastDecision?.data.decision === 'confirmed' && !own.some(e => e.event_type === 'technical_disposition')) add('technologist', 'Оценить нестандартную доработку', lastDecision, 'Нужна оценка допустимости до снятия материала.');
    if (item === 'ITEM-015' && lastDecision?.data.disposition === 'quarantine' && !own.some(e => e.event_type === 'technical_disposition')) add('technologist', 'Оценить ремонтопригодность', lastDecision, 'Критическая кромка: проверьте маршрут.');
  }
  return result.sort((a, b) => b.priority - a.priority || a.item.localeCompare(b.item));
}
export function metrics(scope: Scope) {
  const scoped = events.filter(e => inScope(e, scope)); const scopedCases = cases.filter(c => c.observations.some(e => inScope(e, scope))); const scopedOps = operations.filter(op => scope === 'all' || op.shift === scope);
  return { items: new Set(scoped.map(e => e.item_id)).size, inspected: new Set(scoped.filter(e => e.event_type === 'inspection_result' && e.data.inspection_result !== 'unable_to_assess' && e.data.observation_quality === 'good').map(e => e.item_id)).size, defects: scopedCases.filter(c => c.confirmed && c.type !== 'UNASSESSABLE').length, defectiveItems: new Set(scopedCases.filter(c => c.confirmed && c.type !== 'UNASSESSABLE').map(c => c.item)).size, established: new Set(scopedCases.filter(c => c.confirmed && c.review?.data.status === 'confirmed').map(c => c.item)).size, pending: scopedCases.filter(c => !c.decisions.length).length, rework: scopedOps.filter(op => op.rework).length, unfinished: scopedOps.filter(op => !op.end).length, errors: scoped.filter(e => e.event_type === 'cause_review' && e.data.cause_type === 'procedural_error' && e.data.status === 'confirmed').length, events: scoped.length };
}
export function productStatus(id: string): { label: string; tone: 'red' | 'amber' | 'green' | 'blue' } {
  const own = eventsFor(id); const decision = own.filter(e => e.event_type === 'quality_decision').at(-1);
  if (decision?.data.disposition === 'scrap' || decision?.data.disposition === 'quarantine') return { label: decision.data.disposition === 'scrap' ? 'Списание решено' : 'Карантин', tone: 'red' };
  if (decision?.data.disposition === 'hold') return { label: 'Удержано для доппроверки', tone: 'amber' };
  if (decision?.data.disposition === 'rework') {
    const master = own.filter(e => e.event_type === 'master_action').at(-1);
    if (master && Date.parse(master.occurred_at) > Date.parse(decision.occurred_at)) return { label: 'Ожидает повторного контроля', tone: 'amber' };
    if (id === 'ITEM-013' && !own.some(e => e.event_type === 'technical_disposition' && e.data.disposition === 'rework_allowed')) return { label: 'Удержано: заключение технолога', tone: 'amber' };
    return { label: 'Удержано: доработка', tone: 'amber' };
  }
  if (decision?.data.disposition === 'release') return { label: 'Выпуск разрешён контролёром', tone: 'green' };
  if (own.some(e => e.event_type === 'inspection_result' && ['signs_detected', 'unable_to_assess'].includes(e.data.inspection_result ?? ''))) return { label: 'Сигнал на рассмотрении', tone: 'amber' };
  if (operations.some(op => op.item === id && !op.end)) return { label: 'Операция в работе', tone: 'blue' };
  return { label: 'Без открытого сигнала', tone: 'blue' };
}
export function describeEvent(event: QualityEvent): string {
  if (event.data.reason) return event.data.reason;
  if (event.data.inspection_result) return `${resultNames[event.data.inspection_result]}. ${event.data.observation_quality === 'poor' ? 'Ограниченное качество наблюдения.' : 'Качество наблюдения достаточное.'}`;
  if (event.event_type === 'machine_state') return `${event.data.parameter ?? event.data.state}: ${event.data.value ?? ''} ${event.data.unit ?? ''}`;
  return [event.operation_run_id, event.actor_id, event.equipment_id].filter(Boolean).join(' · ') || 'Событие производственного процесса';
}

export type WorkflowAction = 'confirm' | 'additional' | 'reject' | 'recheck_fail' | 'release' | 'scrap' | 'master_complete' | 'tech_allow' | 'tech_deny' | 'hypothesis' | 'cause_confirm';
/** Record a role action as a new auditable event, then unlock only its next source stage. */
export function performAction(item: string, role: RoleId, action: WorkflowAction, reason: string, executor: string, includePhoto = true, caseId?: string, approval?: { actionId: string; actorId: string }): string {
  const own = eventsFor(item); const latest = own.at(-1); if (!latest) throw new Error('Изделие ещё не поступило');
  if (!reason.trim()) throw new Error('Укажите основание');
  const allowedRole = action.startsWith('tech') || action === 'hypothesis' || action === 'cause_confirm' ? 'technologist' : action === 'master_complete' ? 'master' : 'controller';
  if (role !== allowedRole) throw new Error('Действие недоступно для этой роли');
  const lastDecision = own.filter(e => e.event_type === 'quality_decision').at(-1);
  const lastMaster = own.filter(e => e.event_type === 'master_action').at(-1);
  const afterDecision = !!lastMaster && !!lastDecision && Date.parse(lastMaster.occurred_at) > Date.parse(lastDecision.occurred_at);
  if (action === 'master_complete' && (!lastDecision || !['rework', 'hold', 'quarantine'].includes(lastDecision.data.disposition ?? '') || afterDecision)) throw new Error('Нет открытого задания мастеру');
  if (action === 'master_complete' && item === 'ITEM-013' && !own.some(e => e.event_type === 'technical_disposition' && e.data.disposition === 'rework_allowed')) throw new Error('Сначала нужно заключение технолога');
  if (action === 'tech_allow' && item === 'ITEM-013' && !lastDecision) throw new Error('Сначала нужно решение контролёра');
  if (action === 'tech_deny' && item === 'ITEM-015' && lastDecision?.data.disposition !== 'quarantine') throw new Error('Сначала подтвердите дефект и карантин');
  if (action === 'confirm' && item === 'ITEM-015' && !lastMaster) throw new Error('Сначала нужна очная проверка с фото');
  if (action === 'scrap' && !own.some(e => e.event_type === 'technical_disposition' && e.data.disposition === 'rework_not_allowed')) throw new Error('Нужно заключение о невозможности доработки');
  if (['release', 'recheck_fail'].includes(action) && !afterDecision) throw new Error('Сначала мастер должен завершить работу и передать изделие');
  if (action === 'release' && item === 'ITEM-014' && own.filter(e => e.event_type === 'master_action').length === 1) throw new Error('После первого прохода заусенец остаётся: требуется новый круг');
  if (action === 'reject' && item === 'ITEM-016' && !afterDecision) throw new Error('Сначала нужна доппроверка при другом освещении');
  const first = own.find(e => e.event_type === 'inspection_result' && e.data.inspection_result === 'signs_detected');
  let refs = first?.data.defects?.map(f => `${first.event_id}#${f.finding_id}`) ?? [];
  if (!refs.length) refs = cases.find(entry => entry.item === item && entry.type === 'UNASSESSABLE')?.refs ?? [];
  if (caseId) {
    const selected = cases.find(entry => entry.id === caseId && entry.item === item);
    if (!selected) throw new Error('Случай не найден для этого изделия');
    refs = selected.refs;
  }
  let actionEventIndex = 0;
  const make = (event_type: string, data: EventData, extra: Partial<QualityEvent> = {}) => {
    const lastTime = Math.max(...eventsFor(item).map(e => Date.parse(e.occurred_at)));
    const event: QualityEvent = { event_id: approval ? `UI-${approval.actionId}-${++actionEventIndex}` : `UI-${crypto.randomUUID()}`, event_type, schema_version: '2.0', occurred_at: new Date(lastTime + 60000).toISOString(), source_id: 'ORBITA-UI', item_id: item, item_type_id: latest.item_type_id, line_id: latest.line_id, station_id: latest.station_id, shift_id: latest.shift_id, actor_id: approval?.actorId ?? (executor.trim() || role.toUpperCase()), data: approval ? { ...data, security_action_id: approval.actionId } : data, ...extra };
    const row: Delivery = { delivery_id: `UI-DLV-${crypto.randomUUID()}`, deliver_at: new Date().toISOString(), message: event };
    const outcome = accept(row); if (outcome.kind === 'error') throw new Error(outcome.reason); events.sort(sortEvents);
    return event;
  };
  if (action === 'confirm' || action === 'additional' || action === 'reject' || action === 'scrap') {
    if (action === 'confirm' && item === 'ITEM-015' && own.some(e => e.event_type === 'master_action') && !first) {
      const check = make('inspection_result', { inspection_point_id: 'CP-POST-MILL', inspection_result: 'signs_detected', observation_quality: 'good', confidence: null, defects: [{ finding_id: 'F1', defect_type_id: 'DENT', component_id: itemById.get(item)!.components.find(c => c.component_type_id === 'BODY')!.id, region: 'outer_left_edge', severity: 'critical' }], method: 'manual_verification', evidence_refs: ['M015-MASTER-DENT'], triage_priority: 'critical', capture_context: { source: 'manual_verification' } });
      refs = [`${check.event_id}#F1`];
    }
    if (action === 'reject' && item === 'ITEM-016' && own.some(e => e.event_type === 'master_action')) make('inspection_result', { inspection_point_id: 'CP-POST-MILL', inspection_result: 'no_signs_detected', observation_quality: 'good', confidence: null, defects: [], method: 'manual_verification', evidence_refs: ['M016-MASTER-CLEAR'], triage_priority: 'routine', capture_context: { source: 'manual_verification' } });
    const decision = action === 'confirm' ? 'confirmed' : action === 'additional' ? 'additional_check' : action === 'reject' ? 'rejected' : 'scrap_approved';
    const disposition = action === 'confirm' ? item === 'ITEM-015' ? 'quarantine' : 'rework' : action === 'additional' ? 'hold' : action === 'reject' ? 'release' : 'scrap';
    make('quality_decision', { decision, disposition, finding_refs: refs, reason });
  } else if (action === 'tech_allow' || action === 'tech_deny') make('technical_disposition', { disposition: action === 'tech_allow' ? 'rework_allowed' : 'rework_not_allowed', basis_event_ids: own.filter(e => e.event_type === 'quality_decision').map(e => e.event_id), reason });
  else if (action === 'hypothesis' || action === 'cause_confirm') make('cause_review', { status: action === 'cause_confirm' ? 'confirmed' : 'hypothesis', finding_refs: refs, reason });
  else if (action === 'master_complete') {
    const count = own.filter(e => e.event_type === 'master_action').length;
    const asset = includePhoto ? item === 'ITEM-013' ? 'M013-MASTER-CLEAR' : item === 'ITEM-014' ? count ? 'M014-MASTER-CLEAR' : 'M014-MASTER-STILL' : item === 'ITEM-015' ? 'M015-MASTER-DENT' : item === 'ITEM-016' ? 'M016-MASTER-CLEAR' : undefined : undefined;
    make('master_action', { action_type: own.some(e => e.data.disposition === 'rework') ? 'rework_completed' : 'inspection_support', evidence_refs: asset ? [asset] : [], observation_quality: asset ? 'good' : undefined, executor_id: executor, comment: reason, reason });
  } else if (action === 'recheck_fail' || action === 'release') {
    const run = own.filter(e => e.event_type === 'operation_started').at(-1)?.operation_run_id;
    if (action === 'release' && item === 'ITEM-013') make('manual_measurement', { feature_id: 'WALL-NEAR-RIGHT-HOLE', measured_value: 5.12, unit: 'mm', lower_limit: 5, instrument_id: 'GAGE-01', calibration_status: 'valid_in_demo', result: 'within_assumed_limit', is_camera_measurement: false, reason: 'Ручной замер прибором: 5,12 мм при минимуме 5,0 мм.' }, { operation_run_id: run });
    const asset = own.filter(e => e.event_type === 'master_action').at(-1)?.data.evidence_refs ?? [];
    make('inspection_result', { inspection_point_id: 'CP-POST-MILL', inspection_result: action === 'release' ? 'no_signs_detected' : 'signs_detected', observation_quality: 'good', confidence: null, defects: action === 'release' ? [] : first?.data.defects ?? [], method: 'manual_verification', evidence_refs: asset, triage_priority: action === 'release' ? 'routine' : 'high', capture_context: { source: 'manual_verification' } }, run ? { operation_run_id: run } : {});
    make('quality_decision', { decision: action === 'release' ? 'release_after_rework' : 'confirmed', disposition: action === 'release' ? 'release' : 'rework', finding_refs: refs, reason });
  }
  advanceItem(item); save(); return action;
}
