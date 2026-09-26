import type { Case, QualityEvent } from './domain';

/** Explain a missing frame without contradicting a recorded CV camera and measurements. */
export function missingFrameReason(observation: QualityEvent): string {
  const absence = observation.data.media_evidence?.after_operation.absence_reason;
  const capture = observation.data.capture_context ?? {};
  const hasCvSignal = observation.data.method === 'external_analyzer' || typeof observation.data.confidence === 'number' && observation.data.confidence > 0 || typeof capture.camera_id === 'string';
  if (absence === 'CLASSIFIED_RESTRICTED') return 'Кадр засекречен: экспорт медиафайлов ограничен режимом безопасности предприятия';
  if (hasCvSignal || absence === 'LOST_IN_TRANSIT') return 'Сбой передачи: медиа-пакет потерян при трансляции с edge-устройства';
  if (absence === 'NO_CAMERA_AT_STATION') return 'На посту нет камеры';
  return 'Причина не указана источником';
}

export interface ControllerEvidence {
  observation: QualityEvent;
  previousInspection?: QualityEvent;
  received?: QualityEvent;
  operation?: QualityEvent;
  machine?: QualityEvent;
  runEvents: QualityEvent[];
  measurement?: QualityEvent;
  missing: string[];
}

/** Use only a check made for this case after its latest observation and any subsequent master action. */
export function latestControllerCheck(record: Case, history: QualityEvent[]): QualityEvent | undefined {
  history = history.filter(event => event.item_id === record.item).sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  const lastObservation = Date.parse(record.observations.at(-1)?.occurred_at ?? '');
  const lastMaster = Math.max(0, ...history.filter(event => event.event_type === 'master_action').map(event => Date.parse(event.occurred_at)));
  const cutoff = Math.max(lastObservation, lastMaster);
  return history.filter(event => event.event_type === 'controller_check' && event.data.case_id === record.id && Date.parse(event.occurred_at) > cutoff).at(-1);
}

/** Select facts linked to the current observation; never use later operations as its cause. */
export function controllerEvidenceFrom(record: Case, history: QualityEvent[], hasPhoto: boolean): ControllerEvidence {
  history = history.filter(event => event.item_id === record.item).sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  const observation = record.observations.at(-1)!;
  const beforeObservation = history.filter(event => Date.parse(event.occurred_at) <= Date.parse(observation.occurred_at));
  const runId = observation.operation_run_id;
  const operation = runId ? beforeObservation.filter(event => event.event_type === 'operation_started' && event.operation_run_id === runId).at(-1) : undefined;
  const machineSamples = runId ? beforeObservation.filter(event => event.event_type === 'machine_state' && event.operation_run_id === runId) : [];
  const machine = machineSamples.filter(event => event.data.synthetic !== true).at(-1) ?? machineSamples.at(-1);
  const cutoff = Math.max(Date.parse(observation.occurred_at), ...history.filter(event => event.event_type === 'master_action').map(event => Date.parse(event.occurred_at)));
  const measurement = history.filter(event => event.event_type === 'manual_measurement' && typeof event.data.measured_value === 'number' && event.data.case_id === record.id && Date.parse(event.occurred_at) >= cutoff).at(-1);
  const missing = [
    !hasPhoto && 'Исходный кадр наблюдения',
    !measurement && 'Фактический замер размера',
    !observation.data.kd_spec?.standard_ref && (!measurement || typeof measurement.data.lower_limit !== 'number' && typeof measurement.data.upper_limit !== 'number') ? 'Допуск по КД для контролируемого размера' : '',
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return {
    observation,
    previousInspection: beforeObservation.filter(event => event.event_type === 'inspection_result' && event.event_id !== observation.event_id).at(-1),
    received: history.find(event => event.event_type === 'item_received'),
    operation,
    machine,
    runEvents: runId ? beforeObservation.filter(event => event.operation_run_id === runId && ['operation_started', 'machine_state', 'operation_paused', 'operator_action', 'operation_finished'].includes(event.event_type)) : [],
    measurement,
    missing,
  };
}

/** Explain a received machine warning using its own value and configured limit. */
export function machineAlertText(event: QualityEvent): string | undefined {
  if (event.event_type !== 'machine_state' || event.data.state !== 'warning') return undefined;
  if (event.data.parameter === 'vibration_index' && typeof event.data.value === 'number') {
    return `Индекс вибрации ${event.data.value} усл. ед.${typeof event.data.configured_limit === 'number' ? ` при пороге ${event.data.configured_limit}` : ''}`;
  }
  if (event.data.parameter === 'tool_check_acknowledged' && event.data.value === false) {
    return 'Проверка инструмента не подтверждена оператором';
  }
  if (event.data.alarm_code === 'VIB-WARN-01') return 'Станок сообщил предупреждение о вибрации';
  return typeof event.data.alarm_code === 'string' ? `Сигнал станка ${event.data.alarm_code}` : 'Предупреждение станка';
}
