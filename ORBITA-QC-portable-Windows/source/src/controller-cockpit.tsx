import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { cases, defectNames, describeEvent, eventNames, events, eventsFor, inScope, items, mediaIndex, resultNames, stationNames, time, type Case, type QualityEvent, type Scope, type WorkflowAction } from './domain';
import { currentSecurityUser, securePerformAction, secureRecordControllerCheck, secureRecordManualMeasurement } from './security-client';
import { controllerCaseData, queueItemLabel, type ControllerCaseData } from './controller-case';
import { controllerEvidenceFrom, latestControllerCheck, machineAlertText, missingFrameReason } from './controller-evidence';
import { decisionReadiness, verifyImage, type ImageState } from './controller-readiness';
import { inspectionCaseFrom, type InspectionCase, type InspectionFrame } from './inspection-case';
import { Icon, ImageLightbox } from './ui';

type QueueFilter = 'critical' | 'rework' | 'master_rework' | 'unassessable' | 'all';
type HashState = ImageState;
const manualRegions = [
  ['outer_left_edge', 'Наружная левая кромка'], ['outer_right_edge', 'Наружная правая кромка'],
  ['outer_right_face', 'Наружная правая поверхность'], ['front_face', 'Лицевая поверхность'],
  ['inner_edge', 'Внутренняя кромка'], ['hole_edge', 'Кромка отверстия'],
  ['edge_B', 'Кромка B'], ['body_outer_A', 'Наружная поверхность A'],
] as const;

const isFormTarget = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"]');

function compareAge(createdAt: string, timelineEnd: number): string {
  const hours = Math.max(0, Math.floor((timelineEnd - Date.parse(createdAt)) / 3600000));
  return hours >= 24 ? `${Math.floor(hours / 24)} д в ленте` : `${hours} ч в ленте`;
}

/** Whether a defect case currently requires a controller decision. */
export function queueStatus(record: Case): boolean {
  if (record.type === 'UNASSESSABLE' && record.status === 'Доппроверка выполнена') return false;
  const caseData = inspectionCaseFrom(record);
  const own = eventsFor(record.item);
  const lastDecision = own.filter(event => event.event_type === 'quality_decision').at(-1);
  const scrapReady = record.item === 'ITEM-015' && record.type !== 'UNASSESSABLE' && lastDecision?.data.disposition === 'quarantine' && own.some(event => event.event_type === 'technical_disposition' && event.data.disposition === 'rework_not_allowed');
  if (scrapReady) return true;
  return caseData.status === 'NEW_SIGNAL' || caseData.status === 'REWORK_VERIFICATION' || caseData.status === 'UNDER_REVIEW' && caseData.iteration > 1 && caseData.masterReworkReport?.actionType === 'inspection_support';
}

function Frame({ frame, label, contrast, zoom, grid, cvSignal, bbox }: { frame: InspectionFrame; label: string; contrast: boolean; zoom: boolean; grid: boolean; cvSignal: boolean; bbox?: [number, number, number, number] }) {
  const [failed, setFailed] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  useEffect(() => setFailed(false), [frame.url]);
  const available = !!frame.url && !failed;
  const restricted = !failed && frame.absenceReason === 'CLASSIFIED_RESTRICTED';
  const lost = failed || frame.absenceReason === 'LOST_IN_TRANSIT' || cvSignal && !restricted && !available;
  return <article className="qc-frame-card">
    <header><strong>{label}</strong><span>{frame.capturedAt ? time(frame.capturedAt) : 'Время не передано'} · {frame.checkpoint ?? 'Точка контроля не передана'}</span></header>
    <div className={['qc-frame', available && contrast && 'high-contrast', available && zoom && 'zoomed', available && grid && 'with-grid'].filter(Boolean).join(' ')}>
      {available ? <div className="qc-image-stage"><button type="button" className="qc-image-open" aria-label={`Открыть ${label} крупно`} onClick={() => setLightboxOpen(true)}><img src={frame.url} alt={label} onError={() => setFailed(true)}/><span>Открыть крупно</span></button>{bbox && <span className="qc-bbox" style={{ left: bbox[0] + '%', top: bbox[1] + '%', width: bbox[2] + '%', height: bbox[3] + '%' }} aria-label="Область дефекта от CV"/>}</div>
        : <div className={['qc-frame-absence', restricted ? 'restricted' : lost ? 'lost' : 'unknown'].join(' ')}>
          <strong className="qc-absence-badge"><Icon name={restricted ? 'lock' : 'alert'} size={19}/>{restricted ? 'ФОТО ЗАСЕКРЕЧЕНО' : lost ? 'ФОТО ПОТЕРЯНО' : 'ФОТО НЕДОСТУПНО'}</strong>
          <p>{restricted ? 'Кадр засекречен: экспорт медиафайлов ограничен режимом безопасности предприятия.' : failed ? 'Не удалось загрузить файл кадра. Визуальный контроль невозможен.' : lost ? 'Сбой передачи: медиа-пакет потерян при трансляции с edge-устройства.' : frame.absenceReason === 'NO_CAMERA_AT_STATION' ? 'На точке контроля нет камеры. Для визуального контроля назначьте очный осмотр.' : 'Кадр не предоставлен источником. Для визуального контроля назначьте очный осмотр.'}</p>
        </div>}
    </div>
    <footer title={frame.hash}>SHA-256: <span>{frame.hash || 'не передан'}</span></footer>
    {lightboxOpen && frame.url && <ImageLightbox src={frame.url} alt={label} title={`${label} · крупный план`} onClose={() => setLightboxOpen(false)} />}
  </article>;
}

function EvidenceViewer({ record, hashState }: { record: InspectionCase; hashState: HashState }) {
  const [zoom, setZoom] = useState(false);
  const [contrast, setContrast] = useState(false);
  const [grid, setGrid] = useState(false);
  const evidence = record.visualEvidence;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'z' && !isFormTarget(event.target)) { event.preventDefault(); setZoom(value => !value); }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  const camera = evidence.cameraMeta;
  return <section className="qc-viewer" aria-label="Визуальная база">
    <h2 className="qc-tier-title">Визуальная база</h2>
    {hashState === 'invalid' && <p className="qc-image-warning" role="alert">Целостность кадра нарушена. Решение по изображению заблокировано.</p>}
    {hashState === 'load_failed' && <p className="qc-image-warning" role="alert">Файл кадра недоступен. Проверка целостности не выполнена; решение по изображению заблокировано.</p>}
    <div className="qc-frame-pair">
      <Frame frame={evidence.before} label="ДО операции" contrast={contrast} zoom={zoom} grid={grid} cvSignal={evidence.aiConfidence !== undefined || !!evidence.cameraMeta.cameraId}/>
      <Frame frame={evidence.after} label="ПОСЛЕ операции" contrast={contrast} zoom={zoom} grid={grid} cvSignal={evidence.aiConfidence !== undefined || !!evidence.cameraMeta.cameraId} bbox={evidence.defectBBox}/>
    </div>
    <div className="qc-toolbar-row"><div className="qc-toolbar">
      <button aria-pressed={zoom} onClick={() => setZoom(value => !value)}><Icon name="search" size={17}/>Зум <kbd>Z</kbd></button>
      <button aria-pressed={grid} onClick={() => setGrid(value => !value)}><Icon name="layer" size={17}/>Сетка</button>
      <button aria-pressed={contrast} onClick={() => setContrast(value => !value)}><Icon name="control" size={17}/>Контраст</button>
    </div>
    <div className="qc-meta">
      <span>Камера <strong>{camera.cameraId ?? '—'}</strong></span>
      <span>Свет <strong>{camera.lightingProfile ?? '—'}</strong></span>
      <span>Калибровка <strong>{camera.calibrationStatus === 'VALID' ? 'активна' : camera.calibrationProfile ?? 'нет данных'}</strong></span>
      <span className={hashState === 'valid' ? 'valid' : ''}><Icon name={hashState === 'valid' ? 'check' : 'help'} size={15}/>{hashState === 'valid' ? 'SHA-256 подтверждён' : hashState === 'checking' ? 'Проверка SHA-256' : hashState === 'invalid' ? 'Хеш не совпал' : hashState === 'load_failed' ? 'Файл недоступен' : 'Хеш не передан'}</span>
    </div></div>
  </section>;
}

