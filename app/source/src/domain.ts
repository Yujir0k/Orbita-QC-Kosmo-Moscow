import type { ProductionEventContract } from './generated/contracts';
import demo from './demo-data.json';
import type { RoleId } from './navigation';
import { evidenceRecipients, matchesEvidenceAnswer, recipientName, type EvidenceRecipient } from './investigation-services';

export interface Finding { finding_id: string; defect_type_id: string; component_id: string; region: string; severity: string; description?: string; observed_feature?: string; length_mm?: number; width_mm?: number; depth_estimated_mm?: number | null; defect_class?: 'SCRATCH' | 'CRACK' | 'BURR' | 'DENT' | 'DISCOLORATION'; dimension_source?: string; dimension_uncertainty_mm?: number }
export interface MediaSlot { url: string | null; sha256_hash: string; status: 'AVAILABLE' | 'MISSING'; absence_reason: 'LOST_IN_TRANSIT' | 'CLASSIFIED_RESTRICTED' | 'NO_CAMERA_AT_STATION' | 'NONE' }
export interface MediaEvidence { before_operation: MediaSlot; after_operation: MediaSlot }
export interface KdSpec { surface_zone_class: 'ZONE_A_CRITICAL' | 'ZONE_B_MATING' | 'ZONE_C_NON_CRITICAL'; max_allowable_defect_length_mm: number; standard_ref: string; source_kind?: string; applies_to?: string }
export interface ItemState { physical_location: string; line_lock_status: 'HELD_AT_STATION' | 'IN_BUFFER' | 'ROUTED_FORWARD' }
export interface EventData {
  inspection_result?: string; observation_quality?: string; confidence?: number | null; defects?: Finding[];
  media_evidence?: MediaEvidence; kd_spec?: KdSpec;
  observation_summary?: string; comparison?: { previous_inspection_event_id?: string | null; previous_result?: string | null; summary?: string }; next_verification?: string | null;
  inspection_point_id?: string; method?: string; finding_refs?: string[]; decision?: string; disposition?: string;
  reason?: string; cause_type?: string; status?: string; basis_event_ids?: string[]; evidence_event_ids?: string[];
  evidence_refs?: string[]; triage_priority?: string; capture_context?: Record<string, unknown>;
  operation_id?: string; previous_operation_run_id?: string | null; state?: string; parameter?: string;
  value?: number | boolean; unit?: string; configured_limit?: number; action_type?: string; procedure_step_id?: string; reason_code?: string;
  measurement?: { value: number; unit: string; lower_limit?: number }; executor_id?: string; comment?: string;
  [key: string]: unknown;
}
export interface QualityEvent { event_id: string; event_type: string; schema_version: ProductionEventContract['schema_version']; occurred_at: string; source_id: string; item_id: string; item_type_id: string; line_id: string; station_id: string; shift_id: string; operation_run_id?: string; actor_id?: string; equipment_id?: string; analyzer_version?: string; item_state?: ItemState; data: EventData }
export interface Delivery { delivery_id: string; deliver_at: string; message: QualityEvent }
export interface Product { id: string; item_type_id: string; work_order_id: string; assembly_revision: string; components: { id: string; component_type_id: string }[] }
export interface MediaAsset { asset_id: string; item_id: string; path_from_quality_dataset: string; capture_source: string; stage: string; description: string; sha256?: string }
export type Scope = 'all' | 'SHIFT-A' | 'SHIFT-B';
type OutcomeKind = 'accepted' | 'duplicate' | 'late' | 'error';
export interface IngestOutcome { delivery_id: string; event_id: string; item_id: string; kind: OutcomeKind; reason: string; received_at?: string; source_id?: string }
interface StoredState { sourceIds: string[]; other: Delivery[]; pendingIds: string[]; outcomes: IngestOutcome[]; counts: Record<OutcomeKind, number>; playing: boolean }
const dataset = demo as unknown as { items: Product[]; catalogs: typeof demo.catalogs; media: MediaAsset[]; source: Delivery[]; seedDecisions: Delivery[]; contextDeliveries: Delivery[]; technicalCatalog: typeof demo.technicalCatalog; inspectionPlan: typeof demo.inspectionPlan; profiles: typeof demo.profiles };
const storageKey = 'orbita-qc-expanded-v2';
let authoritative = typeof window !== 'undefined' && Boolean((window as unknown as { __ORBITA_PRODUCTION__?: boolean }).__ORBITA_PRODUCTION__);
export const items = dataset.items;
export const catalogs = dataset.catalogs;
export const inspectionPlan = dataset.inspectionPlan;
export const profiles = dataset.profiles.profiles;
export const mediaIndex = dataset.media;
export const sourceDeliveries = dataset.source;
export const seedDecisions = dataset.seedDecisions;
export const contextDeliveries = dataset.contextDeliveries;
export const technicalCatalog = dataset.technicalCatalog;
const sourceById = new Map([...sourceDeliveries, ...seedDecisions, ...contextDeliveries].map(row => [row.delivery_id, row]));
const itemById = new Map(items.map(item => [item.id, item]));
const mediaById = new Map(mediaIndex.map(asset => [asset.asset_id, asset]));
export const defectNames: Record<string, string> = { DENT: 'Вмятина', SCRATCH: 'Царапина', BURR: 'Заусенец', CHIP: 'Скол', CRACK: 'Трещина', DISCOLORATION: 'Изменение цвета', UNASSESSABLE: 'Нужна доппроверка' };
export const stationNames: Record<string, string> = Object.fromEntries(catalogs.stations.map(s => [s.id, s.name]));
export const eventNames: Record<string, string> = { item_received: 'Поступление изделия', inspection_result: 'Наблюдение контроля', manual_inspection: 'Очный осмотр контролёра', operation_started: 'Начало операции', operation_finished: 'Завершение операции', operation_paused: 'Пауза операции', quality_decision: 'Решение контролёра', controller_check: 'Очная проверка контролёра', cause_review: 'Заключение технолога', technical_disposition: 'Допустимость доработки', master_action: 'Работа мастера', master_process_report: 'Сведения мастера об операции', evidence_request: 'Запрос сведений технологом', manual_measurement: 'Ручной замер', machine_state: 'Состояние оборудования', operator_action: 'Наблюдение действия', operation_context: 'Технологическая карта операции', service_report: 'Ответ службы предприятия' };
export const decisionNames: Record<string, string> = { confirmed: 'Подтверждено', rejected: 'Признак отклонён', accepted_within_spec: 'Видимый след в пределах КД', release_after_rework: 'Выпуск после контроля', additional_check: 'Доппроверка', scrap_approved: 'Списание', recheck: 'Повторная проверка' };
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
    for (const finding of d.defects) if (finding.defect_class !== undefined && (!['SCRATCH', 'CRACK', 'BURR', 'DENT', 'DISCOLORATION'].includes(finding.defect_class) || typeof finding.length_mm !== 'number' || finding.length_mm <= 0 || typeof finding.width_mm !== 'number' || finding.width_mm <= 0 || finding.depth_estimated_mm != null && (typeof finding.depth_estimated_mm !== 'number' || finding.depth_estimated_mm < 0))) return 'Некорректная геометрия признака';
    if (d.kd_spec && (!['ZONE_A_CRITICAL', 'ZONE_B_MATING', 'ZONE_C_NON_CRITICAL'].includes(d.kd_spec.surface_zone_class) || !Number.isFinite(d.kd_spec.max_allowable_defect_length_mm) || d.kd_spec.max_allowable_defect_length_mm < 0 || !textField(d.kd_spec.standard_ref))) return 'Некорректный критерий КД';
    if (d.media_evidence) for (const slot of [d.media_evidence.before_operation, d.media_evidence.after_operation]) {
      if (!slot || slot.status === 'AVAILABLE' && (!textField(slot.url) || !/^[0-9a-f]{64}$/.test(slot.sha256_hash) || slot.absence_reason !== 'NONE') || slot.status === 'MISSING' && (slot.url !== null || slot.sha256_hash !== '' || !['LOST_IN_TRANSIT', 'CLASSIFIED_RESTRICTED', 'NO_CAMERA_AT_STATION'].includes(slot.absence_reason)) || !['AVAILABLE', 'MISSING'].includes(slot.status)) return 'Некорректный слот изображения';
    }
  }
  if (e.item_state && (!textField(e.item_state.physical_location) || !['HELD_AT_STATION', 'IN_BUFFER', 'ROUTED_FORWARD'].includes(e.item_state.line_lock_status))) return 'Некорректное физическое состояние изделия';
  if (['operation_started', 'operation_finished', 'operation_paused'].includes(e.event_type!) && !textField(e.operation_run_id)) return 'Нет operation_run_id';
  if (e.event_type === 'manual_measurement' && !textField(e.operation_run_id) && !textField(e.data.case_id)) return 'Замер не привязан к операции или случаю качества';
  if (e.event_type === 'controller_check' && (!textField(e.data.case_id) || !['signs_detected', 'no_signs_detected'].includes(e.data.inspection_result ?? '') || !textField(e.data.reason))) return 'Неполная очная проверка';
  if (e.event_type === 'manual_inspection' && (!textField(e.data.case_id) || !['signs_detected', 'no_signs_detected', 'unable_to_assess'].includes(e.data.inspection_result ?? '') || !textField(e.data.reason))) return 'Неполный результат очного осмотра';
  if (['quality_decision', 'controller_check', 'master_action', 'master_process_report', 'evidence_request', 'cause_review', 'technical_disposition', 'manual_measurement', 'manual_inspection', 'service_report'].includes(e.event_type!) && !textField(e.actor_id)) return 'Нет actor_id';
  if (e.event_type === 'master_process_report' && (!textField(e.data.case_id) || !textField(e.data.comment) || !['checked', 'issue', 'unknown', 'not_applicable'].includes(String(e.data.fixture_condition)) || !['checked', 'issue', 'unknown', 'not_applicable'].includes(String(e.data.tool_condition)) || !['yes', 'no', 'unknown'].includes(String(e.data.setup_changed)))) return 'Неполные сведения мастера';
  if (e.event_type === 'evidence_request' && (!textField(e.data.case_id) || !Object.hasOwn(evidenceRecipients, String(e.data.recipient_role)) || !textField(e.data.reason))) return 'Неполный запрос сведений';
  if (e.event_type === 'operation_context' && (!textField(e.operation_run_id) || !textField(e.data.program_name) || !textField(e.data.program_revision) || !textField(e.data.executor_id) || !textField(e.data.equipment_id))) return 'Неполная технологическая карта операции';
  if (e.event_type === 'service_report' && (!['mechanic', 'laboratory'].includes(String(e.data.recipient_role)) || !textField(e.data.case_id) || !textField(e.data.request_id) || !textField(e.data.reason))) return 'Неполный ответ службы предприятия';
  if (e.event_type === 'cause_review' && (!Array.isArray(e.data.finding_refs) || !textField(e.data.reason) || !['hypothesis', 'confirmed', 'unknown'].includes(e.data.status ?? ''))) return 'Неполное заключение технолога';
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
const persist = () => { if (authoritative) return; try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Browser storage may be disabled. */ } };
const save = () => { refresh(); hydrateTechnicalContext(); refresh(); persist(); notify(); };

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
  for (const row of seedDecisions) accept(row, false);
  state.outcomes = [];
  save();
}
/** Add synthetic context only after its source operation or decision has been accepted. */
function hydrateTechnicalContext() {
  if (authoritative) return;
  const known = new Set(events.map(event => event.event_id));
  for (const row of contextDeliveries) {
    const event = row.message;
    if (known.has(event.event_id)) continue;
    const eligible = event.event_type === 'machine_state'
      ? events.some(anchor => anchor.event_type === 'operation_finished' && anchor.item_id === event.item_id && anchor.operation_run_id === event.operation_run_id && Date.parse(event.occurred_at) <= Date.parse(anchor.occurred_at))
      : (event.data.basis_event_ids ?? []).every(id => known.has(id));
    if (eligible) { accept(row, false); known.add(event.event_id); }
  }
}
try {
  const saved: unknown = authoritative ? null : JSON.parse(localStorage.getItem(storageKey) ?? 'null');
  if (saved && typeof saved === 'object' && Array.isArray((saved as StoredState).sourceIds) && Array.isArray((saved as StoredState).pendingIds)) {
    state = saved as StoredState; state.playing = false; refresh();
    for (const row of seedDecisions) if (!events.some(event => event.item_id === row.message.item_id && event.event_type === 'quality_decision')) accept(row, false);
    save();
  }
  else bootstrap();
} catch { bootstrap(); }
/** Reset the built-in stream to open work before any human decisions. */
export function resetDemo() { bootstrap(); }
function hasDecision(item: string, decision: string) { return events.some(e => e.item_id === item && e.event_type === 'quality_decision' && e.data.decision === decision); }
function countDisposition(item: string, disposition: string) { return events.filter(e => e.item_id === item && e.event_type === 'quality_decision' && e.data.disposition === disposition).length; }
function allowed(row: Delivery): boolean {
  const e = row.message; const item = e.item_id;
  if (item === 'ITEM-018') return true;
  if (item === 'ITEM-013') return e.data.operation_id === 'OP-REWORK' ? countDisposition(item, 'rework') > 0 : hasDecision(item, 'release_after_rework');
  if (item === 'ITEM-014') { if (e.data.operation_id === 'OP-REWORK') return (e.operation_run_id?.endsWith('-2') ? countDisposition(item, 'rework') >= 2 : countDisposition(item, 'rework') >= 1); return hasDecision(item, 'release_after_rework'); }
  if (item === 'ITEM-015') return hasDecision(item, 'additional_check');
  if (item === 'ITEM-016') return hasDecision(item, 'rejected');
  if (item === 'ITEM-017') return e.data.operation_id === 'OP-REWORK' ? countDisposition(item, 'rework') > 0 : hasDecision(item, 'release_after_rework');
  if (item === 'ITEM-019') return e.station_id.startsWith('ST-ASSEMBLY') ? events.filter(x => x.item_id === item && x.event_type === 'quality_decision' && x.data.decision === 'accepted_within_spec').length >= 2 : hasDecision(item, 'accepted_within_spec');
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
  if (authoritative) return;
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
    return { ...current, decisions, review, confirmed: current.type !== 'UNASSESSABLE' && decisions.some(e => e.data.decision === 'confirmed'), status: assessed ? 'Доппроверка выполнена' : last ? decisionNames[last] ?? last : current.status, tone: assessed ? 'blue' : last === 'confirmed' || last === 'scrap_approved' ? 'red' : last === 'rejected' || last === 'accepted_within_spec' || last === 'release_after_rework' ? 'green' : 'amber', priority, why };
  });
}
export interface Operation { id: string; item: string; name: string; actor?: string; shift: string; start: string; end?: string; duration?: number; rework: boolean; paused: boolean; station: string }
export function projectOperations(input: QualityEvent[]): Operation[] {
  return input.filter(e => e.event_type === 'operation_started').map(start => {
    const finish = input.find(e => e.event_type === 'operation_finished' && e.operation_run_id === start.operation_run_id);
    return { id: start.operation_run_id!, item: start.item_id, name: start.data.operation_id === 'OP-MILL' ? 'Обработка корпуса' : start.data.operation_id === 'OP-REWORK' ? 'Доработка' : 'Сборка кронштейна', actor: start.actor_id, shift: start.shift_id, start: start.occurred_at, end: finish?.occurred_at, duration: finish ? (Date.parse(finish.occurred_at) - Date.parse(start.occurred_at)) / 60000 : undefined, rework: !!start.data.previous_operation_run_id, paused: !finish && input.some(e => e.event_type === 'operation_paused' && e.operation_run_id === start.operation_run_id), station: start.station_id };
  });
}
export interface Task { id: string; title: string; item: string; caseId?: string; role: RoleId; event: QualityEvent; done: boolean; description: string; priority: number; why: string }
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
    if (!lastDecision || (lastMaster && (!lastDecision || Date.parse(lastMaster.occurred_at) > Date.parse(lastDecision.occurred_at)))) add('controller', lastMaster?.data.action_type === 'scrap_to_isolator' ? 'Подтвердить предложение о списании' : lastMaster ? 'Провести повторный контроль' : anomaly.data.inspection_result === 'unable_to_assess' ? 'Назначить доппроверку' : 'Рассмотреть признак CV', lastMaster ?? anomaly, why);
    if (lastDecision && ['rework', 'hold', 'quarantine'].includes(lastDecision.data.disposition ?? '') && (!lastMaster || Date.parse(lastMaster.occurred_at) < Date.parse(lastDecision.occurred_at))) add('master', lastDecision.data.disposition === 'rework' ? 'Выполнить доработку и передать контроль' : lastDecision.data.disposition === 'hold' ? 'Организовать очную проверку' : 'Организовать карантин', lastDecision, 'Решение контролёра. Работа мастера не означает выпуск.');
  }
  for (const record of projectCases(input)) {
    if (!record.confirmed || (['confirmed', 'unknown'].includes(record.review?.data.status ?? '') && !causeReviewNeedsRevision(record, input))) continue;
    const decision = record.decisions.find(event => event.data.decision === 'confirmed');
    if (!decision) continue;
    result.push({ id: `TASK-technologist-${record.id}`, title: `Установить обстоятельства: ${defectNames[record.type] ?? record.type}`, item: record.item, caseId: record.id, role: 'technologist', event: decision, done: false, description: causeReviewNeedsRevision(record, input) ? 'Поступили новые факты. Пересмотрите ранее записанный вывод.' : record.review ? 'Гипотеза сохранена, проверьте основания и альтернативы.' : 'Дефект подтверждён ОТК; причина рассматривается отдельно.', priority: record.priority, why: record.why });
  }
  for (const request of input.filter(event => event.event_type === 'evidence_request')) {
    const recipient = request.data.recipient_role as EvidenceRecipient;
    const caseId = String(request.data.case_id);
    const answered = input.some(event => matchesEvidenceAnswer(request, event));
    const role: RoleId = recipient === 'master' || recipient === 'controller' ? recipient : 'technologist';
    const title = recipient === 'master' ? 'Передать сведения об операции' : recipient === 'controller' ? 'Уточнить результат контроля' : `Получить ответ: ${recipientName(recipient)}`;
    if (!answered) result.push({ id: `TASK-request-${request.event_id}`, title, item: request.item_id, caseId, role, event: request, done: false, description: request.data.reason ?? 'Технолог запросил дополнительные основания.', priority: 105, why: 'Открытый запрос технолога' });
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
    if (master?.data.action_type === 'scrap_to_isolator' && Date.parse(master.occurred_at) > Date.parse(decision.occurred_at)) return { label: 'Изолятор брака', tone: 'red' };
    if (master && Date.parse(master.occurred_at) > Date.parse(decision.occurred_at)) return { label: 'Ожидает повторного контроля', tone: 'amber' };
    return { label: 'Удержано: доработка', tone: 'amber' };
  }
  if (decision?.data.disposition === 'release') return { label: 'Выпуск разрешён контролёром', tone: 'green' };
  if (own.some(e => e.event_type === 'inspection_result' && ['signs_detected', 'unable_to_assess'].includes(e.data.inspection_result ?? ''))) return { label: 'Сигнал на рассмотрении', tone: 'amber' };
  if (operations.some(op => op.item === id && !op.end)) return { label: 'Операция в работе', tone: 'blue' };
  return { label: 'Без открытого сигнала', tone: 'blue' };
}
export function describeEvent(event: QualityEvent): string {
  if (event.data.reason) return event.data.reason;
  if (event.event_type === 'operation_context') return `${event.data.program_name} · ${event.data.tool_name} · ${event.data.fixture_name} · ${event.data.executor_id}`;
  if (event.data.comment && ['master_process_report', 'master_action'].includes(event.event_type)) return event.data.comment;
  if (event.data.inspection_result) return `${resultNames[event.data.inspection_result]}. ${event.data.observation_quality === 'poor' ? 'Ограниченное качество наблюдения.' : 'Качество наблюдения достаточное.'}`;
  if (event.event_type === 'machine_state') {
    const reading = event.data.parameter != null && event.data.value != null
      ? `${event.data.parameter}: ${event.data.value}${event.data.unit ? ` ${event.data.unit}` : ''}`
      : typeof event.data.vibration_index === 'number' ? `индекс вибронагрузки ${event.data.vibration_index}` : '';
    return [machineStateLabel(event.data.state), reading].filter(Boolean).join(' · ');
  }
  return [event.operation_run_id, event.actor_id, event.equipment_id].filter(Boolean).join(' · ') || 'Событие производственного процесса';
}
export function machineStateLabel(state: unknown): string {
  return ({ running: 'Станок в работе', warning: 'Предупреждение оборудования', idle: 'Ожидание операции', paused: 'Работа приостановлена', stopped: 'Станок остановлен', fault: 'Авария оборудования', offline: 'Нет связи со станком', maintenance: 'Техническое обслуживание' } as Record<string, string>)[String(state)] ?? 'Состояние не определено';
}

