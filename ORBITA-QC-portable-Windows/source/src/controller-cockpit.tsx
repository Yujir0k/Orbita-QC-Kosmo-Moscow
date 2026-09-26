import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { cases, defectNames, describeEvent, events, eventsFor, inScope, items, mediaIndex, performAction, stationNames, time, type Case, type QualityEvent, type Scope, type WorkflowAction } from './domain';
import { controllerCaseData } from './controller-case';
import { inspectionCaseFrom, type InspectionCase } from './inspection-case';
import { Icon } from './ui';

type QueueFilter = 'critical' | 'rework' | 'unassessable' | 'all';
type HashState = 'checking' | 'valid' | 'invalid' | 'unavailable';

const decisionBases = {
  defect: [
    'КД: Превышение предельного допуска по чертежу',
    'СТП: Механическое повреждение рабочей поверхности',
    'ГОСТ: Недопустимый дефект внешнего вида / трещина',
    'ТУ: Дефект исходного металлопроката (входной брак)',
  ],
  reject: [
    'AI-ошибка: Блик освещения / оптическая тень',
    'AI-ошибка: След СОЖ или технологической смазки',
    'Норма: Риска в пределах допустимой шероховатости Ra',
  ],
  additional: [
    'Инструментальный замер: Требуется контроль профилометром/штангенциркулем',
    'Пересъемка: Кадр не позволяет оценить глубину залегания',
  ],
  release: ['КД: Размеры и состояние после доработки соответствуют чертежу'],
} as const;
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
  return <div className={['qc-frame', contrast && 'high-contrast', zoom && 'zoomed', grid && 'with-grid'].filter(Boolean).join(' ')}>
    <span className="qc-frame-label">{label}</span>
    {url ? <div className="qc-image-stage">
      <img src={url} alt={label}/>
      {bbox && <span className="qc-bbox" style={{ left: bbox[0] + '%', top: bbox[1] + '%', width: bbox[2] + '%', height: bbox[3] + '%' }} aria-label="Область дефекта от CV"/>}
    </div> : <div className="qc-frame-empty"><Icon name="control" size={28}/><span>{emptyText}</span></div>}
  </div>;
}

