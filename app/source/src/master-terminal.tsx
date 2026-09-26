import { readWorkspaceValue, saveWorkspaceValue } from './workspace-storage';
import { useEffect, useState, type FormEvent } from 'react';
import { cases, defectNames, eventsFor, mediaIndex, mediaUrl, operations, tasks, time, type Case, type MasterReworkDetails, type Scope, type Task } from './domain';
import { isProduction, uploadEvidence, securePerformAction } from './security-client';
import { Icon } from './ui';

type QueueTab = 'rework' | 'inspection' | 'delays';
const methods = ['Слесарная полировка микрокорундом', 'Повторный чистовой проход', 'Локальная зачистка заусенцев'];
const operators = ['OP-03 Иванов', 'OP-02 Петров', 'OP-04 Сидоров'];
const afterAssets: Record<string, string> = { 'ITEM-013': 'M013-MASTER-CLEAR', 'ITEM-014': 'M014-MASTER-STILL', 'ITEM-025': 'M025-MASTER-CLEAR', 'ITEM-028': 'M028-MASTER-CLEAR', 'ITEM-015': 'M015-MASTER-DENT', 'ITEM-016': 'M016-MASTER-CLEAR' };
const customMethodStorageKey = 'orbita.master.custom-methods';

function caseFor(task: Task): Case | undefined {
  return cases.find(entry => entry.item === task.item && entry.type !== 'UNASSESSABLE') ?? cases.find(entry => entry.item === task.item);
}

function activeTasks(scope: Scope, tab: QueueTab): Task[] {
  return tasks.filter(task => task.role === 'master' && (scope === 'all' || task.event.shift_id === scope) && (tab === 'rework' ? task.event.data.disposition === 'rework' : tab === 'inspection' ? task.event.data.disposition === 'hold' : false));
}

function waitMinutes(task: Task, elapsedMinutes: number): number {
  const itemClock = Math.max(...eventsFor(task.item).map(event => Date.parse(event.occurred_at)), Date.parse(task.event.occurred_at));
  return Math.max(0, Math.round((itemClock - Date.parse(task.event.occurred_at)) / 60000)) + elapsedMinutes;
}

function formatWait(minutes: number): string {
  return minutes < 1 ? 'Менее 1 мин' : `${minutes} мин`;
}

function normalizeDecimal(value: string): string {
  const canonical = value.replace(',', '.').trim();
  if (!canonical) return '';
  const numeric = Number(canonical);
  return Number.isFinite(numeric) ? numeric.toFixed(2).replace(/\.?0+$/, '') : canonical;
}

function MasterPhotoLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [contrast, setContrast] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  const center = () => { setPosition({ x: 0, y: 0 }); setZoom(1); };
  return <div className="master-lightbox" role="dialog" aria-modal="true" aria-label={`Просмотр фото: ${alt}`} onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <div className="master-lightbox-panel">
      <header><strong>{alt}</strong><button type="button" className="icon-button" aria-label="Закрыть просмотр" onClick={onClose}><Icon name="close" size={22}/></button></header>
      <div className="master-lightbox-stage">
        <img src={src} alt={alt} draggable={false} className={contrast ? 'is-contrast' : ''} style={{ transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})` }} onPointerDown={event => { if (zoom <= 1) return; event.currentTarget.setPointerCapture(event.pointerId); setDragStart({ x: event.clientX - position.x, y: event.clientY - position.y }); }} onPointerMove={event => { if (dragStart) setPosition({ x: event.clientX - dragStart.x, y: event.clientY - dragStart.y }); }} onPointerUp={() => setDragStart(null)} onPointerCancel={() => setDragStart(null)} />
      </div>
      <footer><button type="button" onClick={() => setZoom(value => Math.max(1, value - .25))} aria-label="Уменьшить">−</button><span>Зум {Math.round(zoom * 100)}%</span><button type="button" onClick={() => setZoom(value => Math.min(4, value + .25))} aria-label="Увеличить">+</button><button type="button" onClick={center} aria-label="Вернуть фото в центр и сбросить масштаб" title="Вернуть фото в центр и сбросить масштаб">В центр · 100%</button><button type="button" aria-pressed={contrast} onClick={() => setContrast(value => !value)}>Контраст</button><button type="button" className="master-lightbox-close" onClick={onClose}>Закрыть</button></footer>
    </div>
  </div>;
}

function MasterRepairForm({ task, onDone }: { task: Task; onDone: (message: string) => void }) {
  const issue = caseFor(task);
  const observation = issue?.observations.at(-1);
  const finding = observation?.data.defects?.find(row => row.defect_type_id === issue?.type) ?? observation?.data.defects?.[0];
  const beforeRef = observation?.data.evidence_refs?.[0];
  const before = mediaIndex.find(asset => asset.asset_id === beforeRef);
  const [uploadedId, setUploadedId] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const after = mediaIndex.find(asset => asset.asset_id === (uploadedId ?? afterAssets[task.item]));
  const restricted = observation?.data.media_evidence?.after_operation.absence_reason === 'CLASSIFIED_RESTRICTED';
  const isRework = task.event.data.disposition === 'rework';
  const [method, setMethod] = useState(methods[issue?.type === 'BURR' ? 2 : 0]);
  const [operator, setOperator] = useState(operators[0]);
  const [duration, setDuration] = useState('18');
  const [actualSize, setActualSize] = useState('0.04');
  const [savedMethods, setSavedMethods] = useState<string[]>(() => {
    try { const parsed = readWorkspaceValue(customMethodStorageKey) ?? []; return Array.isArray(parsed) ? parsed.filter(value => typeof value === 'string') : []; }
    catch { return []; }
  });
  const [paperInspection, setPaperInspection] = useState(false);
  const [inspectionResult, setInspectionResult] = useState<NonNullable<MasterReworkDetails['inspectionResult']>>('signs_detected');
  const [inspectionNote, setInspectionNote] = useState('');
  const [error, setError] = useState('');
  const [methodNotice, setMethodNotice] = useState('');
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [basisLightboxOpen, setBasisLightboxOpen] = useState(false);
  const [confirmScrap, setConfirmScrap] = useState(false);
  const details: MasterReworkDetails = { method: isRework ? method.trim() : 'Очный осмотр', operator: operator.split(' ')[0], durationMinutes: isRework ? Number(duration) : 1, actualSizeMm: isRework ? Number(actualSize.replace(',', '.')) : 0, paperInspection, ...(uploadedId ? { assetId: uploadedId } : {}), ...(!isRework ? { inspectionResult, inspectionNote: inspectionNote.trim() } : {}) };
  const expectedUploadAt = new Date(Math.max(...eventsFor(task.item).map(event => Date.parse(event.occurred_at))) + 60000).toISOString();
  const saveMethod = async () => {
    const value = method.trim();
    if (!value) { setMethodNotice('Введите способ устранения'); return; }
    const next = [value, ...savedMethods.filter(entry => entry !== value)].slice(0, 8);
    setSavedMethods(next);
    try { await saveWorkspaceValue(customMethodStorageKey, next); } catch { setMethodNotice('Не удалось сохранить способ'); return; }
    setMethod(value);
    setMethodNotice('Способ сохранён для этой смены');
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError('');
    try {
      if (isRework && !method.trim()) throw new Error('Укажите способ устранения дефекта');
      if (isRework && (!Number.isFinite(Number(duration)) || Number(duration) < 1)) throw new Error('Укажите длительность доработки');
      if (isRework && (!Number.isFinite(Number(actualSize.replace(',', '.'))) || Number(actualSize.replace(',', '.')) < 0)) throw new Error('Укажите фактический размер после зачистки');
      if (!isRework && inspectionNote.trim().length < 5) throw new Error('Опишите результат очного осмотра');
      await securePerformAction(task.item, 'master', 'master_complete', isRework ? `${method}; исполнитель ${operator}; ${duration} мин; фактический размер ${actualSize} мм.` : `Очный осмотр: ${inspectionNote.trim()}; исполнитель ${operator}.`, !restricted && !!after, issue?.id, undefined, undefined, details);
      onDone(isRework ? `${task.item}: REVISION_READY · направлено в очередь повторного контроля ОТК` : `${task.item}: очный досмотр зафиксирован и передан ОТК`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось записать действие'); }
  };
  const scrap = async () => {
    if (!confirmScrap) { setConfirmScrap(true); return; }
    try { await securePerformAction(task.item, 'master', 'master_scrap', 'Дефект признан неустранимым мастером; деталь передана в изолятор брака.', false, issue?.id); onDone(`${task.item}: предложение о списании передано контролёру`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось записать списание'); }
  };
  return <form className="master-workbench" onSubmit={submit} noValidate>
    <div className="master-workbench-head"><div><span className="master-eyebrow">{isRework ? 'ПАНЕЛЬ ЗАКРЫТИЯ ДОРАБОТКИ И ПЕРЕДАЧИ В ОТК' : 'ПАНЕЛЬ ОЧНОГО ОСМОТРА И ПЕРЕДАЧИ В ОТК'}</span><h2>{task.item} <span>Кронштейн</span></h2><p>{isRework ? 'Исправление дефекта · повторный контроль обязателен' : 'Очный досмотр · возврат заключения инспектору'}</p></div><span className="master-state">{isRework ? 'ЖДЁТ ИСПРАВЛЕНИЯ' : 'НУЖЕН ОСМОТР'}</span></div>
    <section className="master-block"><h3><span>01</span> Основание от ОТК</h3><div className="master-basis"><div className="master-basis-facts"><strong>{issue ? defectNames[issue.type] ?? issue.type : 'Дефект не указан'}</strong><p>{finding?.description ?? observation?.data.observation_summary ?? 'Требуется очная оценка поверхности и ручной замер.'}</p><dl><div><dt>Зафиксированный размер</dt><dd>{finding?.length_mm !== undefined ? `${finding.length_mm} мм` : 'Нужен ручной замер'}</dd></div><div><dt>Инспектор ОТК</dt><dd>{task.event.actor_id ?? 'QC-02'}</dd></div><div><dt>Направление</dt><dd>{task.event.data.disposition === 'rework' ? 'Направлено на доработку' : 'Назначен очный осмотр'}</dd></div></dl></div><div className="master-basis-photo">{before ? <button type="button" className="master-basis-photo-button" aria-label={`Открыть фото дефекта ${task.item} крупно`} onClick={() => setBasisLightboxOpen(true)}><img src={mediaUrl(before)} alt={`Дефект ${task.item}`}/><span>Открыть крупно</span></button> : <span><Icon name="quality" size={27}/>Снимок дефекта не поступил</span>}<small>Снимок от ОТК · синтетический</small></div></div>{basisLightboxOpen && before && <MasterPhotoLightbox src={mediaUrl(before)} alt={`Дефект ${task.item}`} onClose={() => setBasisLightboxOpen(false)}/>}</section>
    <section className="master-block"><h3><span>02</span> {isRework ? 'Параметры исправления' : 'Результат очного осмотра'}</h3><div className="master-fields">{isRework ? <><label>Способ устранения<div className="master-method-control"><input list={`master-methods-${task.item}`} value={method} placeholder="Введите технологическое действие" onChange={event => { const value = event.target.value; setMethod(value === 'Иной способ (указать вручную)' ? '' : value); setMethodNotice(''); }}/><button type="button" className="master-method-save" onClick={saveMethod} aria-label="Сохранить способ устранения"><Icon name="check" size={15}/><span>Сохранить</span></button></div><datalist id={`master-methods-${task.item}`}>{[...methods, 'Иной способ (указать вручную)', ...savedMethods].map(value => <option key={value} value={value}/>)}</datalist>{methodNotice && <small className="master-field-note" role="status">{methodNotice}</small>}</label><label>Длительность доработки (мин)<input type="number" min="1" step="1" required value={duration} onChange={event => setDuration(event.target.value)}/></label><label>Фактический размер/глубина после зачистки (мм)<input type="text" inputMode="decimal" required value={actualSize} onChange={event => setActualSize(event.target.value.replace(',', '.'))} onBlur={() => setActualSize(normalizeDecimal(actualSize))}/></label></> : <><label>Результат<select value={inspectionResult} onChange={event => setInspectionResult(event.target.value as NonNullable<MasterReworkDetails['inspectionResult']>)}><option value="signs_detected">Признак обнаружен</option><option value="no_signs_detected">Признак не обнаружен</option><option value="unable_to_assess">Оценить не удалось</option></select></label><label>Что проверено и установлено<textarea required minLength={5} value={inspectionNote} onChange={event => setInspectionNote(event.target.value)} placeholder="Опишите участок изделия и результат осмотра"/></label></>}<label>Исполнитель<select value={operator} onChange={event => setOperator(event.target.value)}>{operators.map(value => <option key={value}>{value}</option>)}</select></label></div></section>
    <section className="master-block"><h3><span>03</span> {isRework ? 'Подтверждающее фото после устранения' : 'Материалы очного осмотра'}</h3>{restricted ? <label className="master-paper"><input type="checkbox" checked={paperInspection} onChange={event => setPaperInspection(event.target.checked)}/>Осмотрено очно под роспись в бумажном журнале</label> : after ? <div className="master-after"><button type="button" className="master-after-photo" aria-label={`Открыть фото после исправления ${task.item}`} onClick={() => setLightboxOpen(true)}><img src={mediaUrl(after)} alt={`После исправления ${task.item}`}/><span>Открыть крупно</span></button><div><strong>После исправления</strong><p>{uploadedId ? 'Загруженная фотография' : 'Синтетический кадр результата · превью'}</p><small>SHA-256</small><code>{after.sha256 ?? 'Хеш не передан'}</code><small>Время загрузки при фиксации</small><span>{time(expectedUploadAt)} · {uploadedId ? 'материал загружен' : 'учебный кадр'}</span></div></div> : <p className="master-empty">Кадр не предоставлен. Для закрытия нужен очный осмотр под роспись.</p>}{!after && !restricted && <label className="master-paper"><input type="checkbox" checked={paperInspection} onChange={event => setPaperInspection(event.target.checked)}/>Осмотрено очно под роспись в бумажном журнале</label>}{lightboxOpen && after && <MasterPhotoLightbox src={mediaUrl(after)} alt={`После исправления ${task.item}`} onClose={() => setLightboxOpen(false)}/>}</section>
    {isProduction() && !restricted && <label>Загрузить фотографию результата (PNG, JPEG, WebP, до 12 МиБ)<input type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading} onChange={async event => {
      const file = event.target.files?.[0]; if (!file) return;
      setUploading(true); setError('');
      try { setUploadedId(await uploadEvidence(task.item, file)); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Загрузка не выполнена'); }
      finally { setUploading(false); }
    }}/></label>}
    <div className="master-actions"><button className="master-submit" type="submit" disabled={uploading}><Icon name="check" size={18}/>{isRework ? 'Зафиксировать доработку и направить на повторный контроль ОТК' : 'Зафиксировать очный досмотр и передать в ОТК'}</button>{isRework && <button className="master-scrap" type="button" onClick={scrap}>{confirmScrap ? 'Подтвердить передачу в изолятор брака' : 'Предложить списание · передать в изолятор'}</button>}</div><p className="master-form-message" role="alert">{error}</p>
  </form>;
}

/** Workcenter terminal shared by the master's tasks and production entry points. */
export function MasterTerminal({ scope, openItem }: { scope: Scope; openItem: (item: string) => void }) {
  const [tab, setTab] = useState<QueueTab>('rework');
  const [selected, setSelected] = useState('');
  const [notice, setNotice] = useState('');
  const [elapsedMinutes, setElapsedMinutes] = useState(0);
  useEffect(() => { const timer = window.setInterval(() => setElapsedMinutes(value => value + 1), 60000); return () => window.clearInterval(timer); }, []);
  const rework = activeTasks(scope, 'rework');
  const inspection = activeTasks(scope, 'inspection');
  const delays = operations.filter(operation => (scope === 'all' || operation.shift === scope) && (operation.paused || operation.duration !== undefined && operation.duration > 18));
  const current = (tab === 'rework' ? rework : inspection).find(task => task.item === selected) ?? (tab === 'rework' ? rework : inspection)[0];
  return <div className="master-terminal"><div className="master-kpis"><div><span>СТАНКОВ В РАБОТЕ</span><strong>6 <em>/ 7</em></strong><small>На паузе: 1 · EQ-CNC-01</small></div><div><span>ДЕТАЛЕЙ НА ДОРАБОТКЕ</span><strong>{rework.length}</strong><small>В цехе · от ОТК</small></div><div><span>ВЫЗОВОВ МАСТЕРА</span><strong>{inspection.length}</strong><small>Очный осмотр · от ОТК</small></div><div><span>СРЕДНЕЕ ВРЕМЯ ИСПРАВЛЕНИЯ</span><strong>18 <em>мин</em></strong><small>Учебная смена</small></div></div><div className="master-layout"><aside className="master-queue"><div className="master-queue-head"><span className="master-eyebrow">ОПЕРАТИВНЫЕ ЗАДАЧИ</span><h2>Очередь участка <b>{rework.length + inspection.length + delays.length}</b></h2></div><div className="master-tabs" role="tablist" aria-label="Очереди мастера"><button role="tab" aria-selected={tab === 'rework'} onClick={() => setTab('rework')}>На доработке <span>{rework.length}</span><small>от ОТК</small></button><button role="tab" aria-selected={tab === 'inspection'} onClick={() => setTab('inspection')}>Очный досмотр <span>{inspection.length}</span><small>от ОТК</small></button><button role="tab" aria-selected={tab === 'delays'} onClick={() => setTab('delays')}>Задержки и простои <span>{delays.length}</span></button></div><div className="master-queue-list">{tab === 'delays' ? delays.map(operation => <button key={operation.id} className="master-queue-card" onClick={() => openItem(operation.item)}><span className="master-card-top"><strong className="mono">{operation.item}</strong><small>{operation.paused ? 'ПАУЗА' : 'ПРЕВЫШЕНИЕ ЦИКЛА'}</small></span><strong>{operation.name}</strong><p>{operation.station} · {operation.actor ?? 'Оператор не указан'}</p><span className="master-card-bottom">{operation.paused ? 'Станок на паузе' : 'Цикл превышен'}<em>{operation.duration ?? 18}+ мин</em></span></button>) : (tab === 'rework' ? rework : inspection).map(task => { const issue = caseFor(task); const wait = waitMinutes(task, elapsedMinutes); return <button key={task.id} className={`master-queue-card ${current?.item === task.item ? 'active' : ''}`} aria-current={current?.item === task.item ? 'true' : undefined} onClick={() => setSelected(task.item)}><span className="master-card-top"><strong className="mono">{task.item}</strong><small>{tab === 'rework' ? 'ДОРАБОТКА' : 'ОСМОТР'}</small></span><strong>Кронштейн <span>· {issue ? defectNames[issue.type] ?? issue.type : 'Осмотр'}</span></strong><p>{tab === 'rework' ? 'Ждет исправления' : 'Требуется очный досмотр'}</p><span className="master-card-bottom"><span><Icon name="clock" size={13}/> На участке</span><em>{formatWait(wait)}</em></span></button>; })}{tab !== 'delays' && !(tab === 'rework' ? rework : inspection).length && <div className="master-queue-empty">Очередь выполнена. Новые направления от ОТК появятся здесь.</div>}{tab === 'delays' && !delays.length && <div className="master-queue-empty">Превышений цикла и активных простоев нет.</div>}</div></aside>{tab === 'delays' ? <div className="master-delay-panel"><Icon name="production" size={35}/><h2>Контроль задержек и простоев</h2><p>Выберите операцию в очереди, чтобы открыть паспорт изделия и уточнить причину остановки.</p><div><strong>EQ-CNC-01</strong><span>На паузе · требуется осмотр мастера</span></div></div> : current ? <MasterRepairForm key={current.item + '-' + tab} task={current} onDone={message => { setNotice(message); setSelected(''); }}/>: <div className="master-delay-panel"><Icon name="check" size={38}/><h2>Очередь закрыта</h2><p>Детали после фиксации доработки доступны инспектору во вкладке «Повторный контроль».</p></div>}</div>{notice && <div className="master-notice" role="status">{notice}</div>}</div>;
}