export type WorkflowAction = 'confirm' | 'confirm_hold' | 'quarantine' | 'additional' | 'reject' | 'accepted_within_spec' | 'recheck_fail' | 'release' | 'scrap' | 'master_complete' | 'master_scrap' | 'hypothesis' | 'cause_confirm';
export interface MasterReworkDetails { method: string; operator: string; durationMinutes: number; actualSizeMm: number; paperInspection: boolean; assetId?: string; inspectionResult?: 'signs_detected' | 'no_signs_detected' | 'unable_to_assess'; inspectionNote?: string }
let seedingMasterShift = false;
/** Record a role action as a new auditable event, then unlock only its next source stage. */
/** Only the controller finalizes scrap; a technologist's analysis never grants production authority. */
export function canApproveScrap(item: string): boolean {
  const own = eventsFor(item);
  const decision = own.filter(event => event.event_type === 'quality_decision').at(-1);
  const master = own.filter(event => event.event_type === 'master_action').at(-1);
  return decision?.data.disposition === 'quarantine' && decision.data.decision === 'confirmed'
    || !!decision && master?.data.action_type === 'scrap_to_isolator' && Date.parse(master.occurred_at) > Date.parse(decision.occurred_at);
}

export function performAction(item: string, role: RoleId, action: WorkflowAction, reason: string, executor: string, includePhoto = true, caseId?: string, measurement?: { value: number; instrumentId: string; calibrationConfirmed: boolean }, missingPhotoConfirmation?: { observationEventId: string; acknowledged: true }, masterDetails?: MasterReworkDetails, approval?: { actionId: string; actorId: string }): string {
  const own = eventsFor(item); const latest = own.at(-1); if (!latest) throw new Error('Изделие ещё не поступило');
  if (!reason.trim()) throw new Error('Укажите основание');
  const allowedRole = action === 'hypothesis' || action === 'cause_confirm' ? 'technologist' : action === 'master_complete' || action === 'master_scrap' ? 'master' : 'controller';
  if (role !== allowedRole) throw new Error('Действие недоступно для этой роли');
  const lastDecision = own.filter(e => e.event_type === 'quality_decision').at(-1);
  const lastMaster = own.filter(e => e.event_type === 'master_action').at(-1);
  const selectedCase = cases.find(entry => entry.item === item && (caseId ? entry.id === caseId : true));
  const observation = selectedCase?.observations.at(-1);
  const masterPhoto = lastMaster && observation && Date.parse(lastMaster.occurred_at) > Date.parse(observation.occurred_at) && mediaIndex.some(asset => lastMaster.data.evidence_refs?.includes(asset.asset_id));
  const missingPhoto = observation?.data.media_evidence?.after_operation.status === 'MISSING' && !masterPhoto;
  const confirming = action === 'confirm' || action === 'confirm_hold' || action === 'quarantine';
  const acknowledged = missingPhotoConfirmation?.acknowledged === true && missingPhotoConfirmation.observationEventId === observation?.event_id;
  if (confirming && missingPhoto && !acknowledged) throw new Error('Подтвердите личную ответственность за решение без фотоматериала');
  if (confirming && missingPhoto && !executor.trim()) throw new Error('Укажите контролёра, принимающего ответственность');
  const afterDecision = !!lastMaster && !!lastDecision && Date.parse(lastMaster.occurred_at) > Date.parse(lastDecision.occurred_at);
  if (['master_complete', 'master_scrap'].includes(action) && (!lastDecision || !['rework', 'hold', 'quarantine'].includes(lastDecision.data.disposition ?? '') || afterDecision)) throw new Error('Нет открытого задания мастеру');
  if (action === 'master_scrap' && lastDecision?.data.disposition !== 'rework') throw new Error('Списание доступно только для детали на доработке');
  if (action === 'master_complete' && masterDetails && (!masterDetails.method.trim() || !masterDetails.operator.trim() || !Number.isFinite(masterDetails.durationMinutes) || masterDetails.durationMinutes <= 0 || !Number.isFinite(masterDetails.actualSizeMm) || masterDetails.actualSizeMm < 0 || !includePhoto && !masterDetails.paperInspection || lastDecision?.data.disposition === 'hold' && (!masterDetails.inspectionResult || !masterDetails.inspectionNote?.trim()))) throw new Error('Заполните результат очного осмотра мастера');
  if (action === 'confirm' && item === 'ITEM-015' && !lastMaster && !(acknowledged && selectedCase?.type !== 'UNASSESSABLE') && !own.some(e => e.event_type === 'controller_check' && e.data.case_id === caseId && e.data.inspection_result === 'signs_detected')) throw new Error('Сначала нужна очная проверка с подтверждением признака');
  if (action === 'scrap' && !canApproveScrap(item)) throw new Error('Нужно подтверждение карантина ОТК или предложение мастера о списании');
  if (['release', 'recheck_fail'].includes(action) && !afterDecision) throw new Error('Сначала мастер должен завершить работу и передать изделие');
  if (['release', 'recheck_fail'].includes(action) && lastMaster?.data.action_type !== 'rework_completed') throw new Error('Очная проверка мастера не является завершённой доработкой');
  if (action === 'release' && item === 'ITEM-013' && (!measurement || !Number.isFinite(measurement.value) || measurement.value < 5 || !measurement.instrumentId.trim() || !measurement.calibrationConfirmed)) throw new Error('Нужен фактический ручной замер: стенка не менее 5,0 мм, идентификатор поверенного прибора');
  if (action === 'release' && item === 'ITEM-014' && own.filter(e => e.event_type === 'master_action').length === 1) throw new Error('После первого прохода заусенец остаётся: требуется новый круг');
  if (action === 'reject' && item === 'ITEM-016' && !afterDecision) throw new Error('Сначала нужна доппроверка при другом освещении');
  if (action === 'accepted_within_spec') {
    const selected = cases.find(entry => entry.id === caseId && entry.item === item);
    const finding = selected?.observations.at(-1)?.data.defects?.find(row => row.defect_type_id === selected.type);
    const spec = selected?.observations.at(-1)?.data.kd_spec;
    if (!selected || selected.type !== 'SCRATCH' || spec?.source_kind !== 'synthetic_demo_assumption' || typeof finding?.length_mm !== 'number' || finding.length_mm > spec.max_allowable_defect_length_mm) throw new Error('Учебное принятие в пределах КД доступно только для измеренного сигнала риска в пределах указанного лимита');
  }
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
    const previousState = [...eventsFor(item)].reverse().find(e => e.item_state)?.item_state;
    const itemState: ItemState = event_type === 'quality_decision' ? data.disposition === 'release'
      ? { physical_location: 'Передана на следующую операцию маршрута', line_lock_status: 'ROUTED_FORWARD' }
      : { physical_location: `${latest.station_id}: зона удержания ОТК`, line_lock_status: 'HELD_AT_STATION' }
      : event_type === 'master_action' ? { physical_location: `${latest.station_id}: межоперационный буфер`, line_lock_status: 'IN_BUFFER' }
      : previousState ?? { physical_location: `${latest.station_id}: зона контроля`, line_lock_status: 'HELD_AT_STATION' };
    const event: QualityEvent = { event_id: approval ? `UI-${approval.actionId}-${++actionEventIndex}` : `UI-${crypto.randomUUID()}`, event_type, schema_version: '2.0', occurred_at: new Date(lastTime + 60000).toISOString(), source_id: seedingMasterShift ? 'ORBITA-DEMO' : 'ORBITA-UI', item_id: item, item_type_id: latest.item_type_id, line_id: latest.line_id, station_id: latest.station_id, shift_id: latest.shift_id, actor_id: approval?.actorId ?? (executor.trim() || role.toUpperCase()), ...(!approval || ['quality_decision', 'master_action'].includes(event_type) ? { item_state: itemState } : {}), data: approval ? { ...data, security_action_id: approval.actionId } : data, ...extra };
    const row: Delivery = { delivery_id: `UI-DLV-${crypto.randomUUID()}`, deliver_at: new Date().toISOString(), message: event };
    const outcome = accept(row); if (outcome.kind === 'error') throw new Error(outcome.reason); events.sort(sortEvents);
    return event;
  };
  if (action === 'confirm' || action === 'confirm_hold' || action === 'quarantine' || action === 'additional' || action === 'reject' || action === 'accepted_within_spec' || action === 'scrap') {
    if (action === 'confirm' && item === 'ITEM-015' && own.some(e => e.event_type === 'master_action') && !first) {
      const check = make('inspection_result', { inspection_point_id: 'CP-POST-MILL', inspection_result: 'signs_detected', observation_quality: 'good', confidence: null, defects: [{ finding_id: 'F1', defect_type_id: 'DENT', component_id: itemById.get(item)!.components.find(c => c.component_type_id === 'BODY')!.id, region: 'outer_left_edge', severity: 'critical' }], method: 'manual_verification', evidence_refs: ['M015-MASTER-DENT'], triage_priority: 'critical', capture_context: { source: 'manual_verification' } });
      refs = [`${check.event_id}#F1`];
    }
    if (action === 'reject' && item === 'ITEM-016' && own.some(e => e.event_type === 'master_action')) make('inspection_result', { inspection_point_id: 'CP-POST-MILL', inspection_result: 'no_signs_detected', observation_quality: 'good', confidence: null, defects: [], method: 'manual_verification', evidence_refs: ['M016-MASTER-CLEAR'], triage_priority: 'routine', capture_context: { source: 'manual_verification' } });
    const decision = confirming ? 'confirmed' : action === 'additional' ? 'additional_check' : action === 'reject' ? 'rejected' : action === 'accepted_within_spec' ? 'accepted_within_spec' : 'scrap_approved';
    const disposition = action === 'quarantine' ? 'quarantine' : action === 'confirm_hold' ? 'hold' : action === 'confirm' ? item === 'ITEM-015' ? 'quarantine' : 'rework' : action === 'additional' ? 'hold' : action === 'reject' || action === 'accepted_within_spec' ? 'release' : 'scrap';
    make('quality_decision', { decision, disposition, finding_refs: refs, reason, ...(confirming && acknowledged ? { missing_photo_acknowledgement: { acknowledged: true, observation_event_id: observation!.event_id, absence_reason: observation!.data.media_evidence?.after_operation.absence_reason ?? 'NOT_PROVIDED', actor_id: executor.trim(), basis: 'telemetry_and_kd', acknowledged_at: new Date().toISOString() } } : {}) });
  } else if (action === 'hypothesis' || action === 'cause_confirm') make('cause_review', { status: action === 'cause_confirm' ? 'confirmed' : 'hypothesis', finding_refs: refs, reason });
  else if (action === 'master_complete' || action === 'master_scrap') {
    const count = own.filter(e => e.event_type === 'master_action').length;
    const asset = masterDetails?.assetId ?? (action === 'master_complete' && includePhoto ? item === 'ITEM-013' ? 'M013-MASTER-CLEAR' : item === 'ITEM-014' ? count ? 'M014-MASTER-CLEAR' : 'M014-MASTER-STILL' : item === 'ITEM-015' ? 'M015-MASTER-DENT' : item === 'ITEM-016' ? 'M016-MASTER-CLEAR' : item === 'ITEM-025' ? 'M025-MASTER-CLEAR' : item === 'ITEM-028' ? 'M028-MASTER-CLEAR' : undefined : undefined);
    const photoUploadedAt = asset ? new Date(Math.max(...own.map(e => Date.parse(e.occurred_at))) + 60000).toISOString() : undefined;
    make('master_action', { action_type: action === 'master_scrap' ? 'scrap_to_isolator' : lastDecision?.data.disposition === 'rework' ? 'rework_completed' : 'inspection_support', workflow_status: action === 'master_scrap' ? 'SCRAP_ISOLATOR' : 'REVISION_READY', evidence_refs: asset ? [asset] : [], photo_uploaded_at: photoUploadedAt, observation_quality: asset ? 'good' : undefined, executor_id: masterDetails?.operator ?? executor, rework_method: masterDetails?.method, duration_minutes: masterDetails?.durationMinutes, actual_size_mm: masterDetails?.actualSizeMm, paper_inspection: masterDetails?.paperInspection ?? false, inspection_result: masterDetails?.inspectionResult, inspection_note: masterDetails?.inspectionNote, comment: reason, reason });
  } else if (action === 'recheck_fail' || action === 'release') {
    const run = own.filter(e => e.event_type === 'operation_started').at(-1)?.operation_run_id;
    if (action === 'release' && item === 'ITEM-013' && measurement) make('manual_measurement', { feature_id: 'WALL-NEAR-RIGHT-HOLE', measured_value: measurement.value, unit: 'mm', lower_limit: 5, instrument_id: measurement.instrumentId.trim(), calibration_status: measurement.calibrationConfirmed ? 'operator_confirmed' : 'unconfirmed', result: 'within_assumed_limit', is_camera_measurement: false, reason: `Ручной замер: ${measurement.value} мм при минимуме 5,0 мм. Прибор ${measurement.instrumentId.trim()}.` }, { operation_run_id: run });
    const asset = own.filter(e => e.event_type === 'master_action').at(-1)?.data.evidence_refs ?? [];
    make('inspection_result', { inspection_point_id: 'CP-POST-MILL', inspection_result: action === 'release' ? 'no_signs_detected' : 'signs_detected', observation_quality: 'good', confidence: null, defects: action === 'release' ? [] : first?.data.defects ?? [], method: 'manual_verification', evidence_refs: asset, triage_priority: action === 'release' ? 'routine' : 'high', capture_context: { source: 'manual_verification' } }, run ? { operation_run_id: run } : {});
    make('quality_decision', { decision: action === 'release' ? 'release_after_rework' : 'confirmed', disposition: action === 'release' ? 'release' : 'rework', finding_refs: refs, reason });
  }
  advanceItem(item); save(); return action;
}