function EvidenceViewer({ record, hashState }: { record: InspectionCase; hashState: HashState }) {
  const [shown, setShown] = useState<'current' | 'previous'>('current');
  const [zoom, setZoom] = useState(false);
  const [contrast, setContrast] = useState(false);
  const [grid, setGrid] = useState(false);
  const evidence = record.visualEvidence;
  const current = shown === 'current';
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'z' && !isFormTarget(event.target)) { event.preventDefault(); setZoom(value => !value); }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  const stage = record.masterReworkReport?.actionType === 'rework_completed' ? 'После доработки' : record.iteration > 1 ? 'Очная проверка' : record.itemId === 'ITEM-013' ? 'Зона фрезерования' : stationNames[record.machineContext.stationId] ?? 'Текущий этап';
  const camera = evidence.cameraMeta;
  return <section className="qc-viewer" aria-label="Визуальная экспертиза">
    <div className="qc-tabs" role="tablist" aria-label="Кадры детали">
      <button role="tab" aria-selected={current} className={current ? 'active' : ''} onClick={() => setShown('current')}>Текущий кадр</button>
      <button role="tab" aria-selected={!current} className={!current ? 'active' : ''} disabled={!evidence.beforeImageUrl} onClick={() => setShown('previous')}>Предыдущий этап {evidence.beforeImageUrl ? '' : '· нет данных'}</button>
    </div>
    {hashState === 'invalid' && <p className="qc-image-warning" role="alert">Целостность кадра нарушена. Решение по изображению заблокировано.</p>}
    {evidence.quality !== 'OPTIMAL' && <p className="qc-image-warning" role="alert">{evidence.quality === 'NO_IMAGE' ? 'Кадр не поступил. Доступна очная проверка.' : 'Качество кадра ограничено. Нужна очная проверка.'}</p>}
    <Frame
      url={current ? evidence.currentImageUrl : evidence.beforeImageUrl}
      label={current ? 'СЕЙЧАС · ' + stage : 'ДО · предыдущий этап'}
      emptyText={current ? 'Кадр текущего этапа отсутствует' : 'Кадр предыдущего этапа отсутствует'}
      contrast={contrast} zoom={zoom} grid={grid}
      bbox={current ? evidence.defectBBox : undefined}
    />
    <div className="qc-toolbar">
      <button aria-pressed={zoom} onClick={() => setZoom(value => !value)}><Icon name="search" size={17}/>Зум <kbd>Z</kbd></button>
      <button aria-pressed={contrast} onClick={() => setContrast(value => !value)}><Icon name="control" size={17}/>Контраст</button>
      <button aria-pressed={grid} onClick={() => setGrid(value => !value)}><Icon name="layer" size={17}/>Сетка</button>
    </div>
    <div className="qc-meta">
      <span>Камера <strong>{camera.cameraId ?? '—'}</strong></span>
      <span>Свет <strong>{camera.lightingProfile ?? '—'}</strong></span>
      <span>Калибровка <strong>{camera.calibrationStatus === 'VALID' ? 'активна' : camera.calibrationProfile ?? 'нет данных'}</strong></span>
      <span className={hashState === 'valid' ? 'valid' : ''}><Icon name={hashState === 'valid' ? 'check' : 'help'} size={15}/>{hashState === 'valid' ? 'SHA-256 подтверждён' : hashState === 'checking' ? 'Проверка SHA-256' : hashState === 'invalid' ? 'Хеш не совпал' : 'Хеш не передан'}</span>
    </div>
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
    { key: 'confirm_hold', label: 'Подтвердить брак', shortcut: 'F1', tone: 'red', disabled: !visualAllowed },
    { key: 'confirm', label: 'На доработку', shortcut: 'F2', tone: 'amber', disabled: !visualAllowed },
    { key: 'reject', label: 'Ложный сигнал', shortcut: 'F3', tone: 'neutral', disabled: !visualAllowed || record.itemId === 'ITEM-016' },
    { key: 'additional', label: 'Назначить ручной замер', shortcut: 'F4', tone: 'blue' },
  ];
  const settled = !scrapReady && (['FALSE_POSITIVE', 'ACCEPTED_AFTER_REWORK'].includes(record.status) || (!hasMaster && source.decisions.length > 0 && record.status !== 'NEW_SIGNAL'));
  const basisGroup = choice === 'reject' ? 'reject' : choice === 'additional' ? 'additional' : choice === 'release' ? 'release' : 'defect';
  const selectChoice = (next: WorkflowAction) => { setChoice(next); setBasis(''); setMessage(''); };
  useEffect(() => { setChoice(null); setBasis(''); setDocumentId(''); setComment(''); setMessage(''); setMeasurement(''); setInstrument(''); setCalibrated(false); }, [record.id, record.iteration]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (isFormTarget(event.target) || settled) return;
      const option = options.find(row => row.shortcut === event.key.toUpperCase());
      if (option) { event.preventDefault(); if (!option.disabled) selectChoice(option.key); }
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
  return <section className="qc-decision" aria-label="Решение контролёра">
    {settled ? <p className="qc-decision-note">Решение принято. Основание доступно в досье.</p> : <>
      <div className="qc-decision-fields">
        <label><span className="sr-only">Основание решения (по классификатору)</span><select aria-label="Основание решения (по классификатору)" required disabled={!choice} value={basis} onChange={event => setBasis(event.target.value)}><option value="">{choice ? 'Выберите основание решения' : 'Сначала выберите действие F1–F4'}</option>{decisionBases[basisGroup].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><span className="sr-only">Комментарий</span><input aria-label="Комментарий" required minLength={5} value={comment} onChange={event => setComment(event.target.value)} placeholder="Комментарий к решению…"/></label>
      </div>
      <div className="qc-actions">{options.map(option => <button key={option.key} type="button" className={[option.tone, choice === option.key && 'selected'].filter(Boolean).join(' ')} disabled={option.disabled} title={option.title} onClick={() => selectChoice(option.key)}><kbd>{option.shortcut}</kbd><span>{option.label}</span></button>)}</div>
      {choice && <form className="qc-decision-form" onSubmit={submit}>
        <strong>Запись решения: {options.find(option => option.key === choice)?.label}</strong>
        <label>Номер и редакция документа<input required value={documentId} onChange={event => setDocumentId(event.target.value)}/></label>
        {requireMeasurement && choice === 'release' && <div className="cockpit-measurement"><strong>Фактический ручной замер · обязательный</strong><span>Для учебного маршрута ITEM-013: толщина стенки ≥ 5,0 мм. Внесите результат измерения; кадр CV его не заменяет.</span><label>Измерено, мм<input type="number" step="0.01" min="5" required value={measurement} onChange={event => setMeasurement(event.target.value)}/></label><label>Идентификатор прибора<input required value={instrument} onChange={event => setInstrument(event.target.value)}/></label><label className="cockpit-inline-check"><input type="checkbox" checked={calibrated} onChange={event => setCalibrated(event.target.checked)}/>Поверка прибора подтверждена контролёром</label></div>}
        <label>Контролёр<input value={author} required onChange={event => setAuthor(event.target.value)}/></label>
        <button className="qc-submit" type="submit" disabled={!author.trim() || !basis || !documentId.trim() || comment.trim().length < 5 || (requireMeasurement && choice === 'release' && (!measurement || !instrument.trim() || !calibrated))}>Записать решение</button>
      </form>}
    </>}{message && <p className="qc-decision-message" role="status">{message}</p>}
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
  return <div className="qc-drawer-layer">
    <button className="qc-drawer-backdrop" aria-label="Закрыть досье" onClick={onClose}/>
    <aside className="qc-drawer" role="dialog" aria-modal="true" aria-label="Досье и телеметрия">
      <header><div><span>Паспорт случая · {record.id}</span><h2>Досье и телеметрия</h2></div><button ref={closeRef} aria-label="Закрыть досье" onClick={onClose}><Icon name="close" size={20}/></button></header>
      <div className="qc-drawer-content">
        <section><h3>Идентификация</h3><dl>
          <div><dt>Изделие</dt><dd className="mono">{record.itemId}</dd></div>
          <div><dt>Заказ</dt><dd className="mono">{record.workOrder}</dd></div>
          <div><dt>Партия</dt><dd>{record.batchId ?? 'Нет данных'}</dd></div>
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
        <section><h3>История случая</h3>{[...source.observations, ...source.decisions].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at)).map(event => <p key={event.event_id}><span className="mono">{time(event.occurred_at)}</span> · {describeEvent(event)}</p>)}</section>
        <button className="qc-passport-link" onClick={() => { onClose(); openPassport(record.itemId); }}>Открыть полный паспорт изделия <Icon name="arrow" size={16}/></button>
      </div>
    </aside>
  </div>;
}