function ControllerFacts({ record, source, history, caseData, openCase, hashState }: { record: InspectionCase; source: Case; history: QualityEvent[]; caseData: ControllerCaseData; openCase: (item: string, caseId: string) => void; hashState: HashState }) {
  const [manualOpen, setManualOpen] = useState(false);
  const [limitLower, setLimitLower] = useState('');
  const [limitUpper, setLimitUpper] = useState('');
  const [limitDocument, setLimitDocument] = useState('');
  const [parameter, setParameter] = useState('');
  const [value, setValue] = useState('');
  const [instrument, setInstrument] = useState('');
  const [calibrated, setCalibrated] = useState(false);
  const [message, setMessage] = useState('');
  const [checkOpen, setCheckOpen] = useState(false);
  const [checkResult, setCheckResult] = useState<'signs_detected' | 'no_signs_detected'>(source.type === 'UNASSESSABLE' ? 'no_signs_detected' : 'signs_detected');
  const [checkNote, setCheckNote] = useState('');
  const [identifiedType, setIdentifiedType] = useState('DENT');
  const [identifiedRegion, setIdentifiedRegion] = useState<string>(manualRegions[0][0]);
  const productComponents = items.find(item => item.id === record.itemId)?.components ?? [];
  const [identifiedComponent, setIdentifiedComponent] = useState(productComponents[0]?.id ?? '');
  const evidence = controllerEvidenceFrom(source, history, !!caseData.image);
  const { observation, previousInspection, received, operation, machine, runEvents, measurement } = evidence;
  const reportedDuration = runEvents.find(event => event.event_type === 'operation_finished')?.data.reported_duration as { value?: number; unit?: string; meaning?: string } | undefined;
  const defect = observation.data.defects?.find(finding => finding.defect_type_id === source.type && finding.region === source.region && finding.component_id === source.component);
  const kdSpec = observation.data.kd_spec;
  const mediaEvidence = observation.data.media_evidence;
  const latestState = history.filter(event => event.item_state).at(-1)?.item_state;
  const capture = observation.data.capture_context ?? {};
  const incoming = previousInspection?.data.inspection_result;
  const load = machine?.data.spindle_load_peak_pct;
  const toolMinutes = machine?.data.tool_life_used_min;
  const measured = measurement?.data.measured_value;
  const lower = measurement?.data.lower_limit;
  const upper = measurement?.data.upper_limit;
  const outsideLimit = typeof measured === 'number' && (typeof lower === 'number' && measured < lower || typeof upper === 'number' && measured > upper);
  const disposition = record.technologistFinding;
  const controllerCheck = latestControllerCheck(source, history);
  const submitMeasurement = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await secureRecordManualMeasurement(record.itemId, record.id, parameter, Number(value), instrument, calibrated,
        limitLower || limitUpper || limitDocument ? { lower: limitLower ? Number(limitLower) : undefined, upper: limitUpper ? Number(limitUpper) : undefined, document: limitDocument } : undefined);
      setMessage(limitLower || limitUpper ? 'Замер и введённый контролёром критерий записаны с источником и автором.' : 'Показание прибора записано. Для вывода о допуске нужны пределы из КД.');
      setManualOpen(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось записать замер'); }
  };
  const submitCheck = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const checkId = await secureRecordControllerCheck(record.itemId, record.id, checkResult, checkNote,
        source.type === 'UNASSESSABLE' && checkResult === 'signs_detected' ? { defectTypeId: identifiedType, region: identifiedRegion, componentId: identifiedComponent } : undefined);
      if (source.type === 'UNASSESSABLE' && checkResult === 'signs_detected') {
        const classified = cases.find(row => row.item === record.itemId && row.observations.some(event => event.data.basis_event_ids?.includes(checkId)));
        if (classified) { openCase(record.itemId, classified.id); return; }
      }
      setMessage('Очная проверка записана отдельно от исходного сигнала. Теперь можно выбрать соответствующее решение.');
      setCheckNote('');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось записать проверку'); }
  };
  return <section className="qc-instruments qc-facts" aria-label="Факты для решения контролёра">
    <div className="qc-facts-heading"><h2 className="qc-tier-title">Факты для решения</h2><span>Сигнал: {observation.source_id} · {observation.event_id} · {time(observation.occurred_at)}</span></div>
    <div className="qc-instrument-grid">
      <article className="qc-instrument-card">
        <div className="qc-fact-card-head"><h3>01 · Что обнаружено</h3><span className="qc-fact-source">{observation.data.method === 'external_analyzer' ? 'Сигнал CV' : 'Наблюдение'}</span></div>
        <strong className="qc-fact-hero">{defectNames[source.type] ?? source.type}</strong>
        <p className="qc-fact-subtitle">{caseData.regionName} · {caseData.componentName}{defect?.component_id && <span className="qc-fact-id"> · {defect.component_id}</span>}</p>
        <div className="qc-fact-row"><span>Результат контроля</span><strong>{resultNames[observation.data.inspection_result ?? ''] ?? 'Не передан'}</strong></div>
        <div className="qc-fact-row"><span>Точка контроля</span><strong>{observation.data.inspection_point_id ?? observation.station_id}</strong></div>
        <div className="qc-fact-row"><span>Линия / смена</span><strong>{observation.line_id} · {observation.shift_id}</strong></div>
        <div className="qc-fact-metrics">
          {typeof observation.data.confidence === 'number' && <div><span>Уверенность модели</span><strong>{Math.round(observation.data.confidence * 100)}%</strong></div>}
          <div><span>Длина дефекта</span><strong>{typeof defect?.length_mm === 'number' ? `${defect.length_mm} мм` : 'Не передана'}</strong></div>
          <div><span>Ширина</span><strong>{typeof defect?.width_mm === 'number' ? `${defect.width_mm} мм` : 'Не передана'}</strong></div>
        </div>
        <div className="qc-fact-row"><span>Оценка глубины</span><strong>{typeof defect?.depth_estimated_mm === 'number' ? `${defect.depth_estimated_mm} мм` : 'Требуется профилометр'}</strong></div>
        {typeof defect?.length_mm === 'number' && <p className="qc-fact-caution">Оценка модели{typeof defect.dimension_uncertainty_mm === 'number' ? `, погрешность около ±${defect.dimension_uncertainty_mm} мм` : ''}. Не заменяет замер поверенным прибором.</p>}
        <details className="qc-fact-details"><summary>История и параметры наблюдения</summary>
        {previousInspection ? <div className="qc-comparison"><h4>До → текущее наблюдение</h4><p><strong>{resultNames[incoming ?? ''] ?? incoming}</strong> → <strong>{resultNames[observation.data.inspection_result ?? ''] ?? 'Не передан'}</strong></p><span>{previousInspection.data.inspection_point_id ?? previousInspection.station_id} · {time(previousInspection.occurred_at)} · обзор {previousInspection.data.observation_quality === 'good' ? 'достаточный' : previousInspection.data.observation_quality === 'poor' ? 'ограничен' : 'не указан'}</span><p>{observation.data.comparison?.summary}</p><p className="qc-fact-caution">Предыдущий результат относится к изделию. Время обнаружения само по себе не доказывает причину дефекта.</p></div> : <p className="qc-fact-empty">Предыдущего контроля в принятой истории нет. Состояние до сигнала неизвестно.</p>}
        <div className="qc-fact-row"><span>Качество наблюдения</span><strong>{observation.data.observation_quality === 'good' ? 'Источник оценил обзор как достаточный' : observation.data.observation_quality === 'poor' ? 'Обзор ограничен' : 'Оценка не передана'}</strong></div>
        {typeof capture.camera_id === 'string' && <div className="qc-fact-row"><span>Камера / ракурс</span><strong>{capture.camera_id}{typeof capture.view_id === 'string' ? ` · ${capture.view_id}` : ''}</strong></div>}
        <div className="qc-fact-row"><span>Освещение / профиль калибровки</span><strong>{caseData.lighting} · {caseData.calibration}</strong></div>
        <div className="qc-fact-row"><span>Версия анализатора</span><strong>{observation.analyzer_version ?? 'Не передана'}</strong></div>
        {!caseData.image && <p className="qc-fact-caution">Причина отсутствия кадра после операции: {missingFrameReason(observation)}.</p>}
        {typeof observation.data.reason === 'string' && <p className="qc-fact-description">{observation.data.reason}</p>}
        {caseData.image?.description && <p className="qc-fact-description"><strong>Описание связанного кадра:</strong> {caseData.image.description}</p>}
        <p className="qc-fact-caution">{observation.data.method === 'manual_verification' ? 'Результат очного контроля записан отдельно от окончательного решения.' : 'Признак CV требует решения контролёра; уверенность модели не является размером дефекта.'}</p></details>
      </article>
      <article className="qc-instrument-card">
        <div className="qc-fact-card-head"><h3>02 · Что происходило до сигнала</h3><span className="qc-fact-source">MES / станок</span></div>
        {operation ? <>
          <strong className="qc-fact-hero">{stationNames[operation.station_id] ?? operation.data.operation_id ?? 'Операция'}</strong>
          <p className="qc-fact-subtitle">{operation.operation_run_id} · {time(operation.occurred_at)}</p>
          <div className="qc-fact-pairs">
            {operation.equipment_id && <div><span>Станок</span><strong>{operation.equipment_id}</strong></div>}
            {operation.actor_id && <div><span>Оператор</span><strong>{operation.actor_id}</strong></div>}
            {typeof operation.data.program_id === 'string' && <div><span>Программа</span><strong>{operation.data.program_id}{typeof operation.data.program_revision === 'string' ? ` · rev. ${operation.data.program_revision}` : ''}</strong></div>}
            {typeof operation.data.tool_id === 'string' && <div><span>Инструмент</span><strong>{operation.data.tool_id}</strong></div>}
            {typeof operation.data.fixture_id === 'string' && <div><span>Оснастка</span><strong>{operation.data.fixture_id}</strong></div>}
            {typeof machine?.data.coolant_state === 'string' && <div><span>СОЖ</span><strong>{machine.data.coolant_state === 'on' ? 'Включена' : machine.data.coolant_state}</strong></div>}
            {typeof reportedDuration?.value === 'number' && <div><span>{reportedDuration.meaning === 'elapsed_station_time' ? 'Полное время на участке (MES)' : 'Длительность по MES'}</span><strong>{reportedDuration.value} {reportedDuration.unit === 'minute' ? 'мин' : reportedDuration.unit === 'second' ? 'с' : reportedDuration.unit ?? '(единица не передана)'}</strong></div>}
          </div>
        </> : <div className="qc-mes-warning" role="status">⚠️ Событие MES не сопоставлено: Телеметрия станка за данный период времени не поступила (возможна задержка доставки событий).</div>}
        {operation && machine && <div className="qc-fact-telemetry">
          {typeof load === 'number' && <div><span>Пик нагрузки шпинделя</span><strong>{load}%</strong><progress max="100" value={Math.min(load, 100)} aria-label="Пиковая нагрузка шпинделя"/></div>}
          {typeof toolMinutes === 'number' && <div><span>Наработка инструмента</span><strong>{toolMinutes} мин</strong></div>}
          {machine.data.state === 'warning' && <p className="qc-fact-alert">{machineAlertText(machine)}</p>}
        </div>}
        {operation && <details className="qc-fact-details"><summary>События запуска · {runEvents.length}</summary><div className="qc-event-timeline">{runEvents.length ? <ol>{runEvents.map(event => <li key={event.event_id}><time>{time(event.occurred_at).split(', ').at(-1)}</time><div><strong>{event.event_type === 'machine_state' ? `Станок: ${event.data.state === 'warning' ? 'предупреждение' : event.data.state === 'running' ? 'работает' : event.data.state ?? 'состояние'}` : eventNames[event.event_type] ?? event.event_type}</strong>{machineAlertText(event) && <p className="qc-fact-alert">{machineAlertText(event)}</p>}{event.event_type === 'operator_action' && <p>{event.data.action_type === 'required_checkpoint_skipped' ? 'Источник сообщил о пропуске обязательной проверки' : event.data.action_type} · {event.data.procedure_step_id} · {event.actor_id}</p>}{event.data.reason_code && <p>Причина: {event.data.reason_code}</p>}<details className="qc-source-details"><summary>{event.source_id} · {event.event_id}</summary><pre>{JSON.stringify(event, null, 2)}</pre></details></div></li>)}</ol> : <p>Лог запуска не поступил.</p>}</div></details>}
        {operation && !machine && <p className="qc-mes-warning">⚠️ Телеметрия связанного запуска не поступила (возможна задержка доставки событий).</p>}
        {machine && <p className="qc-fact-caution">Норматив для пиковой нагрузки и ресурс инструмента не переданы. Наработка в минутах не определяет процент износа.</p>}
        <p className="qc-fact-caution">Состояние станка показывает обстоятельства, но не доказывает причину дефекта.</p>
      </article>
      <article className="qc-instrument-card">
        <div className="qc-fact-card-head"><h3>03 · Чем подтверждено</h3><span className="qc-fact-source">КД / ОТК</span></div>
        <div className="qc-fact-row"><span>Исходный кадр сигнала</span><strong>{caseData.image ? hashState === 'load_failed' ? 'Ссылка есть, файл недоступен' : hashState === 'invalid' ? 'Хеш файла не совпал' : 'Привязан к наблюдению' : 'Не поступил'}</strong></div>
        {mediaEvidence && <><div className="qc-fact-row"><span>До операции</span><strong>{mediaEvidence.before_operation.status === 'AVAILABLE' ? 'Кадр доступен' : mediaEvidence.before_operation.absence_reason === 'CLASSIFIED_RESTRICTED' ? 'Кадр закрыт' : 'Кадр отсутствует'}</strong></div><div className="qc-fact-row"><span>После операции</span><strong>{mediaEvidence.after_operation.status === 'AVAILABLE' ? 'Кадр доступен' : mediaEvidence.after_operation.absence_reason === 'LOST_IN_TRANSIT' ? 'Потерян при передаче' : mediaEvidence.after_operation.absence_reason === 'CLASSIFIED_RESTRICTED' ? 'Кадр закрыт' : 'Кадр отсутствует'}</strong></div></>}
        {kdSpec && <div className="qc-kd-comparison"><h4>Сопоставление с КД</h4>
          <div className="qc-fact-row"><span>Класс поверхности</span><strong className={kdSpec.surface_zone_class === 'ZONE_A_CRITICAL' ? 'qc-critical-zone' : ''}>{kdSpec.surface_zone_class}</strong></div>
          <div className="qc-fact-row"><span>Допуск по КД / ОСТ</span><strong>{kdSpec.max_allowable_defect_length_mm === 0 ? 'Не допускаются (критично, порог 0 мм)' : `Максимум ${kdSpec.max_allowable_defect_length_mm} мм`}</strong></div>
          <span className="qc-kd-standard">{kdSpec.standard_ref}</span>
          {typeof defect?.length_mm === 'number' && defect.length_mm > kdSpec.max_allowable_defect_length_mm && <strong className="qc-limit-exceeded"><Icon name="alert" size={16}/>Превышение допуска КД</strong>}
          {kdSpec.source_kind === 'synthetic_demo_assumption' && <p className="qc-fact-caution">Учебный критерий КД. Сравнение с оценкой модели требует решения ОТК.</p>}
        </div>}
        {latestState && <div className="qc-location"><p>Локация: <strong>{latestState.physical_location}</strong></p><span className={`qc-lock-badge ${latestState.line_lock_status === 'HELD_AT_STATION' ? 'held' : ''}`} title={latestState.line_lock_status}><Icon name={latestState.line_lock_status === 'HELD_AT_STATION' ? 'lock' : 'flow'} size={15}/>{latestState.line_lock_status === 'HELD_AT_STATION' ? 'Удержание станка' : latestState.line_lock_status === 'IN_BUFFER' ? 'В буфере' : 'Передана дальше'} · {latestState.line_lock_status}</span></div>}
        {record.masterReworkReport && <div className="qc-fact-check"><strong>{record.masterReworkReport.actionType === 'rework_completed' ? 'Отчёт о доработке' : 'Отчёт о доппроверке'}</strong><span>{record.masterReworkReport.masterName} · {time(record.masterReworkReport.completedAt)}</span><p>{record.masterReworkReport.actionDescription || 'Описание не передано'}</p></div>}
        {controllerCheck && <div className="qc-fact-check"><strong>Очная проверка: {controllerCheck.data.inspection_result === 'signs_detected' ? 'признак подтверждён' : 'признак не обнаружен'}</strong><span>{controllerCheck.actor_id} · {time(controllerCheck.occurred_at)}</span><p>{controllerCheck.data.reason}</p></div>}
        <button className="qc-add-measurement" type="button" aria-expanded={checkOpen} onClick={() => setCheckOpen(open => !open)}>{checkOpen ? 'Свернуть очный осмотр' : '+ Записать результат очного осмотра'}</button>
        {checkOpen && <form className="qc-check-form" onSubmit={submitCheck}>
          <strong>Результат фактически выполненного осмотра</strong><span>Для назначения будущей проверки используйте действие «Назначить доппроверку».</span>
          <label>Результат<select value={checkResult} onChange={event => setCheckResult(event.target.value as 'signs_detected' | 'no_signs_detected')}><option value="signs_detected">Признак обнаружен</option><option value="no_signs_detected">Признак не обнаружен</option></select></label>
          {source.type === 'UNASSESSABLE' && checkResult === 'signs_detected' && <>
            <label>Тип дефекта<select value={identifiedType} onChange={event => setIdentifiedType(event.target.value)}>{['DENT', 'SCRATCH', 'BURR', 'CHIP'].map(type => <option key={type} value={type}>{defectNames[type]}</option>)}</select></label>
            <label>Зона<select value={identifiedRegion} onChange={event => setIdentifiedRegion(event.target.value)}>{manualRegions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>Компонент<select value={identifiedComponent} onChange={event => setIdentifiedComponent(event.target.value)}>{productComponents.map(component => <option key={component.id} value={component.id}>{component.id}</option>)}</select></label>
          </>}
          <label>Что проверено<textarea required minLength={5} value={checkNote} onChange={event => setCheckNote(event.target.value)} placeholder="Опишите осмотр детали, зоны и результат"/></label>
          <label>Контролёр<input value={currentSecurityUser()?.id ?? ''} readOnly/></label>
          <button type="submit">Записать очную проверку</button>
        </form>}
        {measurement && typeof measured === 'number' ? <div className="qc-fact-measure"><strong>{measured} {typeof measurement.data.unit === 'string' ? measurement.data.unit : 'мм'}</strong><span>{String(measurement.data.feature_id ?? 'Контролируемый параметр')}</span>{typeof lower === 'number' || typeof upper === 'number' ? <p className={outsideLimit ? 'qc-fact-alert' : 'qc-fact-ok'}>{outsideLimit ? 'Вне зарегистрированного допуска' : 'В пределах зарегистрированного допуска'} · {typeof lower === 'number' ? `от ${lower}` : ''}{typeof upper === 'number' ? ` до ${upper}` : ''}</p> : <p className="qc-measure-status">Допуск по КД не передан</p>}{typeof measurement.data.instrument_id === 'string' && <small>Прибор {measurement.data.instrument_id} · {measurement.actor_id}</small>}</div> : <div className="qc-fact-empty qc-measurement-empty"><span className="qc-empty-kicker">Размерный контроль</span><strong>Линейный размер детали по КД не подтвержден (требуется поверенный инструмент)</strong><p>Показание прибора для этого случая в исходном потоке не поступило.</p></div>}
        {measurement && typeof measurement.data.criteria_document === 'string' && <p className="qc-fact-caution">Критерий введён контролёром: {measurement.data.criteria_document}. Поверка прибора подтверждена исполнителем.</p>}
        <button className="qc-add-measurement" type="button" onClick={() => setManualOpen(open => !open)}>{measurement ? '+ Записать новый замер' : '+ Внести ручной замер с прибора'}</button>
        {manualOpen && <form className="qc-manual-form" onSubmit={submitMeasurement}>
          <label>Параметр по КД<input required value={parameter} onChange={event => setParameter(event.target.value)} placeholder="Например, толщина стенки"/></label>
          <label>Показание, мм<input required type="number" min="0" step="any" value={value} onChange={event => setValue(event.target.value)}/></label>
          <label>ID прибора<input required value={instrument} onChange={event => setInstrument(event.target.value)}/></label>
          <label>Контролёр<input value={currentSecurityUser()?.id ?? ''} readOnly/></label>
          <details className="qc-measure-criteria"><summary>Допуск для этого параметра — если известен по КД</summary><p>Введите из документа. Пустые поля означают, что критерий неизвестен.</p><label>Нижняя граница, мм<input type="number" step="any" value={limitLower} onChange={event => setLimitLower(event.target.value)}/></label><label>Верхняя граница, мм<input type="number" step="any" value={limitUpper} onChange={event => setLimitUpper(event.target.value)}/></label><label>Документ, редакция и пункт<input value={limitDocument} onChange={event => setLimitDocument(event.target.value)}/></label></details>
          <label className="qc-calibrated"><input type="checkbox" checked={calibrated} onChange={event => setCalibrated(event.target.checked)}/> Поверка прибора подтверждена</label>
          <button type="submit">Записать замер</button>
        </form>}
        {message && <p role="status" className="qc-measurement-message">{message}</p>}
        <details className="qc-fact-details"><summary>Маршрут и недостающие данные</summary><div className="qc-fact-pairs">
          <div><span>Заказ</span><strong>{record.workOrder}</strong></div>
          {typeof received?.data.supplier_lot_id === 'string' && <div><span>Партия</span><strong>{received.data.supplier_lot_id}</strong></div>}
          {typeof received?.data.traveler_id === 'string' && <div><span>Маршрут</span><strong>{received.data.traveler_id}</strong></div>}
          {typeof received?.data.route_revision === 'string' && <div><span>Ревизия маршрута</span><strong>{received.data.route_revision}</strong></div>}
        </div>
        {disposition && <p className="qc-fact-tech"><strong>Заключение технолога:</strong> {disposition.description ?? 'Статус передан без текста заключения'}</p>}
        {evidence.missing.length > 0 && <div className="qc-fact-missing"><strong>Чего не хватает для окончательного вывода</strong><ul>{evidence.missing.map(value => <li key={value}>{value}</li>)}</ul><p>{kdSpec ? 'Для подтверждения линейного размера нужен замер поверенным прибором. Для оценки внешнего признака сначала нужен осмотр зоны.' : 'Размер и допуск нужны для размерного соответствия. Для оценки внешнего признака сначала нужен осмотр зоны.'}</p></div>}</details>
      </article>
    </div>
  </section>;
}