/** Prepare the synthetic workshop shift once, while preserving decisions already made in the demo. */
export function prepareMasterShift(): void {
  if (authoritative) return;
  const formerItem013Demo = state.other.filter(row => row.message?.item_id === 'ITEM-013' && row.message.source_id === 'ORBITA-DEMO');
  if (formerItem013Demo.length) {
    state.other = state.other.filter(row => !formerItem013Demo.includes(row));
    save();
  }
  seedingMasterShift = true;
  try {
  for (const item of ['ITEM-014', 'ITEM-025']) {
    if (!eventsFor(item).some(event => event.event_type === 'quality_decision')) performAction(item, 'controller', 'confirm', 'Учебное направление подтверждённой детали на доработку по F1', 'QC-02');
  }
  for (const item of ['ITEM-015', 'ITEM-016']) {
    if (!eventsFor(item).some(event => event.event_type === 'quality_decision')) performAction(item, 'controller', 'additional', 'Учебный вызов мастера на очный досмотр по запросу ОТК', 'QC-02');
  }
  } finally { seedingMasterShift = false; }
}

/** Record a controller's instrument reading without treating it as a CV result or quality decision. */
export function recordManualMeasurement(item: string, caseId: string, parameter: string, value: number, instrumentId: string, executor: string, calibrationConfirmed: boolean, criteria?: { lower?: number; upper?: number; document: string }, approval?: { actionId: string; actorId: string }): string {
  const selected = cases.find(entry => entry.id === caseId && entry.item === item);
  if (!selected) throw new Error('Случай контроля не найден');
  if (!parameter.trim() || !Number.isFinite(value) || value < 0 || !instrumentId.trim() || !executor.trim()) throw new Error('Укажите параметр, значение, прибор и контролёра');
  if (!calibrationConfirmed) throw new Error('Подтвердите поверку прибора');
  if (criteria && (!criteria.document.trim() || criteria.lower === undefined && criteria.upper === undefined || criteria.lower !== undefined && !Number.isFinite(criteria.lower) || criteria.upper !== undefined && !Number.isFinite(criteria.upper) || criteria.lower !== undefined && criteria.upper !== undefined && criteria.lower > criteria.upper)) throw new Error('Укажите документ и корректные границы допуска для этого параметра');
  const own = eventsFor(item);
  const latest = own.at(-1);
  const observation = selected.observations.at(-1);
  const run = observation?.operation_run_id ?? own.filter(event => event.event_type === 'operation_started' && event.station_id === observation?.station_id).at(-1)?.operation_run_id;
  if (!latest) throw new Error('Изделие ещё не поступило');
  const occurredAt = new Date(Math.max(...own.map(event => Date.parse(event.occurred_at))) + 60000).toISOString();
  const event: QualityEvent = {
    event_id: approval ? `UI-${approval.actionId}-1` : `UI-${crypto.randomUUID()}`, event_type: 'manual_measurement', schema_version: '2.0', occurred_at: occurredAt,
    source_id: 'ORBITA-UI', item_id: item, item_type_id: latest.item_type_id, line_id: latest.line_id,
    station_id: observation?.station_id ?? latest.station_id, shift_id: observation?.shift_id ?? latest.shift_id, operation_run_id: run, actor_id: approval?.actorId ?? executor.trim(), ...(!approval ? { item_state: latest.item_state } : {}),
    data: { ...(approval ? { security_action_id: approval.actionId } : {}), case_id: caseId, basis_event_ids: observation ? [observation.event_id] : [], feature_id: parameter.trim(), measured_value: value, unit: 'mm', instrument_id: instrumentId.trim(), calibration_status: 'operator_confirmed', is_camera_measurement: false, ...(criteria ? { lower_limit: criteria.lower, upper_limit: criteria.upper, criteria_document: criteria.document.trim(), criteria_source: 'controller_entered' } : {}) },
  };
  const outcome = accept({ delivery_id: `UI-DLV-${crypto.randomUUID()}`, deliver_at: new Date().toISOString(), message: event });
  if (outcome.kind === 'error') throw new Error(outcome.reason);
  events.sort(sortEvents);
  save();
  return event.event_id;
}

