import type { Case, QualityEvent } from './domain';

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

/** Select facts linked to the current observation; never use later operations as its cause. */
export function controllerEvidenceFrom(record: Case, history: QualityEvent[], hasPhoto: boolean): ControllerEvidence {
  const observation = record.observations.at(-1)!;
  const beforeObservation = history.filter(event => Date.parse(event.occurred_at) <= Date.parse(observation.occurred_at));
  const runId = observation.operation_run_id;
  const operation = beforeObservation.filter(event => event.event_type === 'operation_started' && event.operation_run_id === runId).at(-1);
  const machine = beforeObservation.filter(event => event.event_type === 'machine_state' && event.operation_run_id === runId).at(-1);
  const measurement = history.filter(event => event.event_type === 'manual_measurement' && typeof event.data.measured_value === 'number' && (!event.data.case_id || event.data.case_id === record.id)).at(-1);
  const missing = [
    !hasPhoto && 'Исходный кадр наблюдения',
    !measurement && 'Фактический замер размера',
    !measurement || typeof measurement.data.lower_limit !== 'number' && typeof measurement.data.upper_limit !== 'number' ? 'Допуск по КД для контролируемого размера' : '',
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return {
    observation,
    previousInspection: beforeObservation.filter(event => event.event_type === 'inspection_result' && event.event_id !== observation.event_id).at(-1),
    received: history.find(event => event.event_type === 'item_received'),
    operation,
    machine,
    runEvents: beforeObservation.filter(event => event.operation_run_id === runId && ['operation_started', 'machine_state', 'operation_paused', 'operator_action', 'operation_finished'].includes(event.event_type)),
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