/** Full-screen controller workbench with persistent queue, evidence and decision context. */
export function ControllerCockpit({ scope, caseId, openCase, openPassport }: { scope: Scope; caseId?: string; openCase: (item: string, caseId: string) => void; openPassport: (item: string) => void }) {
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [criticality, setCriticality] = useState('all');
  const [query, setQuery] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerTrigger = useRef<HTMLButtonElement>(null);
  const drawerClose = useRef<HTMLButtonElement>(null);
  const [hashState, setHashState] = useState<HashState>('unavailable');
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
    const list = document.querySelector('.qc-queue-list');
    const active = list?.querySelector('.qc-queue-item.active');
    if (list && active) list.scrollTop += active.getBoundingClientRect().top - list.getBoundingClientRect().top - 10;
  }, [sourceCase?.id]);
  const product = view ? items.find(row => row.id === view.itemId) : undefined;
  const data = sourceCase && product ? controllerCaseData(sourceCase, product, mediaIndex) : undefined;
  const own = view ? eventsFor(view.itemId) : [];
  const machine = own.filter(event => event.event_type === 'machine_state' && (!data?.observation.operation_run_id || event.operation_run_id === data.observation.operation_run_id)).at(-1);
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
  const priorityLabel = view ? { CRITICAL: 'Критично', HIGH: 'Высокий приоритет', MEDIUM: 'Средний приоритет', LOW: 'Низкий приоритет' }[view.urgency] : '';
  return <div className="controller-cockpit qc-cockpit">
    <header className="qc-header">
      <div className="qc-identity"><strong className="mono">{view?.itemId ?? 'Выберите изделие'}</strong>{view && <><span>·</span><strong className="mono">{view.workOrder}</strong><span className="qc-part-name">({view.partName.replace(/^Условный\s+/, '')})</span></>}</div>
      {view && sourceCase && <span className={['qc-defect-badge', view.urgency.toLowerCase()].join(' ')}>{defectNames[sourceCase.type] ?? sourceCase.type} · {priorityLabel}</span>}
      <div className="qc-header-right">
        <span className={['qc-hash-status', hashState].join(' ')}><Icon name={hashState === 'valid' ? 'check' : 'help'} size={15}/>{hashState === 'valid' ? 'Хеш кадра валиден' : hashState === 'checking' ? 'Проверка хеша' : hashState === 'invalid' ? 'Хеш не совпал' : 'Хеш не передан'}</span>
        <button ref={drawerTrigger} className="qc-drawer-trigger" onClick={() => setDrawerOpen(true)} disabled={!view}><Icon name="help" size={17}/>Досье и телеметрия <kbd>D</kbd></button>
      </div>
    </header>
    <div className="qc-layout">
      <aside className="qc-queue" aria-label="Очередь сигналов ОТК">
        <div className="qc-queue-heading"><h2>Очередь ОТК</h2><strong>{filtered.length}</strong></div>
        <div className="qc-queue-filters">{([['critical','Критичные'], ['rework','Повторный контроль'], ['unassessable','Нужна проверка'], ['all','Все']] as const).map(([key, label]) => <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}<span>{counts[key]}</span></button>)}</div>
        <div className="qc-queue-tools"><input aria-label="Поиск заявки" placeholder="ID или дефект…" value={query} onChange={event => setQuery(event.target.value)}/><select aria-label="Критичность" value={criticality} onChange={event => setCriticality(event.target.value)}><option value="all">Любой приоритет</option><option value="CRITICAL">Критический</option><option value="HIGH">Высокий</option><option value="MEDIUM">Средний</option><option value="LOW">Низкий</option></select></div>
        <div className="qc-queue-list">{filtered.length ? filtered.map(({ source: row, view: item }) => <button key={row.id} className={['qc-queue-item', sourceCase?.id === row.id && 'active'].filter(Boolean).join(' ')} onClick={() => openCase(item.itemId, row.id)} aria-current={sourceCase?.id === row.id ? 'true' : undefined}>
          <span className="qc-queue-primary"><strong className="mono">{item.itemId}</strong><span>• {defectNames[row.type] ?? row.type}{item.visualEvidence.aiConfidence == null ? '' : ' (' + item.visualEvidence.aiConfidence + '%)'}</span></span>
          <span className="qc-queue-secondary"><span>{compareAge(item.createdAt, timelineEnd).replace('в ленте', 'в очереди')}</span><span className={item.visualEvidence.hasImage ? 'has-image' : ''}>{item.visualEvidence.hasImage ? 'Есть снимок' : 'Нет снимка'}</span></span>
        </button>) : <p className="qc-empty-queue">В этом фильтре нет открытых заявок.</p>}</div>
      </aside>
      {view && sourceCase && data ? <main className="qc-workbench">
        <EvidenceViewer key={view.id} record={view} hashState={hashState}/>
        <DecisionPanel key={view.id + '-' + view.iteration} record={view} source={sourceCase} hashState={hashState}/>
      </main> : <div className="qc-no-selection">Выберите заявку в очереди</div>}
    </div>
    {drawerOpen && view && sourceCase && observation && <DossierDrawer record={view} source={sourceCase} observation={observation} machine={machine} missingFields={data?.missing ?? []} onClose={closeDrawer} openPassport={openPassport} closeRef={drawerClose}/>}
  </div>;
}
