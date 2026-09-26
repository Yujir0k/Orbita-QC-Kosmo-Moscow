import { matchesEvidenceAnswer } from './investigation-services';
import { cases, events, eventsFor, mediaFor, operations, type Case, type QualityEvent } from './domain';

const byTime = (a: QualityEvent, b: QualityEvent) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at);

/** Use only accepted events. Historic source deliveries behind a workflow gate are excluded. */
export function investigationEvidence(record: Case) {
  const own = eventsFor(record.item);
  const signal = record.observations[0];
  const signalTime = Date.parse(signal.occurred_at);
  const priorInspections = own.filter(event => event.event_type === 'inspection_result' && Date.parse(event.occurred_at) < signalTime).sort(byTime);
  const before = priorInspections.at(-1);
  const runId = signal.operation_run_id ?? own.filter(event => event.event_type === 'operation_started' && Date.parse(event.occurred_at) < signalTime).at(-1)?.operation_run_id;
  const runEvents = runId ? own.filter(event => event.operation_run_id === runId && ['operation_started', 'operation_finished', 'operation_paused', 'machine_state', 'operator_action'].includes(event.event_type)).sort(byTime) : [];
  const start = runEvents.find(event => event.event_type === 'operation_started');
  const finish = runEvents.find(event => event.event_type === 'operation_finished');
  const machine = runEvents.filter(event => event.event_type === 'machine_state');
  const actions = runEvents.filter(event => event.event_type === 'operator_action');
  const context = runId ? own.filter(event => event.event_type === 'operation_context' && event.operation_run_id === runId).at(-1) : undefined;
  const serviceReports = own.filter(event => event.event_type === 'service_report' && event.data.case_id === record.id);
  const masterReports = own.filter(event => event.event_type === 'master_process_report' && event.data.case_id === record.id);
  const inspectionNotes = own.filter(event => event.event_type === 'manual_inspection' && (event.data.case_id === record.id || event.data.finding_refs?.some(ref => record.refs.includes(ref))));
  const measurements = own.filter(event => event.event_type === 'manual_measurement' && event.data.case_id === record.id);
  const requests = own.filter(event => event.event_type === 'evidence_request' && event.data.case_id === record.id);
  const image = mediaFor(record.item).find(entry => entry.event.event_id === signal.event_id)?.asset;
  const confirmedDecision = record.decisions.find(event => event.data.decision === 'confirmed');
  const evidence = [before, start, context, ...serviceReports, ...machine, ...actions, finish, signal, ...inspectionNotes, ...measurements, confirmedDecision, ...masterReports]
    .filter((event): event is QualityEvent => !!event)
    .filter((event, index, rows) => rows.findIndex(row => row.event_id === event.event_id) === index)
    .sort(byTime);

  const peers = start ? operations.filter(operation => operation.id !== runId && operation.name === (operations.find(op => op.id === runId)?.name ?? '') && operation.end)
    .map(operation => {
      const peerStart = events.find(event => event.event_type === 'operation_started' && event.operation_run_id === operation.id);
      if (!peerStart || !start.equipment_id || !start.data.program_id || !start.data.program_revision
        || peerStart.equipment_id !== start.equipment_id
        || peerStart.item_type_id !== start.item_type_id
        || peerStart.data.operation_id !== start.data.operation_id
        || peerStart.data.program_id !== start.data.program_id
        || peerStart.data.program_revision !== start.data.program_revision
        || Boolean(peerStart.data.previous_operation_run_id) !== Boolean(start.data.previous_operation_run_id)) return null;
      const samples = events.filter(event => event.event_type === 'machine_state' && event.operation_run_id === operation.id);
      const sample = samples.filter(event => event.data.state === 'warning').at(-1) ?? samples.at(-1);
      const inspection = events.find(event => event.event_type === 'inspection_result' && event.operation_run_id === operation.id && Date.parse(event.occurred_at) >= Date.parse(operation.end!));
      return { operation, start: peerStart, sample, inspection };
    })
    .filter((row): row is { operation: typeof operations[number]; start: QualityEvent; sample: QualityEvent | undefined; inspection: QualityEvent | undefined } => !!row)
    .sort((a, b) => Math.abs(Date.parse(a.start.occurred_at) - signalTime) - Math.abs(Date.parse(b.start.occurred_at) - signalTime))
    .slice(0, 6) : [];

  const missing: string[] = [];
  if (!before) missing.push('Контроль до сигнала не поступил');
  else if (before.data.observation_quality !== 'good' || before.data.inspection_result === 'unable_to_assess') missing.push('Предыдущий контроль не позволяет уверенно исключить входной дефект');
  if (start && !machine.length) missing.push('Нет журнала станка для этой операции');
  if (start && !masterReports.length) missing.push('Мастер ещё не передал проверку оснастки, инструмента и изменения наладки');
  if (!image) missing.push('Исходный кадр сигнала не передан');
  if (!start && signal.data.inspection_point_id !== 'CP-IN') missing.push('Не найдена связанная операция');

  return { signal, before, runId, start, finish, machine, actions, context, serviceReports, masterReports, inspectionNotes, measurements, requests, image, confirmedDecision, evidence, peers, missing };
}

export function pendingEvidenceRequests(record: Case) {
  const own = eventsFor(record.item);
  return own.filter(event => event.event_type === 'evidence_request' && event.data.case_id === record.id && !own.some(answer => matchesEvidenceAnswer(event, answer)));
}

export function investigationStatus(record: Case) {
  const status = record.review?.data.status;
  if (status === 'confirmed') return { label: 'Причина установлена', tone: 'green' };
  if (status === 'unknown') return { label: 'Причина не установлена', tone: 'muted' };
  if (status === 'hypothesis') return { label: 'Гипотеза', tone: 'blue' };
  return { label: 'Нужен разбор', tone: 'amber' };
}

export function confirmedInvestigations() { return cases.filter(record => record.confirmed && record.type !== 'UNASSESSABLE'); }
