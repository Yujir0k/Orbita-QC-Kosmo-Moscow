import { useEffect, useState, type FormEvent } from 'react';
import { cases, defectNames, describeEvent, events, eventsFor, inScope, items, mediaIndex, performAction, stationNames, time, type Case, type Scope, type WorkflowAction } from './domain';
import { controllerCaseData } from './controller-case';
import { inspectionCaseFrom, type InspectionCase } from './inspection-case';
import { Icon } from './ui';

type QueueFilter = 'critical' | 'rework' | 'unassessable' | 'all';
type ViewerMode = 'split' | 'side';
type HashState = 'checking' | 'valid' | 'invalid' | 'unavailable';

const statusText: Record<InspectionCase['status'], string> = {
  NEW_SIGNAL: 'Новый сигнал', UNDER_REVIEW: 'На рассмотрении', SENT_TO_REWORK: 'Передано мастеру',
  REWORK_VERIFICATION: 'Повторный контроль', CONFIRMED_DEFECT: 'Дефект подтверждён',
  FALSE_POSITIVE: 'Ложное срабатывание', ACCEPTED_AFTER_REWORK: 'Принято после доработки',
};
const missing = '⚠ Не заполнено';
const isFormTarget = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"]');

/** Verify the delivered file against the dataset digest; this does not verify a digital signature. */
async function verifyImageHash(url: string, expected: string): Promise<HashState> {
  try {
    const response = await fetch(url);
    if (!response.ok) return 'invalid';
    const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
    const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return actual === expected.toLowerCase() ? 'valid' : 'invalid';
  } catch { return 'invalid'; }
}

function compareAge(createdAt: string, timelineEnd: number): string {
  const hours = Math.max(0, Math.floor((timelineEnd - Date.parse(createdAt)) / 3600000));
  return hours >= 24 ? `${Math.floor(hours / 24)} д в ленте` : `${hours} ч в ленте`;
}

/** Whether a defect case currently requires a controller decision. */
export function queueStatus(record: Case): boolean {
  const caseData = inspectionCaseFrom(record);
  const own = eventsFor(record.item);
  const lastDecision = own.filter(event => event.event_type === 'quality_decision').at(-1);
  const scrapReady = record.item === 'ITEM-015' && record.type !== 'UNASSESSABLE' && lastDecision?.data.disposition === 'quarantine' && own.some(event => event.event_type === 'technical_disposition' && event.data.disposition === 'rework_not_allowed');
  if (scrapReady) return true;
  return caseData.status === 'NEW_SIGNAL' || caseData.status === 'REWORK_VERIFICATION' || caseData.status === 'UNDER_REVIEW' && caseData.iteration > 1 && caseData.masterReworkReport?.actionType === 'inspection_support';
}

function Frame({ url, label, emptyText, contrast, zoom, grid, bbox }: { url?: string; label: string; emptyText: string; contrast: boolean; zoom: boolean; grid: boolean; bbox?: [number, number, number, number] }) {
  return <div className={`cockpit-frame ${!url ? 'is-empty' : ''} ${contrast ? 'high-contrast' : ''} ${zoom ? 'zoomed' : ''} ${grid ? 'with-grid' : ''}`}>
    <span className="frame-tag">{label}</span>
    {url ? <><img src={url} alt={label}/>{bbox && <span className="frame-highlight" style={{ left: `${bbox[0]}%`, top: `${bbox[1]}%`, width: `${bbox[2]}%`, height: `${bbox[3]}%` }} aria-label="Рамка дефекта от CV"/>}</> : <div className="frame-empty"><Icon name="control" size={28}/><strong>Кадр не передан</strong><span>{emptyText}</span></div>}
  </div>;
}