/** Save an independent physical check for a case before confirming or rejecting a signal without a usable frame. */
export function recordControllerCheck(item: string, caseId: string, result: 'signs_detected' | 'no_signs_detected', reason: string, executor: string, identified?: { defectTypeId: string; region: string; componentId: string }, approval?: { actionId: string; actorId: string }): string {
  const selected = cases.find(entry => entry.id === caseId && entry.item === item);
  if (!selected) throw new Error('Случай контроля не найден');
  if (reason.trim().length < 5 || !executor.trim()) throw new Error('Укажите результат очной проверки, описание и контролёра');
  if (selected.type === 'UNASSESSABLE' && result === 'signs_detected' && (!identified || !Object.hasOwn(defectNames, identified.defectTypeId) || identified.defectTypeId === 'UNASSESSABLE' || !identified.region.trim() || !itemById.get(item)?.components.some(component => component.id === identified.componentId))) throw new Error('Укажите тип, зону и компонент обнаруженного признака');
  const own = eventsFor(item);
  const latest = own.at(-1);
  const observation = selected.observations.at(-1);
  if (!latest || !observation) throw new Error('Исходное наблюдение не найдено');
  const occurredAt = new Date(Math.max(...own.map(event => Date.parse(event.occurred_at))) + 60000).toISOString();
  const event: QualityEvent = {
    event_id: approval ? `UI-${approval.actionId}-1` : `UI-${crypto.randomUUID()}`, event_type: 'controller_check', schema_version: '2.0', occurred_at: occurredAt,
    source_id: 'ORBITA-UI', item_id: item, item_type_id: latest.item_type_id, line_id: latest.line_id,
    station_id: observation.station_id, shift_id: observation.shift_id, operation_run_id: observation.operation_run_id, ...(!approval ? { item_state: latest.item_state } : {}),
    actor_id: approval?.actorId ?? executor.trim(), data: { ...(approval ? { security_action_id: approval.actionId } : {}), case_id: caseId, observation_event_id: observation.event_id, inspection_result: result, finding_refs: selected.refs, basis_event_ids: [observation.event_id], reason: reason.trim() },
  };
  const outcome = accept({ delivery_id: `UI-DLV-${crypto.randomUUID()}`, deliver_at: new Date().toISOString(), message: event });
  if (outcome.kind === 'error') throw new Error(outcome.reason);
  if (selected.type === 'UNASSESSABLE' && result === 'signs_detected' && identified) {
    const classified: QualityEvent = {
      ...event, event_id: approval ? `UI-${approval.actionId}-2` : `UI-${crypto.randomUUID()}`, event_type: 'inspection_result', occurred_at: new Date(Date.parse(occurredAt) + 60000).toISOString(),
      data: {
        inspection_point_id: observation.data.inspection_point_id ?? observation.station_id, inspection_result: 'signs_detected',
        observation_quality: 'good', confidence: null, defects: [{ finding_id: 'F1', defect_type_id: identified.defectTypeId, component_id: identified.componentId, region: identified.region, severity: 'requires_review' }],
        method: 'manual_verification', evidence_refs: [], triage_priority: 'requires_review',
        basis_event_ids: [event.event_id], capture_context: { source: 'manual_verification', note: reason.trim() }, ...(approval ? { security_action_id: approval.actionId } : {}),
      },
    };
    const classifiedOutcome = accept({ delivery_id: `UI-DLV-${crypto.randomUUID()}`, deliver_at: new Date().toISOString(), message: classified });
    if (classifiedOutcome.kind === 'error') throw new Error(classifiedOutcome.reason);
  }
  events.sort(sortEvents);
  save();
  return event.event_id;
}

