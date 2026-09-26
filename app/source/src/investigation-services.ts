import type { QualityEvent } from './domain';
export const evidenceRecipients = {
  master: { name: 'Мастер участка', label: 'Мастеру участка: проверка оснастки, инструмента и наладки' },
  mechanic: { name: 'ОГМ (Главный механик)', label: 'ОГМ (Главный механик): диагностика биения шпинделя и люфта направляющих' },
  laboratory: { name: 'ЦЗЛ (Заводская лаборатория)', label: 'ЦЗЛ (Заводская лаборатория): спектральный анализ, твёрдость и структура заготовки' },
  controller: { name: 'ОТК / БТК', label: 'ОТК / БТК: запрос повторного координатно-измерительного контроля (КИМ)' },
} as const;
export type EvidenceRecipient = keyof typeof evidenceRecipients;
export function recipientName(role: unknown) { return evidenceRecipients[role as EvidenceRecipient]?.name ?? 'Служба не указана'; }
export function matchesEvidenceAnswer(request: QualityEvent, answer: QualityEvent) {
  if(answer.item_id !== request.item_id || answer.data.case_id !== request.data.case_id || answer.data.request_id !== request.event_id || Date.parse(answer.occurred_at) <= Date.parse(request.occurred_at)) return false;
  return request.data.recipient_role === 'master' ? answer.event_type === 'master_process_report'
    : request.data.recipient_role === 'controller' ? ['manual_inspection','manual_measurement'].includes(answer.event_type)
    : ['mechanic','laboratory'].includes(String(request.data.recipient_role)) && answer.event_type === 'service_report' && answer.data.recipient_role === request.data.recipient_role;
}