function EvidenceViewer({ record, hashState }: { record: InspectionCase; hashState: HashState }) {
  const [mode, setMode] = useState<ViewerMode>('side');
  const [split, setSplit] = useState(50);
  const [zoom, setZoom] = useState(false);
  const [contrast, setContrast] = useState(false);
  const [grid, setGrid] = useState(false);
  const [bboxVisible, setBboxVisible] = useState(true);
  const evidence = record.visualEvidence;
  const hash = evidence.cameraMeta.imageHash;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'z' && !isFormTarget(event.target)) { event.preventDefault(); setZoom(value => !value); }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  const hasPair = !!evidence.beforeImageUrl && !!evidence.currentImageUrl;
  const beforeLabel = record.iteration > 1 ? 'ДО · Исходный сигнал CV' : 'ДО · Входной контроль';
  const afterLabel = record.masterReworkReport?.actionType === 'rework_completed' ? 'СЕЙЧАС · После доработки' : record.iteration > 1 ? 'СЕЙЧАС · Очная проверка' : record.itemId === 'ITEM-013' ? 'СЕЙЧАС · Зона фрезерования' : `СЕЙЧАС · ${stationNames[record.machineContext.stationId] ?? 'Наблюдение CV'}`;
  return <section className="cockpit-panel cockpit-evidence" aria-label="Визуальная экспертиза">
    <div className="cockpit-section-head"><div><span className="cockpit-kicker">02 / ДОКАЗАТЕЛЬНАЯ БАЗА</span><h2>Визуальная экспертиза</h2></div><span className={`cockpit-integrity ${hashState}`}>{hashState === 'valid' ? 'SHA-256 файла совпал' : hashState === 'invalid' ? 'НАРУШЕНА ЦЕЛОСТНОСТЬ КАДРА' : hashState === 'checking' ? 'Проверка SHA-256…' : 'Хеш кадра не передан'}</span></div>
    {hashState === 'invalid' && <div className="cockpit-alert danger" role="alert">Файл кадра не совпадает с заявленным SHA-256 или недоступен. Решение по этому изображению заблокировано.</div>}
    {evidence.quality !== 'OPTIMAL' && <div className="cockpit-alert amber" role="alert">{evidence.quality === 'NO_IMAGE' ? 'Исходный кадр отсутствует.' : 'Качество кадра недостаточно для визуальной оценки.'} {evidence.missingImageReason && <span className="mono">Причина: {evidence.missingImageReason}. </span>}Автоматическая приемка и браковка по кадру недоступны; нужен очный контроль или инструментальный замер.</div>}
    <div className="viewer-modes"><button className={mode === 'side' ? 'active' : ''} onClick={() => setMode('side')}>Рядом</button><button className={mode === 'split' ? 'active' : ''} onClick={() => setMode('split')} disabled={!hasPair}>Слайдер</button><span>{hasPair ? 'Связанные кадры одной детали' : 'Для сравнения второй кадр не поступил'}</span></div>
    {mode === 'split' && hasPair ? <div className="cockpit-split">
      <Frame url={evidence.currentImageUrl} label={afterLabel} emptyText="" contrast={contrast} zoom={zoom} grid={grid} bbox={record.iteration === 1 && bboxVisible ? evidence.defectBBox : undefined}/>
      <div className="cockpit-split-before" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}><Frame url={evidence.beforeImageUrl} label={beforeLabel} emptyText="" contrast={contrast} zoom={zoom} grid={grid}/></div>
      <input type="range" min="0" max="100" value={split} aria-label="Положение разделителя снимков" onChange={event => setSplit(Number(event.target.value))}/>
    </div> : <div className={`cockpit-frame-pair ${!evidence.beforeImageUrl ? 'before-missing' : ''} ${!evidence.currentImageUrl ? 'no-current' : ''}`}><Frame url={evidence.beforeImageUrl} label={beforeLabel} emptyText="Кадр предыдущего этапа отсутствует в пакете данных" contrast={contrast} zoom={zoom} grid={grid} bbox={record.iteration > 1 && bboxVisible ? evidence.defectBBox : undefined}/><Frame url={evidence.currentImageUrl} label={afterLabel} emptyText="Запросите очный контроль" contrast={contrast} zoom={zoom} grid={grid} bbox={record.iteration === 1 && bboxVisible ? evidence.defectBBox : undefined}/></div>}
    <div className="viewer-tools"><button className={zoom ? 'active' : ''} onClick={() => setZoom(value => !value)}><Icon name="search" size={16}/>{zoom ? '100%' : 'Зум · Z'}</button><button className={contrast ? 'active' : ''} onClick={() => setContrast(value => !value)}><Icon name="control" size={16}/>Контраст</button><button className={grid ? 'active' : ''} onClick={() => setGrid(value => !value)}><Icon name="layer" size={16}/>Сетка</button><button className={bboxVisible ? 'active' : ''} onClick={() => setBboxVisible(value => !value)} disabled={!evidence.defectBBox}>Рамка CV</button><button disabled title="Слой маски подключается после появления данных CV">Маска CV</button></div>
    <dl className="cockpit-camera"><div><dt>Камера / ракурс</dt><dd>{evidence.cameraMeta.cameraId ?? missing}<small>{evidence.cameraMeta.viewAngle ?? missing}</small></dd></div><div><dt>Свет</dt><dd>{evidence.cameraMeta.lightingProfile ?? missing}</dd></div><div><dt>Калибровка</dt><dd>{evidence.cameraMeta.calibrationProfile ?? missing}</dd></div><div><dt>SHA-256 файла</dt><dd className="mono" title={hash ?? undefined}>{hash ?? missing}</dd></div></dl>
    <p className="cockpit-fineprint">Хеш проверяет содержимое локального файла. Электронная подпись и защищённая хеш-цепочка источником не переданы. Сетка просмотра не является сеткой допусков.</p>
  </section>;
}

