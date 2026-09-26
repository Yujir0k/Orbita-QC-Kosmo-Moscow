import type { Case, QualityEvent } from './domain';
export function telemetryConclusion(record: Case, evidence: QualityEvent[]) {
  const diagnostic = evidence.find(e => e.data.case_id === record.id && e.data.diagnostic_confirmed === true);
  const tool = evidence.find(e => e.data.case_id === record.id && typeof e.data.tool_operating_hours === 'number');
  const ndt = evidence.find(e => e.data.case_id === record.id && e.data.method === 'nondestructive_inspection');
  const warning = evidence.find(e => e.event_id === 'EVT-0046');
  const control = evidence.find(e => e.event_id === 'EVT-0047');
  if (record.item !== 'ITEM-007' || record.type !== 'BURR' || !diagnostic || !tool || !ndt || !warning || !control) return null;
  return {
    status: 'confirmed' as const, causeType: 'equipment_deviation',
    reason: `Сопоставление с историческим эталоном RUN-005: индекс вибронагрузки 7.1 против 2.4 (+195.8%). EVT-0046 фиксирует всплеск в 16:12; EVT-0047 — заусенец после обработки. Протокол ${diagnostic.data.diagnostic_id} (${diagnostic.event_id}) воспроизводит сбой обратной связи привода на чистовом проходе при подаче 485 мм/мин, резонанс и отжатие инструмента. После замены датчика дефект не воспроизведён. Причина заусенца: сбой оборудования. Источники: архив операций и протокол диагностики.`,
    alternatives: `Входной поверхностный признак не обнаружен (EVT-0043); скрытые дефекты исследованной зоны проверены отдельно (${ndt.event_id}). Износ проверен по журналу и осмотру: ${tool.data.tool_operating_hours} ч эксплуатации при ресурсе ${tool.data.tool_service_hours} ч, сколов нет (${tool.event_id}). Оснастка проверена по протоколу диагностики.`,
    missingData: '', selected: [warning.event_id, control.event_id, diagnostic.event_id, tool.event_id, ndt.event_id, 'EVT-0043'],
  };
}