function appendRoleEvent(item: string, eventType: string, actor: string, data: EventData, run?: QualityEvent, approval?: { actionId: string; actorId: string }): string {
  const own = eventsFor(item);
  const anchor = run ?? own.at(-1);
  if (!anchor) throw new Error('История изделия не найдена');
  const event: QualityEvent = {
    event_id: approval ? `UI-${approval.actionId}-1` : `UI-${crypto.randomUUID()}`, event_type: eventType, schema_version: '2.0',
    occurred_at: new Date(Math.max(Date.now(), ...own.map(entry => Date.parse(entry.occurred_at) + 1000))).toISOString(),
    source_id: approval ? 'ORBITA-UI' : eventType === 'service_report' ? `SERVICE-${String(data.recipient_role).toUpperCase()}` : eventType === 'master_process_report' ? 'MASTER-UI' : 'TECH-UI',
    item_id: item, item_type_id: anchor.item_type_id, line_id: anchor.line_id,
    station_id: anchor.station_id, shift_id: anchor.shift_id,
    operation_run_id: run?.operation_run_id, equipment_id: run?.equipment_id,
    actor_id: approval?.actorId ?? actor.trim(), data: approval ? { ...data, security_action_id: approval.actionId } : data,
  };
  const outcome = accept({ delivery_id: `UI-DLV-${crypto.randomUUID()}`, deliver_at: new Date().toISOString(), message: event });
  if (outcome.kind === 'error') throw new Error(outcome.reason);
  events.sort(sortEvents); save();
  return event.event_id;
}

