import type { QualityEvent } from './domain';

/** Replay an isolated delivery schedule, preserving source event IDs and occurred_at. */
export function replayQualityIncidents(input: QualityEvent[]) {
  const get = (id: string) => input.find(event => event.event_id === id);
  const control = get('EVT-0047'), start = get('EVT-0044'), warning = get('EVT-0046');
  if (!control || !start || !warning) return [];
  const schedule = [
    { event: control, received: '2026-02-17T16:23:00+03:00', packet: 'DLV-0047' },
    { event: start, received: '2026-02-17T16:25:00+03:00', packet: 'DLV-0044-LATE' },
    { event: control, received: '2026-02-17T16:25:02+03:00', packet: 'EVT-0047-DUP' },
    { event: warning, received: '2026-02-17T16:26:10+03:00', packet: 'DLV-0046-LATE' },
  ];
  const seen = new Set<string>(), incidents = [];
  let latest = -Infinity;
  for (const row of schedule) {
    const occurred = Date.parse(row.event.occurred_at), delay = (Date.parse(row.received)-occurred)/1000;
    if (seen.has(row.event.event_id)) incidents.push({ ...row, type: 'Точный дубликат пакета', action: 'Повтор отклонён по event_id и совпадению содержимого; второй дефект не создан', status: 'Отклонено', tone: 'muted' });
    else if (row.event.event_type === 'operation_started' && occurred < latest) incidents.push({ ...row, type: 'Нарушен порядок доставки', action: 'Начало операции размещено перед контролем по occurred_at; оригинал сохранён', status: 'Нормализовано', tone: 'blue' });
    else if (delay > 120) incidents.push({ ...row, type: `Задержка доставки (+${delay} сек)`, action: 'История пересчитана по occurred_at; время исходного события не изменено', status: 'Обработано', tone: 'green' });
    seen.add(row.event.event_id); latest = Math.max(latest,occurred);
  }
  return incidents;
}