function DecisionPanel({ record, source, hashState }: { record: InspectionCase; source: Case; hashState?: HashState }) {
  const [choice, setChoice] = useState<WorkflowAction | null>(null);
  const [basis, setBasis] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [comment, setComment] = useState('');
  const [author, setAuthor] = useState('');
  const [measurement, setMeasurement] = useState('');
  const [instrument, setInstrument] = useState('');
  const [calibrated, setCalibrated] = useState(false);
  const [message, setMessage] = useState('');
  const hasMaster = record.iteration > 1 && ['REWORK_VERIFICATION', 'UNDER_REVIEW'].includes(record.status) && !!record.masterReworkReport;
  const reworked = hasMaster && record.masterReworkReport?.actionType === 'rework_completed';
  const own = eventsFor(record.itemId);
  const scrapReady = record.itemId === 'ITEM-015' && source.type !== 'UNASSESSABLE' && own.filter(event => event.event_type === 'quality_decision').at(-1)?.data.disposition === 'quarantine' && own.some(event => event.event_type === 'technical_disposition' && event.data.disposition === 'rework_not_allowed');
  const visualAllowed = record.visualEvidence.hasImage && record.visualEvidence.quality === 'OPTIMAL' && hashState !== 'invalid' && hashState !== 'checking';
  const requireMeasurement = hasMaster && record.itemId === 'ITEM-013';
  const options: { key: WorkflowAction; label: string; shortcut: string; tone: string; disabled?: boolean; title?: string }[] = scrapReady ? [
    { key: 'scrap', label: 'Окончательный брак по заключению технолога', shortcut: 'F3', tone: 'red' },
  ] : hasMaster && record.itemId === 'ITEM-015' ? [
    { key: 'confirm', label: 'Подтвердить дефект после очной проверки', shortcut: 'F1', tone: 'red', disabled: !visualAllowed },
    { key: 'additional', label: 'Назначить дополнительный контроль', shortcut: 'F2', tone: 'blue' },
  ] : hasMaster && record.itemId === 'ITEM-016' ? [
    { key: 'reject', label: 'Отклонить исходный сигнал CV', shortcut: 'F1', tone: 'green', disabled: !visualAllowed },
    { key: 'confirm', label: 'Подтвердить дефект', shortcut: 'F2', tone: 'red', disabled: !visualAllowed },
  ] : reworked ? [
    { key: 'release', label: 'Принять после доработки', shortcut: 'F1', tone: 'green', disabled: !visualAllowed || (record.itemId === 'ITEM-014' && record.iteration === 2), title: !visualAllowed ? 'Нужен пригодный кадр результата' : undefined },
    { key: 'recheck_fail', label: 'Вернуть на повторную зачистку', shortcut: 'F2', tone: 'amber' },
    { key: 'scrap', label: 'Окончательный брак', shortcut: 'F3', tone: 'red', disabled: !eventsFor(record.itemId).some(event => event.event_type === 'technical_disposition' && event.data.disposition === 'rework_not_allowed'), title: 'Нужно заключение технолога о невозможности доработки' },
  ] : hasMaster ? [
    { key: 'confirm', label: 'Подтвердить дефект после очной проверки', shortcut: 'F1', tone: 'red', disabled: !visualAllowed },
    { key: 'reject', label: 'Отклонить сигнал CV', shortcut: 'F2', tone: 'green', disabled: !visualAllowed },
    { key: 'additional', label: 'Назначить доппроверку', shortcut: 'F3', tone: 'blue' },
  ] : [
    { key: 'confirm_hold', label: 'Подтвердить дефект', shortcut: 'F1', tone: 'red', disabled: !visualAllowed },
    { key: 'confirm', label: 'Направить на доработку', shortcut: 'F2', tone: 'amber', disabled: !visualAllowed },
    { key: 'reject', label: 'Отклонить (ложный сигнал)', shortcut: 'F3', tone: 'neutral', disabled: !visualAllowed || record.itemId === 'ITEM-016' },
    { key: 'additional', label: 'Ручной замер / доппроверка', shortcut: 'F4', tone: 'blue' },
  ];
  const settled = !scrapReady && (['FALSE_POSITIVE', 'ACCEPTED_AFTER_REWORK'].includes(record.status) || (!hasMaster && source.decisions.length > 0 && record.status !== 'NEW_SIGNAL'));
  useEffect(() => { setChoice(null); setBasis(''); setDocumentId(''); setComment(''); setMessage(''); setMeasurement(''); setInstrument(''); setCalibrated(false); }, [record.id, record.iteration]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (isFormTarget(event.target) || settled) return;
      const option = options.find(row => row.shortcut === event.key.toUpperCase());
      if (option) { event.preventDefault(); if (!option.disabled) setChoice(option.key); }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [options, settled]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!choice || !basis || !documentId.trim() || comment.trim().length < 5) return;
    try {
      performAction(record.itemId, 'controller', choice, `${basis} ${documentId.trim()}. ${comment.trim()}`, author.trim(), true, record.id,
        requireMeasurement && choice === 'release' ? { value: Number(measurement), instrumentId: instrument, calibrationConfirmed: calibrated } : undefined);
      setMessage('Решение записано в историю. Очередь и задания обновлены.');
      setChoice(null); setComment('');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось записать решение'); }
  };
  return <section className="cockpit-decision"><div className="cockpit-section-head"><div><span className="cockpit-kicker">04 / ПУЛЬТ</span><h2>Пульт решения контролёра</h2></div></div>
    {settled ? <p className="cockpit-muted">Текущее рассмотрение завершено. Решение и основание доступны в истории заявки.</p> : <>
      <div className="cockpit-decision-prereq">
        <label>Основание решения (по классификатору)<select required value={basis} onChange={event => setBasis(event.target.value)}><option value="">Выберите основание</option><option value="ГОСТ">ГОСТ</option><option value="СТП">СТП</option><option value="Рабочий чертёж">Рабочий чертёж</option><option value="Программа контроля">Программа контроля</option></select></label>
        <label>Комментарий<textarea required minLength={5} rows={2} value={comment} onChange={event => setComment(event.target.value)} placeholder="Что проверено и что установлено"/></label>
      </div>
      <div className="cockpit-actions">{options.map(option => <button key={option.key} type="button" className={`${option.tone} ${choice === option.key ? 'selected' : ''}`} disabled={option.disabled} title={option.title} onClick={() => { setChoice(option.key); setMessage(''); }}><kbd>{option.shortcut}</kbd><span>{option.label}</span></button>)}</div>
      {!visualAllowed && !scrapReady && <p className="cockpit-block">По отсутствующему или ограниченному кадру доступны только очный контроль и доппроверка.</p>}
      {choice && <form className="cockpit-decision-form" onSubmit={submit}>
        <label>Номер и редакция документа<input required value={documentId} onChange={event => setDocumentId(event.target.value)}/></label>
        {requireMeasurement && choice === 'release' && <div className="cockpit-measurement"><strong>Фактический ручной замер · обязательный</strong><span>Для учебного маршрута ITEM-013: толщина стенки ≥ 5,0 мм. Внесите результат измерения; кадр CV его не заменяет.</span><label>Измерено, мм<input type="number" step="0.01" min="5" required value={measurement} onChange={event => setMeasurement(event.target.value)}/></label><label>Идентификатор прибора<input required value={instrument} onChange={event => setInstrument(event.target.value)}/></label><label className="cockpit-inline-check"><input type="checkbox" checked={calibrated} onChange={event => setCalibrated(event.target.checked)}/>Поверка прибора подтверждена контролёром</label></div>}
        <label>Контролёр<input value={author} required onChange={event => setAuthor(event.target.value)}/></label>
        <label className="cockpit-inline-check"><input type="checkbox" disabled/>Синхронизировать с ERP · интеграция запланирована</label>
        <button className="cockpit-submit" type="submit" disabled={!author.trim() || !basis || !documentId.trim() || comment.trim().length < 5 || (requireMeasurement && choice === 'release' && (!measurement || !instrument.trim() || !calibrated))}>Записать решение</button>
      </form>}
    </>}{message && <p className="cockpit-message" role="status">{message}</p>}
  </section>;
}