export interface MasterProcessInput {
  caseId: string; operationRunId: string; fixtureCondition: 'checked' | 'issue' | 'unknown' | 'not_applicable';
  toolCondition: 'checked' | 'issue' | 'unknown' | 'not_applicable';
  setupChanged: 'yes' | 'no' | 'unknown'; comment: string; actor: string; requestId?: string;
}
/** A master's account supplements MES/MachineLogs; it never rewrites their original messages. */
export function recordMasterProcessReport(input: MasterProcessInput, approval?: { actionId: string; actorId: string }): string {
  const selected = cases.find(record => record.id === input.caseId && record.confirmed);
  if (!selected) throw new Error('Нужен случай с подтверждённым ОТК дефектом');
  if (input.comment.trim().length < 8 || !input.actor.trim()) throw new Error('Укажите исполнителя и фактические сведения об операции');
  const run = input.operationRunId ? eventsFor(selected.item).find(event => event.event_type === 'operation_started' && event.operation_run_id === input.operationRunId) : undefined;
  if (input.operationRunId && !run) throw new Error('Операция не относится к изделию');
  const requestId = input.requestId ?? openRequestId(selected.item, selected.id, 'master');
  if (requestId && !eventsFor(selected.item).some(event => event.event_id === requestId && event.data.case_id === selected.id && event.data.recipient_role === 'master')) throw new Error('Запрос не относится к этому случаю');
  return appendRoleEvent(selected.item, 'master_process_report', input.actor, {
    case_id: input.caseId, request_id: requestId, fixture_condition: input.fixtureCondition, tool_condition: input.toolCondition,
    setup_changed: input.setupChanged, comment: input.comment.trim(), reason: input.comment.trim(),
    basis_event_ids: [selected.decisions.find(event => event.data.decision === 'confirmed')?.event_id, run?.event_id].filter((id): id is string => !!id),
  }, run, approval);
}

