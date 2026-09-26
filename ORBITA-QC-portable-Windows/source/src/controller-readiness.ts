import type { Case, QualityEvent } from './domain';
import { controllerEvidenceFrom, latestControllerCheck, machineAlertText } from './controller-evidence';
import { regionNames } from './controller-case';

export type ImageState = 'checking' | 'valid' | 'invalid' | 'unavailable' | 'load_failed';

/** Distinguish unavailable bytes from a verified digest mismatch. */
export async function verifyImage(url: string, expected?: string): Promise<ImageState> {
  try {
    const response = await fetch(url);
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) return 'load_failed';
    const bytes = await response.arrayBuffer();
    if (!expected) return 'unavailable';
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return actual === expected.toLowerCase() ? 'valid' : 'invalid';
  } catch { return 'load_failed'; }
}

export interface DecisionReadiness {
  title: string;
  reasons: string[];
  next: string;
  request: string;
  confirmed: boolean;
}

/** Explain the next review step from received evidence, without converting CV confidence into acceptance criteria. */
export function decisionReadiness(record: Case, history: QualityEvent[], usableImage: boolean): DecisionReadiness {
  const evidence = controllerEvidenceFrom(record, history, usableImage);
  const observation = evidence.observation;
  const check = latestControllerCheck(record, history);
  const manualFinding = observation.data.method === 'manual_verification' && !history.some(event => event.item_id === record.item && event.event_type === 'master_action' && Date.parse(event.occurred_at) > Date.parse(observation.occurred_at));
  const finding = observation.data.defects?.find(row => row.defect_type_id === record.type && row.component_id === record.component && row.region === record.region);
  const reasons: string[] = [];
  const unknown = record.type === 'UNASSESSABLE';
  reasons.push(unknown ? 'Источник не смог оценить изделие. Отсутствие признака не установлено.' : 'Источник зарегистрировал признак дефекта в указанной зоне. Сигнал ещё требует рассмотрения ОТК.');
  if (finding?.severity === 'critical') reasons.push('Источник отметил критическую тяжесть: этот случай требует первоочередного рассмотрения.');
  if (observation.data.observation_quality === 'poor') reasons.push('Источник сообщил ограниченное качество обзора: перепроверьте зону в других условиях.');
  if (!usableImage && !check && !manualFinding) reasons.push('Пригодный для решения кадр недоступен. Нужен результат очного контроля или документированный замер.');
  for (const event of evidence.runEvents) {
    const alert = machineAlertText(event);
    if (alert) reasons.push(`${alert}. Это обстоятельство процесса, причина дефекта не установлена.`);
  }
  const typeName: Record<string, string> = { DENT: 'вмятина', SCRATCH: 'царапина', BURR: 'заусенец', CHIP: 'скол' };
  const target = unknown ? 'изделие и доступность обзора; определить тип, компонент и зону при обнаружении признака' : `зону «${regionNames[record.region] ?? record.region}», компонент ${record.component}; подтвердить или опровергнуть признак «${typeName[record.type] ?? record.type}»`;
  const request = `Проверить ${target}. ${observation.data.observation_quality === 'poor' ? 'Повторить осмотр при другом освещении и ракурсе. ' : ''}Зафиксировать результат и исполнителя. Если требуется размерный контроль — указать параметр, фактический замер, прибор и критерий из КД.`;
  return {
    title: check || manualFinding ? 'Очная проверка есть — можно оформить решение' : usableImage ? 'Кадр доступен — оцените признак перед решением' : 'Есть основание назначить дополнительную проверку',
    reasons,
    next: check ? `Результат осмотра: ${check.data.inspection_result === 'signs_detected' ? 'признак обнаружен' : 'признак не обнаружен'}. Выберите соответствующее решение и запишите основание.` : manualFinding ? 'Оформите решение по зарегистрированному очному наблюдению.' : usableImage ? 'Сопоставьте кадр и текст сигнала. При сомнении назначьте дополнительную проверку. Размерное соответствие оценивайте только по замеру и КД.' : request,
    request,
    confirmed: !!check || manualFinding,
  };
}
