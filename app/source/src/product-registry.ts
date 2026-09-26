import type { Product, QualityEvent } from './domain';

export type RegistryGroup = 'needs' | 'rework' | 'ready' | 'good' | 'scrap';
export interface RegistryRow {
  item: Product;
  lot: string;
  traveler: string;
  location: string;
  group: RegistryGroup;
  status: string;
  tone: 'amber' | 'blue' | 'green' | 'red';
}

const stageName = (station: string): string => station.startsWith('ST-MILL') || station.startsWith('EQ-CNC') ? 'Фрезерный' : station.startsWith('ST-IN') ? 'Входной контроль' : station.startsWith('ST-ASSEMBLY') || station.startsWith('EQ-ASSEMBLY') || station.startsWith('Передана на следующий этап') ? 'Сборочный цех' : station.startsWith('ST-QC') ? 'Контроль качества' : 'Участок не указан';

/** Project one registry row from the accepted item history, preserving decision and physical location. */
export function projectRegistryRow(item: Product, history: QualityEvent[]): RegistryRow {
  const own = [...history].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  const received = own.find(event => event.event_type === 'item_received');
  const decision = own.filter(event => event.event_type === 'quality_decision').at(-1);
  const master = own.filter(event => event.event_type === 'master_action').at(-1);
  const observation = own.filter(event => event.event_type === 'inspection_result').at(-1);
  const latestState = own.filter(event => event.item_state).at(-1);
  const locationCode = latestState?.item_state?.physical_location.split(':')[0] ?? own.at(-1)?.station_id ?? 'ST-IN';
  const equipment = locationCode.startsWith('EQ-') ? locationCode : locationCode.startsWith('ST-MILL') ? own.filter(event => event.equipment_id && event.station_id.startsWith('ST-MILL')).at(-1)?.equipment_id : undefined;
  const location = `${stageName(locationCode)}${equipment ? ` · ${equipment}` : ''}`;
  const afterDecision = !!master && !!decision && Date.parse(master.occurred_at) > Date.parse(decision.occurred_at);
  let group: RegistryGroup = 'needs';
  let status = 'На рассмотрении ОТК';
  if (decision?.data.disposition === 'scrap' || decision?.data.disposition === 'quarantine' || afterDecision && master?.data.action_type === 'scrap_to_isolator') { group = 'scrap'; status = 'Брак / Изолятор'; }
  else if (decision?.data.disposition === 'rework') { group = afterDecision ? 'ready' : 'rework'; status = afterDecision ? 'Доработка завершена' : 'На доработке в цехе'; }
  else if (decision?.data.disposition === 'release' && (!observation || Date.parse(decision.occurred_at) > Date.parse(observation.occurred_at))) { group = 'good'; status = 'Годен по КД'; }
  else if (!decision && (!observation || observation.data.inspection_result === 'no_signs_detected')) { group = 'good'; status = 'Годен по КД'; }
  else if (decision?.data.decision === 'confirmed' && decision.data.disposition !== 'hold') { group = 'needs'; status = 'Дефект: Превышение КД'; }
  return {
    item,
    lot: typeof received?.data.supplier_lot_id === 'string' ? received.data.supplier_lot_id : '—',
    traveler: typeof received?.data.traveler_id === 'string' ? received.data.traveler_id : '—',
    location,
    group,
    status,
    tone: group === 'needs' ? status.startsWith('Дефект') ? 'red' : 'amber' : group === 'rework' || group === 'ready' ? 'blue' : group === 'scrap' ? 'red' : 'green',
  };
}