function DecisionPanel({ record, source, hashState }: { record: InspectionCase; source: Case; hashState?: HashState }) {
  const [choice, setChoice] = useState<WorkflowAction | null>(null);
  const [pendingChoice, setPendingChoice] = useState<WorkflowAction | null>(null);
  const [responsibilityAccepted, setResponsibilityAccepted] = useState(false);
  const warningDialog = useRef<HTMLDialogElement>(null);
  const warningTrigger = useRef<HTMLElement | null>(null);
  const missingAfter = !record.visualEvidence.hasImage;
  useEffect(() => {
    if (pendingChoice) warningDialog.current?.showModal();
    else warningDialog.current?.close();
  }, [pendingChoice]);
  const [basis, setBasis] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [comment, setComment] = useState('');
  const [measurement, setMeasurement] = useState('');
  const [instrument, setInstrument] = useState('');
  const [calibrated, setCalibrated] = useState(false);
  const [message, setMessage] = useState('');
  const hasMaster = record.iteration > 1 && ['REWORK_VERIFICATION', 'UNDER_REVIEW'].includes(record.status) && !!record.masterReworkReport;
  const reworkCompleted = hasMaster && record.masterReworkReport?.actionType === 'rework_completed';
  const own = eventsFor(record.itemId);
  const scrapReady = record.itemId === 'ITEM-015' && source.type !== 'UNASSESSABLE' && own.filter(event => event.event_type === 'quality_decision').at(-1)?.data.disposition === 'quarantine' && own.some(event => event.event_type === 'technical_disposition' && event.data.disposition === 'rework_not_allowed');
  const visualAllowed = record.visualEvidence.hasImage && record.visualEvidence.quality === 'OPTIMAL' && !!hashState && ['valid', 'unavailable'].includes(hashState);
  const controllerCheck = latestControllerCheck(source, own);
  const manualFinding = source.observations.at(-1)?.data.method === 'manual_verification' && source.observations.at(-1)?.data.inspection_result === 'signs_detected' && !own.some(event => event.event_type === 'master_action' && Date.parse(event.occurred_at) > Date.parse(source.observations.at(-1)!.occurred_at));
  const confirmAllowed = source.type !== 'UNASSESSABLE' && (missingAfter || visualAllowed || controllerCheck?.data.inspection_result === 'signs_detected' || manualFinding);
  const rejectAllowed = visualAllowed || controllerCheck?.data.inspection_result === 'no_signs_detected';
  const caseMeasurement = controllerEvidenceFrom(source, own, visualAllowed).measurement;
  const measuredValue = caseMeasurement?.data.measured_value;
  const lowerLimit = caseMeasurement?.data.lower_limit;
  const upperLimit = caseMeasurement?.data.upper_limit;
  const measuredOutsideLimit = typeof measuredValue === 'number' && (typeof lowerLimit === 'number' && measuredValue < lowerLimit || typeof upperLimit === 'number' && measuredValue > upperLimit);
  const requireMeasurement = hasMaster && record.itemId === 'ITEM-013';
  const observedLength = source.observations.at(-1)?.data.defects?.[0]?.length_mm;
  const kdMaximum = source.observations.at(-1)?.data.kd_spec?.max_allowable_defect_length_mm;
  const withinKd = (typeof measuredValue === 'number' && (typeof lowerLimit === 'number' || typeof upperLimit === 'number') && !measuredOutsideLimit)
    || (typeof observedLength === 'number' && typeof kdMaximum === 'number' && observedLength <= kdMaximum);
  const recommendedF3Action: WorkflowAction = withinKd && record.itemId === 'ITEM-019' ? 'accepted_within_spec' : 'reject';
  const f3Action: WorkflowAction = reworkCompleted ? 'scrap' : recommendedF3Action;
  const options: { key: WorkflowAction; label: string; shortcut: string; tone: string; disabled?: boolean; title?: string; recommended?: boolean }[] = [
    ...(reworkCompleted ? [{ key: 'release' as WorkflowAction, label: 'Дефект устранён · Выпустить', shortcut: 'F1', tone: 'green', disabled: !rejectAllowed, title: !rejectAllowed ? 'Нужен пригодный кадр результата или очный осмотр мастера' : undefined }] : []),
    { key: reworkCompleted ? 'recheck_fail' : 'confirm', label: reworkCompleted ? 'Дефект остался · Повторная доработка' : 'Подтвердить дефект · На доработку', shortcut: 'F2', tone: 'amber', disabled: !reworkCompleted && !confirmAllowed, title: !reworkCompleted && !confirmAllowed ? 'Нужно подтверждение признака по кадру или очной проверке' : undefined },
    { key: f3Action, label: reworkCompleted ? 'Неустранимый дефект · Списать' : 'Отклонить (Ложный сигнал AI / В пределах КД)', shortcut: 'F3', tone: reworkCompleted ? 'neutral' : withinKd ? 'green' : 'neutral', disabled: reworkCompleted ? !eventsFor(record.itemId).some(event => event.event_type === 'technical_disposition' && event.data.disposition === 'rework_not_allowed') : !rejectAllowed && !withinKd, recommended: !reworkCompleted && withinKd, title: reworkCompleted ? 'Нужно заключение технолога о невозможности доработки' : !rejectAllowed && !withinKd ? 'Нужно подтверждение отсутствия признака по кадру или очной проверке' : undefined },
    { key: 'additional', label: 'Назначить доппроверку (Очный осмотр)', shortcut: 'F4', tone: 'blue' },
  ];
  const settled = !scrapReady && (['FALSE_POSITIVE', 'ACCEPTED_WITHIN_SPEC', 'ACCEPTED_AFTER_REWORK'].includes(record.status) || (!hasMaster && source.decisions.length > 0 && record.status !== 'NEW_SIGNAL'));
  const basisOptions = choice === 'accepted_within_spec' ? ['След был до операции; оценка длины в пределах учебной КД'] : choice === 'additional' ? [
    'Недостаточно данных: нужен очный контроль изделия',
    'Недостаточно данных: нужен инструментальный замер',
    'Качество наблюдения ограничено: нужна повторная съёмка',
  ] : choice === 'release' ? [controllerCheck?.data.inspection_result === 'no_signs_detected' ? 'Очный контроль после доработки: признак устранён' : 'Контроль после доработки: признак устранён']
    : choice === 'scrap' ? ['Заключение технолога: доработка невозможна']
      : choice === 'reject' ? [
        ...(withinKd ? ['КД: параметр в пределах допуска; сигнал не является браком'] : []),
        ...(controllerCheck?.data.inspection_result === 'no_signs_detected' ? ['Очная проверка контролёра: признак не обнаружен'] : []),
        ...(visualAllowed ? ['Визуальный осмотр связанного кадра: признак не подтверждён'] : []),
      ] : [
        ...(controllerCheck?.data.inspection_result === 'signs_detected' || manualFinding ? ['Очная проверка контролёра: признак обнаружен'] : []),
        ...(visualAllowed ? ['Визуальный осмотр связанного кадра: признак обнаружен'] : []),
        ...(missingAfter && responsibilityAccepted ? ['Телеметрия и сопоставление с КД: личная ответственность контролёра'] : []),
        ...(measuredOutsideLimit ? ['Инструментальный замер: выход за зарегистрированный допуск'] : []),
      ];
  const selectChoice = (next: WorkflowAction) => {
    if (missingAfter && (next === 'confirm' || next === 'confirm_hold')) {
      warningTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setResponsibilityAccepted(false); setChoice(null); setPendingChoice(next); return;
    }
    setResponsibilityAccepted(false);
    setChoice(next); setBasis(''); setMessage('');
    if (next === 'additional') {
      setBasis('Недостаточно данных: нужен очный контроль изделия');
      setComment(decisionReadiness(source, own, visualAllowed).request);
    }
  };
  useEffect(() => { setChoice(null); setPendingChoice(null); setResponsibilityAccepted(false); setBasis(''); setDocumentId(''); setComment(''); setMessage(''); setMeasurement(''); setInstrument(''); setCalibrated(false); }, [record.id, record.iteration]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (isFormTarget(event.target) || settled || pendingChoice) return;
      const option = options.find(row => row.shortcut === event.key.toUpperCase());
      if (option) { event.preventDefault(); if (!option.disabled) selectChoice(option.key); }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [options, settled, pendingChoice]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (missingAfter && (choice === 'confirm' || choice === 'confirm_hold') && !responsibilityAccepted) return;
    if (!choice || !basis || (choice !== 'additional' && !documentId.trim()) || comment.trim().length < 5) return;
    if (!basisOptions.includes(basis)) { setMessage('Основание больше не подтверждается доступными фактами. Выберите его заново.'); return; }
    if (options.find(option => option.key === choice)?.disabled) { setMessage('Основание изменилось. Выберите доступное решение заново.'); return; }
    try {
      await securePerformAction(record.itemId, 'controller', choice, `${basis}. Источник: ${source.observations.at(-1)!.event_id}. ${documentId.trim() ? documentId.trim() + '. ' : ''}${comment.trim()}`, true, record.id,
        requireMeasurement && choice === 'release' ? { value: Number(measurement), instrumentId: instrument, calibrationConfirmed: calibrated } : undefined,
        missingAfter && responsibilityAccepted ? { observationEventId: source.observations.at(-1)!.event_id, acknowledged: true } : undefined);
      setMessage('Решение записано в историю. Очередь и задания обновлены.');
      setChoice(null); setResponsibilityAccepted(false); setComment('');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось записать решение'); }
  };
  return <section className="qc-decision" aria-label="Решение контролёра">
    <h2 className="qc-tier-title">Решение контролёра</h2>
    <dialog ref={warningDialog} className="qc-responsibility-dialog" aria-labelledby="qc-warning-title" aria-describedby="qc-warning-text" onCancel={() => { setPendingChoice(null); setResponsibilityAccepted(false); }} onClose={() => warningTrigger.current?.focus()}>
      <Icon name="alert" size={28}/><h2 id="qc-warning-title">Подтверждение без фотоматериала</h2>
      <p id="qc-warning-text">Внимание: фотоматериал отсутствует. Подтверждение брака выполняется под личную ответственность контролёра на основе данных телеметрии и превышения допуска КД.</p>
      <p className="qc-fact-caution">Проверьте фактическое сопоставление с КД и укажите документ и основание решения. Принятие ответственности сохраняется в истории.</p>
      <div><button type="button" autoFocus onClick={() => { setPendingChoice(null); setResponsibilityAccepted(false); }}>Отмена</button><button type="button" className="qc-accept-responsibility" onClick={() => { setChoice(pendingChoice); setBasis(''); setMessage(''); setResponsibilityAccepted(true); setPendingChoice(null); }}>Принимаю ответственность</button></div>
    </dialog>
    {record.status === 'SENT_TO_REWORK' ? <p className="qc-work-status" role="status"><Icon name="clock" size={20}/><span><strong>В работе у Мастера</strong>Решение F2 записано. После фиксации исправления заявка перейдёт в «Повторный контроль».</span></p> : settled && <p className="qc-decision-note">Решение уже принято. История доступна в досье; блок действий оставлен видимым для единого рабочего шаблона.</p>}
      {!settled && !visualAllowed && <p className="qc-decision-note">{controllerCheck || manualFinding ? 'Очная проверка записана. Выберите решение, соответствующее её результату.' : missingAfter ? 'Рекомендуется очный осмотр. Подтверждение без фото требует принятия личной ответственности и документированного основания.' : 'Подтверждение и отклонение требуют осмотра. Доппроверку можно назначить сейчас — тип, зона и основание попадут в задание.'}</p>}
      {!settled && withinKd && <p className="qc-kd-recommendation" role="status"><Icon name="check" size={17}/>Параметры в пределах допуска КД · рекомендуем F3</p>}
      <div className={`qc-actions ${reworkCompleted ? 'qc-actions-four' : 'qc-actions-three'}`}>{options.map(option => <button key={option.key} type="button" className={[option.tone, option.recommended && 'recommended', choice === option.key && 'selected', missingAfter && option.key === 'additional' && 'qc-primary-action'].filter(Boolean).join(' ')} disabled={settled || option.disabled} title={option.title} onClick={() => selectChoice(option.key)}><kbd>{option.shortcut}</kbd><span>{option.label}</span>{option.recommended && <em>Рекомендуется</em>}</button>)}</div>
      {choice && <div className="qc-decision-fields">
        <label><span className="sr-only">Основание решения (по фактам)</span><select aria-label="Основание решения (по фактам)" required disabled={!choice} value={basis} onChange={event => setBasis(event.target.value)}><option value="">Выберите основание решения</option>{basisOptions.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Что проверить / основание вывода<textarea aria-label="Комментарий" required minLength={5} value={comment} onChange={event => setComment(event.target.value)} placeholder="Комментарий к решению…"/></label>
        {record.technologistFinding?.description && <button className="qc-recommendation" type="button" onClick={() => setComment(record.technologistFinding?.description ?? '')}>Вставить заключение технолога</button>}
      </div>}
      {choice && <form className="qc-decision-form" onSubmit={submit}>
        <strong>Запись решения: {options.find(option => option.key === choice)?.label}</strong>
        <label>{choice === 'additional' ? 'Документ / инструкция (если есть)' : 'Документ / акт осмотра и редакция'}<input required={choice !== 'additional'} value={documentId} onChange={event => setDocumentId(event.target.value)}/></label>
        {requireMeasurement && choice === 'release' && <div className="cockpit-measurement"><strong>Фактический ручной замер · обязательный</strong><span>Для учебного маршрута ITEM-013: толщина стенки ≥ 5,0 мм. Внесите результат измерения; кадр CV его не заменяет.</span><label>Измерено, мм<input type="number" step="0.01" min="5" required value={measurement} onChange={event => setMeasurement(event.target.value)}/></label><label>Идентификатор прибора<input required value={instrument} onChange={event => setInstrument(event.target.value)}/></label><label className="cockpit-inline-check"><input type="checkbox" checked={calibrated} onChange={event => setCalibrated(event.target.checked)}/>Поверка прибора подтверждена контролёром</label></div>}
        <label>Контролёр<input value={currentSecurityUser()?.id ?? ''} readOnly/></label>
        <button className="qc-submit" type="submit" disabled={!basis || (choice !== 'additional' && !documentId.trim()) || comment.trim().length < 5 || (requireMeasurement && choice === 'release' && (!measurement || !instrument.trim() || !calibrated))}>Записать решение</button>
      </form>}
    {message && <p className="qc-decision-message" role="status">{message}</p>}
  </section>;
}

function DossierDrawer({ record, source, observation, machine, missingFields, onClose, openPassport, closeRef }: {
  record: InspectionCase;
  source: Case;
  observation: QualityEvent;
  machine?: QualityEvent;
  missingFields: string[];
  onClose: () => void;
  openPassport: (item: string) => void;
  closeRef: RefObject<HTMLButtonElement | null>;
}) {
  const meta = record.visualEvidence.cameraMeta;
  const report = record.masterReworkReport;
  const finding = record.technologistFinding;
  const received = eventsFor(record.itemId).find(event => event.event_type === 'item_received');
  const traveler = typeof received?.data.traveler_id === 'string' ? received.data.traveler_id : record.routeSheet;
  return <div className="qc-drawer-layer">
    <button className="qc-drawer-backdrop" aria-label="Закрыть досье" onClick={onClose}/>
    <aside className="qc-drawer" role="dialog" aria-modal="true" aria-label="Досье и телеметрия">
      <header><div><span>Паспорт случая · {record.id}</span><h2>Досье и телеметрия</h2></div><button ref={closeRef} aria-label="Закрыть досье" onClick={onClose}><Icon name="close" size={20}/></button></header>
      <div className="qc-drawer-content">
        <section><h3>Идентификация</h3><dl>
          <div><dt>Изделие</dt><dd className="mono">{record.itemId}</dd></div>
          <div><dt>Заказ</dt><dd className="mono">{record.workOrder}</dd></div>
          <div><dt>Партия</dt><dd>{record.supplierLotId ?? record.batchId ?? 'Нет данных'}</dd></div>
          <div><dt>Маршрутный лист</dt><dd>{traveler ?? 'Нет данных'}</dd></div>
          <div><dt>Оператор</dt><dd>{record.machineContext.operatorId ?? 'Нет данных'}</dd></div>
          <div><dt>Станок</dt><dd>{record.machineContext.machineId ?? 'Нет данных'}</dd></div>
          <div><dt>Операция</dt><dd>{stationNames[record.machineContext.stationId] ?? record.machineContext.stationId}</dd></div>
          <div><dt>Запуск</dt><dd className="mono">{observation.operation_run_id ?? 'Нет данных'}</dd></div>
        </dl></section>
        <section><h3>Расследование технолога</h3>
          {finding ? <><p>{finding.investigationStatus === 'COMPLETED' ? 'Заключение записано' : 'Причина уточняется'}</p><p>{finding.description ?? 'Причина не указана'}</p><p>Доработка: {finding.reworkPermitted == null ? 'решение не записано' : finding.reworkPermitted ? 'разрешена' : 'запрещена'}</p></> : <p>Расследование не открыто. Дефект рассматривает ОТК.</p>}
        </section>
        {report && <section><h3>Отчёт мастера</h3><p>{report.masterName} · {time(report.completedAt)}</p><p>{report.actionDescription}</p>
          {report.manualMeasurement && <dl><div><dt>Замер</dt><dd>{report.manualMeasurement.measuredValue} мм</dd></div><div><dt>Инструмент</dt><dd>{report.manualMeasurement.toolName ?? 'Нет данных'}</dd></div></dl>}
        </section>}
        <section><h3>Техническая инспекция</h3><dl>
          <div><dt>CV</dt><dd>{defectNames[source.type] ?? source.type} · {record.visualEvidence.aiConfidence == null ? 'уверенность не передана' : record.visualEvidence.aiConfidence + '%'}</dd></div>
          <div><dt>Профиль калибровки</dt><dd>{meta.calibrationProfile ?? 'Нет данных'}</dd></div>
          <div><dt>Станок</dt><dd>{machine?.data.state ?? 'Нет данных'}</dd></div>
          <div><dt>Пиковая нагрузка</dt><dd>{machine?.data.spindle_load_peak_pct == null ? 'Нет данных' : machine.data.spindle_load_peak_pct + '%'}</dd></div>
        </dl>
          <strong className="qc-hash-label">Полный SHA-256 кадра</strong><code className="qc-full-hash">{meta.imageHash ?? 'Хеш не передан'}</code>
          {missingFields.length > 0 && <details><summary>Отсутствующие данные · {missingFields.length}</summary><ul>{missingFields.map(value => <li key={value}>{value}</li>)}</ul></details>}
          <details><summary>Сырой JSON события {observation.event_id}</summary><pre>{JSON.stringify(observation, null, 2)}</pre></details>
        </section>
        <section><h3>История случая</h3>{[...source.observations, ...source.decisions, ...eventsFor(record.itemId).filter(event => event.event_type === 'controller_check' && event.data.case_id === source.id)].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at)).map(event => <p key={event.event_id}><span className="mono">{time(event.occurred_at)}</span> · {eventNames[event.event_type]}: {describeEvent(event)}</p>)}</section>
        <button className="qc-passport-link" onClick={() => { onClose(); openPassport(record.itemId); }}>Открыть полный паспорт изделия <Icon name="arrow" size={16}/></button>
      </div>
    </aside>
  </div>;
}