/** Full-screen controller workbench with persistent queue, evidence and decision context. */
export function ControllerCockpit({ scope, caseId, openCase, openPassport }: { scope: Scope; caseId?: string; openCase: (item: string, caseId: string) => void; openPassport: (item: string) => void }) {
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [criticality, setCriticality] = useState('all');
  const [query, setQuery] = useState('');
  const [sessionStart] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [hashState, setHashState] = useState<HashState>('unavailable');
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 60000); return () => window.clearInterval(id); }, []);
  const timelineEnd = Math.max(...events.map(event => Date.parse(event.occurred_at)));
  const source = cases.filter(row => row.observations.some(event => inScope(event, scope)));
  const projected = source.map(row => ({ source: row, view: inspectionCaseFrom(row) }));
  const filtered = projected.filter(({ source: row, view }) => {
    const urgent = view.urgency === 'CRITICAL';
    const uncertain = view.visualEvidence.quality !== 'OPTIMAL' || (view.visualEvidence.aiConfidence ?? 100) < 60;
    return queueStatus(row) && (filter === 'all' || filter === 'critical' && urgent || filter === 'rework' && view.status === 'REWORK_VERIFICATION' || filter === 'unassessable' && uncertain)
      && (criticality === 'all' || view.urgency === criticality)
      && (!query || `${view.id} ${view.itemId} ${view.partName} ${defectNames[row.type] ?? row.type}`.toLowerCase().includes(query.toLowerCase()));
  }).sort((a, b) => b.source.priority - a.source.priority || a.view.createdAt.localeCompare(b.view.createdAt));
  const selected = filtered.find(row => row.source.id === caseId) ?? filtered.find(row => row.view.itemId === 'ITEM-013') ?? filtered[0];
  const view = selected?.view;
  const imageUrl = view?.visualEvidence.currentImageUrl;
  const expectedHash = view?.visualEvidence.cameraMeta.imageHash;
  useEffect(() => {
    let active = true;
    if (!imageUrl || !expectedHash) { setHashState('unavailable'); return; }
    setHashState('checking');
    void verifyImageHash(imageUrl, expectedHash).then(value => { if (active) setHashState(value); });
    return () => { active = false; };
  }, [imageUrl, expectedHash]);
  const sourceCase = selected?.source;
  useEffect(() => {
    const list = document.querySelector('.cockpit-queue-list');
    const active = list?.querySelector('.cockpit-queue-item.active');
    if (list && active) list.scrollTop += active.getBoundingClientRect().top - list.getBoundingClientRect().top - 10;
  }, [sourceCase?.id]);
  const product = view ? items.find(row => row.id === view.itemId) : undefined;
  const data = sourceCase && product ? controllerCaseData(sourceCase, product, mediaIndex) : undefined;
  const own = view ? eventsFor(view.itemId) : [];
  const machine = own.filter(event => event.event_type === 'machine_state' && (!data?.observation.operation_run_id || event.operation_run_id === data.observation.operation_run_id)).at(-1);
  const observation = data?.observation;
  const counts = {
    critical: projected.filter(row => queueStatus(row.source) && row.view.urgency === 'CRITICAL').length,
    rework: projected.filter(row => row.view.status === 'REWORK_VERIFICATION').length,
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
  return <div className="controller-cockpit">
    <div className="cockpit-title"><div><span className="cockpit-kicker">РАБОЧЕЕ МЕСТО / ОТК</span><h2>Кокпит верификации качества</h2></div><div className="cockpit-title-meta"><span className="cockpit-live-dot"/>Синтетические события · локальный учебный контур</div></div>
    <header className="cockpit-passport">
      <div><span className="cockpit-kicker">ПАСПОРТ ДЕТАЛИ</span><strong className="mono">{view?.itemId ?? ''}</strong><small>{view?.partName}</small></div>
      <div><span>Заказ</span><strong className="mono">{view?.workOrder}</strong><small>Ревизия {view?.drawingRevision} · Чертёж {missing}</small></div>
      <div><span>Партия</span><strong className="mono">{view?.batchId}</strong><small>Лот поставщика: {view?.supplierLotId}</small><small>Маршрутный лист: {view?.routeSheet ?? missing}</small></div>
      <div className="passport-integrity"><span>Защищённый контур</span><strong>Нет подтверждения</strong><small>SHA-256 файла проверяется отдельно; подпись и цепочка ожидают подключения</small></div>
    </header>
    <div className="cockpit-columns"><aside className="cockpit-panel cockpit-queue"><div className="cockpit-section-head"><div><span className="cockpit-kicker">01 / ПОТОК</span><h2>Очередь сигналов ОТК</h2></div><strong>{filtered.length}</strong></div><div className="cockpit-queue-filters">{([['critical','Критичные'], ['rework','Повторный контроль'], ['unassessable','Оценка невозможна'], ['all','Все в смене']] as const).map(([key, label]) => <button key={key} className={`${key} ${filter === key ? 'active' : ''}`} onClick={() => setFilter(key)}>{label}<span>{counts[key]}</span></button>)}</div><div className="cockpit-queue-tools"><input aria-label="Поиск заявки" placeholder="ID, узел, признак…" value={query} onChange={event => setQuery(event.target.value)}/><select aria-label="Критичность" value={criticality} onChange={event => setCriticality(event.target.value)}><option value="all">Любая критичность</option><option value="CRITICAL">Критическая</option><option value="HIGH">Высокая</option><option value="MEDIUM">Средняя</option><option value="LOW">Низкая</option></select></div><div className="cockpit-queue-list">{filtered.length ? filtered.map(({ source: row, view: item }) => <button key={row.id} className={`cockpit-queue-item ${sourceCase?.id === row.id ? 'active' : ''} ${item.urgency.toLowerCase()}`} onClick={() => openCase(item.itemId, row.id)} aria-current={sourceCase?.id === row.id ? 'true' : undefined}><span className="queue-top"><strong className="mono">{item.itemId}</strong><small>{compareAge(item.createdAt, timelineEnd)}</small></span><span className="queue-part">{item.partName}</span><span className="queue-defect">{defectNames[row.type] ?? row.type} · {controllerCaseData(row, items.find(product => product.id === row.item)!, mediaIndex).regionName}</span><span className="queue-bottom"><em>{item.iteration > 1 ? `Итерация #${item.iteration}` : item.visualEvidence.aiConfidence != null ? `CV ${item.visualEvidence.aiConfidence}%` : 'Уверенность не передана'}</em><span>{item.visualEvidence.hasImage ? '● Кадр' : '○ Без кадра'}</span></span></button>) : <p className="cockpit-muted">В выбранном фильтре нет открытых заявок.</p>}</div></aside>
      {view && sourceCase && data ? <><EvidenceViewer key={view.id} record={view} hashState={hashState}/><aside className="cockpit-panel cockpit-context"><div className="cockpit-context-scroll"><div className="cockpit-section-head"><div><span className="cockpit-kicker">03 / КОНТЕКСТ</span><h2>Досье и основания</h2></div><span className="cockpit-iteration">Итерация #{view.iteration}</span></div><div className="cockpit-status-row"><span className={`urgency ${view.urgency.toLowerCase()}`}>{view.urgency}</span><span>{statusText[view.status]}</span></div><section className="context-block">
  <h3>О дефекте и контексте</h3>
  <dl>
    <div><dt>Случай</dt><dd className="mono">{view.id}</dd></div>
    <div><dt>Дефект</dt><dd>{defectNames[sourceCase.type] ?? sourceCase.type} · {data.regionName}</dd></div>
    <div><dt>Уверенность CV</dt><dd>{view.visualEvidence.aiConfidence != null ? (view.visualEvidence.aiConfidence + '%') : missing}</dd></div>
    <div><dt>Станок</dt><dd>{view.machineContext.machineId ?? missing}</dd></div>
    <div><dt>Оператор</dt><dd>{view.machineContext.operatorId ?? missing}</dd></div>
    <div><dt>Участок</dt><dd>{stationNames[view.machineContext.stationId] ?? view.machineContext.stationId}</dd></div>
    <div><dt>Запуск</dt><dd className="mono">{observation!.operation_run_id ?? missing}</dd></div>
    <div><dt>Наблюдение</dt><dd>{time(observation!.occurred_at)} · {observation!.event_id}</dd></div>
    <div><dt>DPM-код</dt><dd>{missing}</dd></div>
  </dl>
  {data.missing.length > 0 && <div className="context-gaps">{data.missing.slice(0, 5).map(value => <span key={value}>⚠ {value}</span>)}</div>}
  {machine && <p className={view.machineContext.machineWarnings.length ? 'text-amber' : 'cockpit-muted'}>Телеметрия: {view.machineContext.machineWarnings.length ? view.machineContext.machineWarnings.join('; ') : (machine.data.state ?? 'состояние не указано') + ', пиковая нагрузка ' + (machine.data.spindle_load_peak_pct ?? missing) + '%'}. Не является доказательством причины.</p>}
</section>
<section className="context-block">
  <h3>Технологическое расследование</h3>
  {view.technologistFinding ? <>
    <strong>{view.technologistFinding.investigationStatus === 'COMPLETED' ? 'Заключение записано' : 'Анализ причин продолжается'}</strong>
    <p>{view.technologistFinding.description}</p>
    <small>Допустимость доработки: {view.technologistFinding.reworkPermitted == null ? missing : view.technologistFinding.reworkPermitted ? 'подтверждена' : 'запрещена'}</small>
  </> : <p className="cockpit-pending-status"><Icon name="clock" size={16}/>Расследование технолога не открыто (дефект на рассмотрении ОТК)</p>}
  {view.iteration > 1 && <div className="context-rework">
    <h4>Отчёт мастера</h4>
    <p><strong>{view.masterReworkReport?.masterName ?? missing}</strong> · {view.masterReworkReport ? time(view.masterReworkReport.completedAt) : missing}</p>
    <p>{view.masterReworkReport?.actionDescription ?? missing}</p>
    <small>Ручной замер: {view.masterReworkReport?.manualMeasurement ? view.masterReworkReport.manualMeasurement.measuredValue + ' мм · ' + (view.masterReworkReport.manualMeasurement.toolName ?? missing) : missing}</small>
  </div>}
</section><details className="context-history"><summary>История случая · {sourceCase.observations.length} наблюд.</summary>{[...sourceCase.observations, ...sourceCase.decisions].sort((a,b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at)).map(event => <p key={event.event_id}><span className="mono">{time(event.occurred_at)}</span> {describeEvent(event)}</p>)}</details><button className="cockpit-passport-link" onClick={() => openPassport(view.itemId)}>Полный паспорт изделия ↗</button></div><DecisionPanel key={`${view.id}-${view.iteration}`} record={view} source={sourceCase} hashState={hashState}/></aside></> : <div className="cockpit-empty">Выберите заявку в очереди</div>}</div>
    <div className="cockpit-footer"><span><kbd>F1–F4</kbd> Решение <kbd>Пробел</kbd> Следующая заявка <kbd>Z</kbd> Зум</span><span className="mono">Контролёр {missing} · сессия {Math.floor((now - sessionStart) / 60000)} мин</span></div>
  </div>;
}