export interface CauseReviewInput {
  caseId: string; status: 'hypothesis' | 'confirmed' | 'unknown'; causeType: string;
  reason: string; alternatives: string; missingData: string; basisEventIds: string[]; actor: string;
}
/** A cause finding is a separate authored event tied to one confirmed defect and accepted evidence. */
export function recordCauseReview(input: CauseReviewInput, approval?: { actionId: string; actorId: string }): string {
  const selected = cases.find(record => record.id === input.caseId && record.confirmed);
  if (!selected) throw new Error('Расследовать можно только подтверждённый случай');
  if (!['hypothesis', 'confirmed', 'unknown'].includes(input.status)) throw new Error('Неизвестный статус заключения');
  if (input.reason.trim().length < 12 || !input.actor.trim()) throw new Error('Укажите автора и обоснованный вывод');
  if (input.status === 'confirmed' && (!input.causeType || input.causeType === 'undetermined' || input.basisEventIds.length < 2 || input.alternatives.trim().length < 8)) throw new Error('Для установленной причины нужны тип, минимум два события и проверка альтернатив');
  const own = eventsFor(selected.item);
  const basis = [...new Set(input.basisEventIds)];
  if (input.status === 'confirmed' && basis.length < 2) throw new Error('Нужны минимум два разных события');
  if (basis.some(id => !own.some(event => event.event_id === id))) throw new Error('Основание не принадлежит этому изделию');
  if (input.status === 'confirmed' && !basis.some(id => own.some(event => event.event_id === id && ['item_received', 'operation_started', 'operation_finished', 'machine_state', 'operator_action', 'master_process_report', 'manual_inspection', 'manual_measurement', 'service_report', 'operation_context'].includes(event.event_type)))) throw new Error('Нужно независимое обстоятельство: вход, операция, станок или проверка мастера');
  if (input.status === 'confirmed' && input.causeType === 'procedural_error' && !basis.some(id => own.some(event => event.event_id === id && event.event_type === 'operator_action' && event.data.procedure_step_id))) throw new Error('Для подтверждения нарушения процедуры нужны наблюдение действия и связанный шаг процедуры');
  if (input.status === 'unknown' && input.missingData.trim().length < 8) throw new Error('Укажите, каких сведений не хватает для установления причины');
  return appendRoleEvent(selected.item, 'cause_review', input.actor, {
    case_id: input.caseId, status: input.status, cause_type: input.status === 'unknown' ? 'unknown' : input.causeType || 'undetermined',
    finding_refs: selected.refs, basis_event_ids: basis,
    reason: input.reason.trim(), alternatives: input.alternatives.trim(), missing_data: input.missingData.trim(),
    reviewed_event_ids: own.filter(event => !['cause_review', 'evidence_request'].includes(event.event_type)).map(event => event.event_id),
  }, undefined, approval);
}

