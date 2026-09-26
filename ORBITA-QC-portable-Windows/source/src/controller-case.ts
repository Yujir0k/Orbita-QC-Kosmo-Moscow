import type { Case, MediaAsset, Product, QualityEvent } from './domain';

export interface ControllerCaseData {
  observation: QualityEvent;
  findingId: string;
  componentName: string;
  regionName: string;
  image?: MediaAsset;
  missing: string[];
  present: string[];
  camera: string;
  view: string;
  lighting: string;
  calibration: string;
  confidence: string;
}

export const regionNames: Record<string, string> = {
  edge_B: 'Кромка B',
  body_outer_A: 'Наружная поверхность A корпуса',
  'CP-IN': 'Входной контроль · зона не определена',
  'CP-FINAL': 'Финальный контроль · зона не определена',
  'CP-POST-MILL': 'После обработки · зона не определена',
  outer_left_edge: 'Наружная левая кромка',
  outer_right_edge: 'Наружная правая кромка',
  outer_right_face: 'Наружная правая поверхность',
  front_face: 'Лицевая поверхность',
  inner_edge: 'Внутренняя кромка',
  hole_edge: 'Кромка отверстия',
  front_outer_edge: 'Передняя наружная кромка',
  left_outer_face: 'Левая наружная поверхность',
  right_upper_edge: 'Правая верхняя кромка',
  front_left_flange: 'Передняя левая полка',
  inner_slot_edge: 'Внутренняя кромка паза',
};

export const regionLabel = (region: string) => regionNames[region] ?? region.replace(/_/g, ' ');

const readable = (value: unknown) => typeof value === 'string' && value.trim() ? value : 'Не передано';

/** Disambiguate separate inspection operations for one item in the controller queue. */
export function queueItemLabel(record: Case, records: Case[]): string {
  const sameItem = records.filter(entry => entry.item === record.item).sort((a, b) => Date.parse(a.observations[0].occurred_at) - Date.parse(b.observations[0].occurred_at) || a.id.localeCompare(b.id));
  if (sameItem.length < 2) return record.item;
  return `${record.item}-OP${(sameItem.findIndex(entry => entry.id === record.id) + 1) * 10}`;
}

/** Build a case-specific evidence checklist from the accepted CV event, never from placeholder values. */
export function controllerCaseData(caseRecord: Case, product: Product, assets: MediaAsset[]): ControllerCaseData {
  const observation = caseRecord.observations.at(-1)!;
  const finding = observation.data.defects?.find(row => row.component_id === caseRecord.component && row.region === caseRecord.region && row.defect_type_id === caseRecord.type);
  const capture = observation.data.capture_context ?? {};
  const image = observation.data.media_evidence?.after_operation.status === 'MISSING' ? undefined : assets.find(asset => observation.data.evidence_refs?.includes(asset.asset_id));
  const component = product.components.find(row => row.id === caseRecord.component);
  const componentName = component?.component_type_id === 'BODY' ? 'Корпус' : component?.component_type_id === 'INSERT' ? 'Вставка' : component?.component_type_id === 'FASTENER' ? 'Крепёж' : 'Компонент не определён';
  const missing: string[] = [];
  const present: string[] = [];
  if (image) present.push('Исходный кадр привязан к наблюдению');
  else missing.push('Исходный кадр CV не передан');
  if (observation.data.observation_quality === 'good') present.push('Качество обзора указано как достаточное');
  else missing.push('Обзор ограничен: нужна проверка в других условиях');
  if (component) present.push('Деталь определена: ' + componentName);
  else missing.push('Деталь и зона дефекта не определены');
  if (typeof observation.data.confidence === 'number') {
    if (observation.data.confidence < 0.6) missing.push('Низкая уверенность модели: требуется очная проверка');
    else present.push('Уверенность модели передана');
  } else if (observation.data.method === 'external_analyzer') missing.push('Уверенность модели не передана');
  if (observation.operation_run_id) present.push('Есть связь с производственной операцией');
  else missing.push('Нет связи с конкретным запуском операции');
  if (typeof capture.camera_id === 'string' && typeof capture.view_id === 'string') present.push('Камера и ракурс известны');
  else missing.push('Камера или ракурс не указаны');
  if (typeof capture.calibration_profile_version === 'string') present.push('Версия калибровки передана');
  else missing.push('Версия калибровки не передана');
  return {
    observation,
    findingId: finding?.finding_id ?? '—',
    componentName,
    regionName: regionNames[caseRecord.region] ?? caseRecord.region.replace(/_/g, ' '),
    image,
    missing,
    present,
    camera: readable(capture.camera_id),
    view: readable(capture.view_id),
    lighting: readable(capture.lighting_recipe_id),
    calibration: readable(capture.calibration_profile_version),
    confidence: typeof observation.data.confidence === 'number' ? `${Math.round(observation.data.confidence * 100)}%` : 'Не передана',
  };
}