/** Full-screen controller workbench with persistent queue, evidence and decision context. */
export function ControllerCockpit({ scope, caseId, openCase, openPassport, onExit }: { scope: Scope; caseId?: string; openCase: (item: string, caseId: string) => void; openPassport: (item: string) => void; onExit: () => void }) {
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [criticality, setCriticality] = useState('all');
  const [query, setQuery] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [queueCollapsed, setQueueCollapsed] = useState(false);
  const drawerTrigger = useRef<HTMLButtonElement>(null);
  const drawerClose = useRef<HTMLButtonElement>(null);
  const [hashResult, setHashResult] = useState<{ key: string; state: HashState }>({ key: '', state: 'unavailable' });
  const timelineEnd = Math.max(...events.map(event => Date.parse(event.occurred_at)));
  const source = cases.filter(row => row.observations.some(event => inScope(event, scope)));
  const projected = source.map(row => ({ source: row, view: inspectionCaseFrom(row) }));
  const filtered = projected.filter(({ source: row, view }) => {
    const urgent = view.urgency === 'CRITICAL';
    const uncertain = view.visualEvidence.quality !== 'OPTIMAL' || (view.visualEvidence.aiConfidence ?? 100) < 60;
    const inMasterRework = filter === 'master_rework' ? view.status === 'SENT_TO_REWORK' : queueStatus(row);
    return inMasterRework && (filter === 'all' || filter === 'critical' && urgent || filter === 'rework' && view.status === 'REWORK_VERIFICATION' || filter === 'master_rework' && view.status === 'SENT_TO_REWORK' || filter === 'unassessable' && uncertain)
      && (criticality === 'all' || view.urgency === criticality)
      && (!query || `${view.id} ${queueItemLabel(row, source)} ${view.itemId} ${view.partName} ${defectNames[row.type] ?? row.type}`.toLowerCase().includes(query.toLowerCase()));
  }).sort((a, b) => b.source.priority - a.source.priority || a.view.createdAt.localeCompare(b.view.createdAt));
  const selected = filtered.find(row => row.source.id === caseId) ?? filtered.find(row => row.view.itemId === 'ITEM-013') ?? filtered[0];
  const view = selected?.view;
  const hasAnyPhotos = Boolean(view?.visualEvidence.beforeImageUrl || view?.visualEvidence.currentImageUrl);
  const imageUrl = view?.visualEvidence.currentImageUrl;
  const expectedHash = view?.visualEvidence.cameraMeta.imageHash;
  const imageKey = `${imageUrl ?? ''}:${expectedHash ?? ''}`;
  const hashState: HashState = imageUrl ? hashResult.key === imageKey ? hashResult.state : 'checking' : 'unavailable';
  useEffect(() => {
    let active = true;
    if (!imageUrl) return;
    const verify = async () => {
      const state = await verifyImage(imageUrl, expectedHash);
      if (active) setHashResult({ key: imageKey, state });
    };
    void verify();
    return () => { active = false; };
  }, [imageUrl, expectedHash, imageKey]);
  const sourceCase = selected?.source;
  useEffect(() => {
    const list = document.querySelector('.qc-queue-list');
    const active = list?.querySelector('.qc-queue-item.active');
    if (list && active) list.scrollTop += active.getBoundingClientRect().top - list.getBoundingClientRect().top - 10;
  }, [sourceCase?.id]);
  const product = view ? items.find(row => row.id === view.itemId) : undefined;
  const data = sourceCase && product ? controllerCaseData(sourceCase, product, mediaIndex) : undefined;
  const own = view ? eventsFor(view.itemId) : [];
  const machine = sourceCase ? controllerEvidenceFrom(sourceCase, own, hasAnyPhotos).machine : undefined;
  const observation = data?.observation;
  const closeDrawer = () => { setDrawerOpen(false); drawerTrigger.current?.focus(); };
  useEffect(() => { if (drawerOpen) drawerClose.current?.focus(); }, [drawerOpen]);
  useEffect(() => { setDrawerOpen(false); }, [view?.id]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drawerOpen) { event.preventDefault(); closeDrawer(); }
      if (event.key.toLowerCase() === 'd' && !isFormTarget(event.target)) { event.preventDefault(); setDrawerOpen(value => !value); }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [drawerOpen]);
  const counts = {
    critical: projected.filter(row => queueStatus(row.source) && row.view.urgency === 'CRITICAL').length,
    rework: projected.filter(row => row.view.status === 'REWORK_VERIFICATION').length,
    master_rework: projected.filter(row => row.view.status === 'SENT_TO_REWORK').length,
    unassessable: projected.filter(row => queueStatus(row.source) && (row.view.visualEvidence.quality !== 'OPTIMAL' || (row.view.visualEvidence.aiConfidence ?? 100) < 60)).length,
    all: projected.filter(row => queueStatus(row.source)).length,
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || isFormTarget(event.target)) return;
      const index = filtered.findIndex(row => row.source.id === sourceCase?.id);
      const next = filtered[index + 1] ?? filtered[0];
      if (next && next.source.id !== sourceCase?.id) { event.preventDefault(); openCase(next.view.itemId, next.source.id); }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [filtered, openCase, sourceCase?.id]);
  return <div className="controller-cockpit qc-cockpit">
    <header className="qc-header">
      <div className="qc-identity"><strong className="mono">{view?.itemId ?? 'Выберите изделие'}</strong>{view && <><span>·</span><strong className="mono">{view.workOrder}</strong><span className="qc-part-name">({view.partName.replace(/^Условный\s+/, '')})</span></>}</div>
      <div className="qc-header-right">
        <span className={['qc-hash-status', hashState].join(' ')}><Icon name={hashState === 'valid' ? 'check' : 'help'} size={15}/>{!hasAnyPhotos ? 'Кадр не поступил' : hashState === 'valid' ? 'Хеш кадра валиден' : hashState === 'checking' ? 'Проверка хеша' : hashState === 'invalid' ? 'Хеш не совпал' : hashState === 'load_failed' ? 'Файл кадра недоступен' : 'Хеш не передан'}</span>
        <button ref={drawerTrigger} className="qc-drawer-trigger" onClick={() => setDrawerOpen(true)} disabled={!view}><Icon name="help" size={17}/>Досье и телеметрия <kbd>D</kbd></button>
        <button type="button" className="qc-exit" onClick={onExit} aria-label="Закрыть контроль качества" title="Закрыть контроль качества"><Icon name="close" size={17}/>Закрыть</button>
      </div>
    </header>
    <div className={['qc-layout', queueCollapsed && 'queue-collapsed'].filter(Boolean).join(' ')}>
      <aside className={['qc-queue', queueCollapsed && 'is-collapsed'].filter(Boolean).join(' ')} aria-label="Очередь сигналов ОТК">
        <div className="qc-queue-heading"><h2>Очередь ОТК</h2><strong aria-label={`${filtered.length} заявок в выбранной вкладке`}>{filtered.length}</strong><span className="qc-queue-collapsed-label">Очередь ({filtered.length})</span><button type="button" className="qc-queue-toggle" onClick={() => setQueueCollapsed(value => !value)} aria-label={queueCollapsed ? 'Развернуть очередь' : 'Свернуть очередь'} title={queueCollapsed ? 'Развернуть очередь' : 'Свернуть очередь'}><span aria-hidden="true">{queueCollapsed ? '▶' : '◀'}</span><span className="sr-only">{queueCollapsed ? 'Развернуть' : 'Свернуть'}</span></button></div>
        <div className="qc-queue-filters">{([['all','Все'], ['critical','Критичные'], ['master_rework','В работе у Мастера'], ['rework','Повторный контроль'], ['unassessable','Нужна проверка']] as const).map(([key, label]) => <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}<span>{counts[key]}</span></button>)}</div>
        <div className="qc-queue-tools"><input aria-label="Поиск заявки" placeholder="ID или дефект…" value={query} onChange={event => setQuery(event.target.value)}/><select aria-label="Критичность" value={criticality} onChange={event => setCriticality(event.target.value)}><option value="all">Любой приоритет</option><option value="CRITICAL">Критический</option><option value="HIGH">Высокий</option><option value="MEDIUM">Средний</option><option value="LOW">Низкий</option></select></div>
        <div className="qc-queue-list">{filtered.length ? filtered.map(({ source: row, view: item }) => <button key={row.id} className={['qc-queue-item', `priority-${item.urgency.toLowerCase()}`, sourceCase?.id === row.id && 'active'].filter(Boolean).join(' ')} onClick={() => openCase(item.itemId, row.id)} aria-current={sourceCase?.id === row.id ? 'true' : undefined}>
          <span className="qc-queue-primary"><strong className="mono">{queueItemLabel(row, source)}</strong><span>• {defectNames[row.type] ?? row.type}{item.visualEvidence.aiConfidence == null ? '' : ' (' + item.visualEvidence.aiConfidence + '%)'}</span></span>
          <span className="qc-queue-secondary"><span>{item.status === 'SENT_TO_REWORK' ? 'В работе у Мастера' : item.status === 'REWORK_VERIFICATION' ? 'Доработка завершена мастером' : compareAge(item.createdAt, timelineEnd)}</span><span className={item.visualEvidence.hasImage ? 'has-image' : item.visualEvidence.after.absenceReason === 'CLASSIFIED_RESTRICTED' ? 'qc-tag-restricted' : 'qc-tag-lost'}>{item.visualEvidence.hasImage ? 'Есть снимок' : item.visualEvidence.after.absenceReason === 'CLASSIFIED_RESTRICTED' ? '[Засекречено]' : item.visualEvidence.after.absenceReason === 'LOST_IN_TRANSIT' ? '[Сбой кадра]' : '[Кадр недоступен]'}</span></span>
        </button>) : <p className="qc-empty-queue">В этом фильтре нет открытых заявок.</p>}</div>
      </aside>
      {view && sourceCase && data ? <main key={view.id} className={['qc-workbench', !hasAnyPhotos && 'no-photos'].filter(Boolean).join(' ')}>
        <div className="qc-review-content">
          <details className="qc-photo-section" key={'photo-' + view.id} open><summary>Сравнение до и после операции<span>Свернуть / развернуть</span></summary><div className="qc-upper"><EvidenceViewer key={view.id} record={view} hashState={hashState}/></div></details>
          <ControllerFacts key={'facts-' + view.id} record={view} source={sourceCase} history={own} caseData={data} openCase={openCase} hashState={hashState}/>
        </div>
        <DecisionPanel key={view.id + '-' + view.iteration} record={view} source={sourceCase} hashState={hashState}/>
      </main> : <div className="qc-no-selection">Выберите заявку в очереди</div>}
    </div>
    {drawerOpen && view && sourceCase && observation && <DossierDrawer record={view} source={sourceCase} observation={observation} machine={machine} missingFields={data?.missing ?? []} onClose={closeDrawer} openPassport={openPassport} closeRef={drawerClose}/>}
  </div>;
}