function openRequestId(item: string, caseId: string, role: 'master' | 'controller') {
  const own = eventsFor(item);
  return own.filter(event => event.event_type === 'evidence_request' && event.data.case_id === caseId && event.data.recipient_role === role
    && !own.some(answer => answer.data.request_id === event.event_id)).at(-1)?.event_id;
}

/** Late or new facts do not erase a conclusion; they explicitly ask for reconsideration. */
export function causeReviewNeedsRevision(record: Case, input: QualityEvent[] = events): boolean {
  const reviewed = record.review?.data.reviewed_event_ids;
  if (!Array.isArray(reviewed)) return false;
  return input.some(event => event.item_id === record.item && !['cause_review', 'evidence_request'].includes(event.event_type) && !reviewed.includes(event.event_id));
}

export function requestInvestigationEvidence(caseId: string, recipient: EvidenceRecipient, reason: string, actor: string, approval?: { actionId: string; actorId: string }): string {
  const selected = cases.find(record => record.id === caseId && record.confirmed);
  if (!selected) throw new Error('Случай не подтверждён ОТК');
  if (!Object.hasOwn(evidenceRecipients, recipient)) throw new Error('Неизвестная служба предприятия');
  if (reason.trim().length < 8 || !actor.trim()) throw new Error('Укажите запрашиваемые сведения и автора');
  return appendRoleEvent(selected.item, 'evidence_request', actor, {
    case_id: caseId, recipient_role: recipient, reason: reason.trim(), status: 'open', finding_refs: selected.refs,
  }, undefined, approval);
}

/** Local counterpart of an incoming OGM/CZL response, tied to its exact request. */
export function recordServiceReport(input: { requestId: string; recipient: 'mechanic' | 'laboratory'; reason: string; actor: string; documentId: string }): string {
  const request = events.find(event => event.event_id === input.requestId && event.event_type === 'evidence_request' && event.data.recipient_role === input.recipient);
  if (!request) throw new Error('Запрос не относится к выбранной службе');
  if (input.reason.trim().length < 12 || !input.actor.trim() || !input.documentId.trim()) throw new Error('Укажите результат, автора и номер документа');
  return appendRoleEvent(request.item_id, 'service_report', input.actor, { case_id: request.data.case_id, request_id: request.event_id, recipient_role: input.recipient, reason: input.reason.trim(), document_id: input.documentId.trim(), basis_event_ids: [request.event_id] });
}

/** Replace the projection with durable server history; never hydrate synthetic future events. */
export function useAuthoritativeHistory(rows: Delivery[]): void {
  authoritative = true;
  state = { ...emptyState(), outcomes: state.outcomes, counts: state.counts };
  state.other = structuredClone(rows);
  refresh();
  notify();
}

/** Replace the authenticated media catalog after a server refresh. */
export function useMediaCatalog(assets: typeof mediaIndex): void {
  mediaIndex.splice(0, mediaIndex.length, ...assets);
  mediaById.clear();
  for (const asset of assets) mediaById.set(asset.asset_id, asset);
}

/** Display durable server receipts independently of the event projection. */
export function useAuthoritativeReceipts(receipts: { outcomes: IngestOutcome[]; counts: Partial<StoredState['counts']> }): void {
  state.outcomes = receipts.outcomes;
  state.counts = { accepted: 0, duplicate: 0, late: 0, error: 0, ...receipts.counts };
  notify();
}
