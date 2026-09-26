import { canApproveScrap } from './domain';
import { useState, type FormEvent } from 'react';
import { Badge, Empty, Icon, ImagePreview, ProductDrawing } from './ui';
import { cases, decisionNames, defectNames, describeEvent, eventsFor, inScope, items, mediaIndex, mediaUrl, stationNames, tasks, time, type Case, type Scope, type WorkflowAction } from './domain';
import { currentSecurityUser, securePerformAction } from './security-client';
import { controllerCaseData } from './controller-case';
import { roles, type RoleId } from './navigation';

const priorityLabel = (score: number) => score >= 120 ? 'Критический' : score >= 70 ? 'Высокий' : 'Плановый';
const priorityTone = (score: number) => score >= 120 ? 'red' : score >= 70 ? 'amber' : 'blue';
const severityName: Record<string, string> = { critical: 'Критическая', high: 'Высокая', medium: 'Средняя', low: 'Низкая', requires_review: 'Требует ручной оценки' };

function CasePicture({ caseRecord, compact = false }: { caseRecord: Case; compact?: boolean }) {
  const product = items.find(row => row.id === caseRecord.item)!;
  const data = controllerCaseData(caseRecord, product, mediaIndex);
  if (data.image) return <div className={`controller-picture ${compact ? 'compact' : ''}`}><ImagePreview src={mediaUrl(data.image)} alt={`${defectNames[caseRecord.type] ?? caseRecord.type}: ${data.regionName}. ${data.image.description}`} title="Кадр CV"/><span className="picture-label">КАДР CV · {data.image.asset_id}</span></div>;
  const region = caseRecord.region.toLowerCase();
  const x = region.includes('left') ? 36 : region.includes('right') || region.includes('edge_b') ? 69 : region.includes('hole') ? 61 : 50;
  const y = region.includes('face') ? 42 : region.includes('hole') ? 61 : region.includes('edge') ? 68 : 51;
  return <div className={`controller-picture schematic ${compact ? 'compact' : ''}`}><ProductDrawing compact/>{caseRecord.type !== 'UNASSESSABLE' && <span className="case-marker" style={{ left: `${x}%`, top: `${y}%` }} aria-hidden="true"/>}<span className="picture-label">{caseRecord.type === 'UNASSESSABLE' ? 'ЗОНА НЕ ОПРЕДЕЛЕНА' : 'СХЕМА ЗОНЫ'} · КАДР CV НЕ ПЕРЕДАН</span></div>;
}

/** One row per projected quality case, with evidence gaps visible before opening it. */
export function ControllerWorkspace({ scope, openCase }: { scope: Scope; openCase: (item: string, caseId: string) => void }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('open');
  const [defect, setDefect] = useState('all');
  const [photo, setPhoto] = useState('all');
  const [line, setLine] = useState('all');
  const [limit, setLimit] = useState(40);
  const source = cases.filter(row => row.observations.some(event => inScope(event, scope)));
  const openIds = new Set(tasks.filter(task => task.role === 'controller' && !task.done).map(task => task.item));
  const isOpen = (row: Case) => !['rejected', 'release_after_rework', 'scrap_approved'].includes(row.decisions.at(-1)?.data.decision ?? '') && (!row.decisions.length || openIds.has(row.item));
  const pending = source.filter(isOpen).length;
  const withoutFrame = source.filter(row => !controllerCaseData(row, items.find(item => item.id === row.item)!, mediaIndex).image).length;
  const filtered = source.filter(row => {
    const observation = row.observations.at(-1)!;
    const data = controllerCaseData(row, items.find(item => item.id === row.item)!, mediaIndex);
    const searchable = `${row.id} ${row.item} ${defectNames[row.type] ?? row.type} ${data.regionName} ${observation.event_id}`.toLowerCase();
    return (!query || searchable.includes(query.toLowerCase()))
      && (status === 'all' || (status === 'open' ? isOpen(row) : !isOpen(row)))
      && (defect === 'all' || row.type === defect)
      && (photo === 'all' || (photo === 'yes' ? !!data.image : !data.image))
      && (line === 'all' || observation.line_id === line);
  }).sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.priority - a.priority || a.item.localeCompare(b.item));
  return <div className="controller-workspace">
    <div className="controller-intro"><div><span className="eyebrow">РАБОЧАЯ ОЧЕРЕДЬ ОТК</span><h2>Каждая заявка — отдельный признак и его основания</h2><p>Повторные сообщения об одной зоне объединяются в один случай. Приоритет определяет порядок проверки, а решение записывает контролёр.</p></div><div className="controller-counters"><div><strong>{pending}</strong><span>ждут контролёра</span></div><div><strong>{withoutFrame}</strong><span>без исходного кадра</span></div><div><strong>{source.length}</strong><span>уникальных случаев</span></div></div></div>
    <div className="controller-filterbar"><label className="controller-search"><Icon name="search" size={17}/><input aria-label="Поиск заявки" placeholder="Изделие, случай, событие, дефект…" value={query} onChange={event => { setQuery(event.target.value); setLimit(40); }}/></label><div className="controller-filterselects"><label>Состояние<select value={status} onChange={event => { setStatus(event.target.value); setLimit(40); }}><option value="open">Ждут действия</option><option value="all">Все случаи</option><option value="closed">Без задачи контролёру</option></select></label><label>Признак<select value={defect} onChange={event => { setDefect(event.target.value); setLimit(40); }}><option value="all">Все признаки</option>{Object.entries(defectNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>Кадр<select value={photo} onChange={event => { setPhoto(event.target.value); setLimit(40); }}><option value="all">Любой</option><option value="yes">Есть кадр CV</option><option value="no">Кадр не передан</option></select></label><label>Линия<select value={line} onChange={event => { setLine(event.target.value); setLimit(40); }}><option value="all">Все линии</option><option value="LINE-01">Линия 01</option><option value="LINE-02">Линия 02</option></select></label></div></div>
    <div className="controller-results"><span>Найдено {filtered.length} случаев</span><span>Сначала ожидающие решения и высокий приоритет</span></div>
    {filtered.length ? <div className="controller-cases">{filtered.slice(0, limit).map(row => {
      const product = items.find(item => item.id === row.item)!;
      const data = controllerCaseData(row, product, mediaIndex);
      const observation = data.observation;
      return <button className="controller-case-card" key={row.id} onClick={() => openCase(row.item, row.id)} aria-label={`Открыть заявку ${row.id}`}><CasePicture caseRecord={row} compact/><div className="case-card-main"><div className="case-card-top"><span className="mono">{row.item} · {product.work_order_id}</span><Badge tone={priorityTone(row.priority)}>{priorityLabel(row.priority)}</Badge></div><h3>{defectNames[row.type] ?? row.type} · {data.regionName}</h3><p>{data.componentName} <span>·</span> {stationNames[observation.station_id] ?? observation.station_id} <span>·</span> {time(observation.occurred_at)}</p><div className="case-card-evidence"><span className={data.image ? 'ok' : 'gap'}><Icon name={data.image ? 'check' : 'alert'} size={14}/>{data.image ? 'Кадр CV есть' : 'Исходного кадра нет'}</span><span>Уверенность {data.confidence}</span><span>{row.observations.length} наблюд.</span></div><small>{row.why}</small></div><div className="case-card-end"><Badge tone={row.tone}>{row.status}</Badge><Icon name="arrow" size={19}/></div></button>;
    })}</div> : <Empty title="Заявки не найдены" text="Измените фильтры или выберите другую смену."/>}
    {filtered.length > limit && <button className="button controller-more" onClick={() => setLimit(value => value + 40)}>Показать ещё {Math.min(40, filtered.length - limit)} заявок</button>}
  </div>;
}

function controllerOptions(item: string): [WorkflowAction, string][] {
  const own = eventsFor(item);
  const lastDecision = own.filter(event => event.event_type === 'quality_decision').at(-1);
  const lastMaster = own.filter(event => event.event_type === 'master_action').at(-1);
  const afterMaster = !!lastMaster && (!lastDecision || Date.parse(lastMaster.occurred_at) > Date.parse(lastDecision.occurred_at));
  if (canApproveScrap(item)) return [['scrap', 'Подтвердить списание']];
  if (afterMaster) {
    if (item === 'ITEM-015') return [['confirm', 'Подтвердить после очной проверки'], ['additional', 'Назначить доппроверку']];
    if (item === 'ITEM-016') return [['reject', 'Отклонить исходный признак'], ['confirm', 'Подтвердить дефект']];
    if (item === 'ITEM-014' && own.filter(event => event.event_type === 'master_action').length === 1) return [['recheck_fail', 'Дефект остался · новый круг']];
    return [['release', 'Выпустить после контроля'], ['recheck_fail', 'Дефект остался · новый круг']];
  }
  if (lastDecision?.data.decision === 'additional_check' && !afterMaster) return [];
  if (lastDecision?.data.decision === 'release_after_rework' || lastDecision?.data.decision === 'rejected' || lastDecision?.data.decision === 'scrap_approved') return [];
  if (lastDecision) return [['additional', 'Назначить доппроверку'], ['confirm', 'Подтвердить · направить на доработку'], ['reject', 'Отклонить признак']];
  if (item === 'ITEM-015' || own.some(event => event.data.inspection_result === 'unable_to_assess')) return [['additional', 'Назначить доппроверку']];
  if (item === 'ITEM-016') return [['additional', 'Назначить доппроверку'], ['confirm', 'Подтвердить · направить на доработку']];
  return [['confirm', 'Подтвердить · направить на доработку'], ['additional', 'Назначить доппроверку'], ['reject', 'Отклонить признак']];
}

/** Controller-only case dossier: evidence, data gaps, decision, then source history. */
export function ControllerCaseContent({ item, caseId, onClose, onPassport, onRoleChange }: { item: string; caseId?: string; onClose: () => void; onPassport: () => void; onRoleChange: (role: RoleId) => void }) {
  const product = items.find(row => row.id === item)!;
  const ownCases = cases.filter(row => row.item === item);
  const [selectedId, setSelectedId] = useState(caseId && ownCases.some(row => row.id === caseId) ? caseId : ownCases[0]?.id);
  const selected = ownCases.find(row => row.id === selectedId) ?? ownCases[0];
  const [action, setAction] = useState<WorkflowAction | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  if (!selected) return <Empty title="Заявок по изделию нет" text="Для этого изделия пока нет случая качества."/>;
  const data = controllerCaseData(selected, product, mediaIndex);
  const observation = data.observation;
  const options = controllerOptions(item);
  const chosen = options.find(([key]) => key === action);
  const needInPerson = !data.image || observation.data.observation_quality === 'poor' || (typeof observation.data.confidence === 'number' && observation.data.confidence < 0.6);
  const own = eventsFor(item);
  const masterInspection = own.filter(event => event.event_type === 'master_action' && event.data.action_type === 'inspection_support' && Date.parse(event.occurred_at) > Date.parse(observation.occurred_at)).at(-1);
  const requiresMasterInspection = needInPerson && (action === 'confirm' || action === 'reject') && masterInspection?.data.inspection_result !== (action === 'confirm' ? 'signs_detected' : 'no_signs_detected');
  const supportingPhotos = own.filter(event => event.event_type === 'master_action').flatMap(event => (event.data.evidence_refs ?? []).flatMap(ref => {
    const asset = mediaIndex.find(row => row.asset_id === ref);
    return asset ? [{ event, asset }] : [];
  })).slice(-2);
  const primarySupport = !data.image ? supportingPhotos.at(-1) : undefined;
  const decisions = own.filter(event => event.event_type === 'quality_decision' && event.data.finding_refs?.some(ref => selected.refs.includes(ref)));
  const priorInspection = own.filter(event => event.event_type === 'inspection_result' && Date.parse(event.occurred_at) < Date.parse(observation.occurred_at)).at(-1);
  const preMachineInspection = own.find(event => event.event_type === 'inspection_result' && event.data.inspection_point_id === 'CP-IN' && Date.parse(event.occurred_at) < Date.parse(observation.occurred_at));
  const priorPhoto = mediaIndex.find(asset => preMachineInspection?.data.evidence_refs?.includes(asset.asset_id));
  const finding = observation.data.defects?.find(value => value.defect_type_id === selected.type && value.region === selected.region);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!action || requiresMasterInspection) return;
    try {
      await securePerformAction(item, 'controller', action, reason.trim(), true, selected.id);
      setMessage('Решение записано в защищённый журнал. Очередь, история и задачи обновлены.'); setReason(''); setAction(null);
    }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось записать решение'); }
  };
  return <><div className="drawer-header controller-dossier-header"><div><span className="eyebrow">ЗАЯВКА НА РАССМОТРЕНИЕ · {selected.id}</span><h2>{defectNames[selected.type] ?? selected.type} <span>· {data.regionName}</span></h2><p><strong className="mono">{item}</strong> · заказ {product.work_order_id} · ревизия {product.assembly_revision} · {data.componentName} <span className="mono">{selected.component}</span></p></div><button className="icon-button" aria-label="Закрыть заявку" onClick={onClose}><Icon name="close" size={22}/></button></div>
    <div className="controller-dossier-body">
      {ownCases.length > 1 && <div className="case-switcher" aria-label="Случаи по изделию">{ownCases.map(row => <button key={row.id} className={row.id === selected.id ? 'active' : ''} onClick={() => { setSelectedId(row.id); setAction(null); setMessage(''); }}>{defectNames[row.type] ?? row.type} · {controllerCaseData(row, product, mediaIndex).regionName}</button>)}</div>}
      <div className="dossier-status"><Badge tone={selected.tone}>{selected.status}</Badge><Badge tone={priorityTone(selected.priority)}>{priorityLabel(selected.priority)} приоритет</Badge><span>ОТК · {stationNames[observation.station_id] ?? observation.station_id} · {time(observation.occurred_at)}</span></div>
      <div className="dossier-lead"><div className="dossier-evidence">{priorPhoto && <figure className="dossier-support-photo"><ImagePreview src={mediaUrl(priorPhoto)} alt={`До операции: ${priorPhoto.description}`} title="До операции"/><figcaption><strong>До станка · {time(preMachineInspection!.occurred_at)}</strong><span>{priorPhoto.description}</span></figcaption></figure>}{primarySupport ? <div className="controller-picture"><ImagePreview src={mediaUrl(primarySupport.asset)} alt={`${primarySupport.asset.description} · фото очной проверки`} title="Фото очной проверки"/><span className="picture-label">ФОТО ОЧНОЙ ПРОВЕРКИ · {primarySupport.asset.asset_id}</span></div> : <CasePicture caseRecord={selected}/>} {supportingPhotos.filter(({ asset }) => asset.asset_id !== primarySupport?.asset.asset_id).map(({ event, asset }) => <figure className="dossier-support-photo" key={asset.asset_id}><ImagePreview src={mediaUrl(asset)} alt={`${asset.description} · фото после очной проверки`} title="После работы мастера"/><figcaption><strong>После работы мастера · {time(event.occurred_at)}</strong><span>{asset.description}</span></figcaption></figure>)}<div className={data.image ? 'frame-note available' : 'frame-note missing'}><Icon name={data.image ? 'check' : 'alert'} size={18}/><div><strong>{data.image ? 'Исходный кадр получен' : 'Исходный кадр отсутствует'}</strong><p>{data.image ? data.image.description : supportingPhotos.length ? 'Исходный кадр CV не поступил. Показано отдельное фото очной проверки; сопоставьте его с записью мастера.' : 'Показана только схема зоны из метаданных. Для вывода по изображению запросите кадр или очную проверку.'}</p></div></div></div>
        <div className="dossier-decision"><span className="eyebrow">РЕШЕНИЕ КОНТРОЛЁРА</span><h3>Что делать с заявкой</h3><p>Модель сообщила признак. Подтверждение, доработка и выпуск требуют решения человека с основанием.</p>{options.length ? <><div className="dossier-action-grid">{options.map(([key, label]) => <button type="button" key={key} className={action === key ? 'active' : ''} onClick={() => { setAction(key); setMessage(''); }}>{label}<Icon name="arrow" size={15}/></button>)}</div>{chosen && <form className="dossier-action-form" onSubmit={submit}><strong>{chosen[1]}</strong><label>Автор решения<input value={currentSecurityUser()?.id ?? ''} readOnly/></label><label>Основание и результат<textarea value={reason} onChange={event => setReason(event.target.value)} minLength={5} maxLength={4000} rows={3} required placeholder={data.image ? 'Что видно на кадре и чем проверено…' : 'Укажите основание по записи мастера или направьте изделие на осмотр…'}/></label>{!data.image && <small className="text-amber">Кадр CV не поступил. Очный осмотр выполняет и записывает мастер.</small>}{requiresMasterInspection && <small className="text-amber">Для этого решения нужен соответствующий результат осмотра мастера.</small>}<button className="button primary" type="submit" disabled={reason.trim().length < 5 || requiresMasterInspection}>Записать решение<Icon name="check" size={16}/></button></form>}</> : <div className="dossier-wait">{selected.status === 'Выпуск после контроля' || selected.status === 'Признак отклонён' ? 'Рассмотрение завершено. Основания и решение сохранены ниже.' : 'Следующий шаг ожидает технолога или мастера. После их действия контроль станет доступен здесь.'}</div>}{message && <div role="status" className="dossier-message">{message}</div>}</div></div>
      <div className="dossier-grid"><section className="dossier-panel"><span className="eyebrow">ЧТО ИМЕННО ПРИШЛО ОТ CV</span><h3>Паспорт наблюдения</h3><dl className="dossier-facts"><div><dt>Признак</dt><dd>{defectNames[selected.type] ?? selected.type} · {severityName[selected.severity] ?? selected.severity}</dd></div><div><dt>Зона и деталь</dt><dd>{data.regionName} · {data.componentName}</dd></div><div><dt>Результат модели</dt><dd>{observation.data.inspection_result === 'unable_to_assess' ? 'Не удалось оценить' : 'Обнаружены признаки'}</dd></div><div><dt>Уверенность</dt><dd>{data.confidence}</dd></div><div><dt>Событие</dt><dd className="mono">{observation.event_id} · {data.findingId}</dd></div><div><dt>Источник / версия</dt><dd className="mono">{observation.source_id} · {observation.analyzer_version ?? 'не указана'}</dd></div><div><dt>Камера / ракурс</dt><dd className="mono">{data.camera} · {data.view}</dd></div><div><dt>Свет / калибровка</dt><dd className="mono">{data.lighting} · {data.calibration}</dd></div><div><dt>Операция</dt><dd className="mono">{observation.operation_run_id ?? 'Не привязана'}</dd></div><div><dt>Смена / линия</dt><dd>{observation.shift_id} · {observation.line_id}</dd></div></dl></section>
        <section className="dossier-panel"><span className="eyebrow">ПОЛНОТА ОСНОВАНИЙ</span><h3>Что есть и чего не хватает</h3><div className="evidence-checklist">{data.missing.map(value => <div className="missing" key={value}><Icon name="alert" size={16}/><span>{value}</span></div>)}{data.present.map(value => <div className="present" key={value}><Icon name="check" size={16}/><span>{value}</span></div>)}</div><div className="dossier-context"><strong>Что заметил источник</strong><p>{finding?.description ?? observation.data.observation_summary ?? 'Подробное описание не передано.'}</p>{finding?.observed_feature && <p>Наблюдаемый признак: {finding.observed_feature}.</p>}<strong>Сравнение с предыдущей точкой</strong><p>{observation.data.comparison?.summary ?? 'Сопоставление не передано.'}</p><strong>Предыдущий контроль изделия</strong><p>{priorInspection ? `${stationNames[priorInspection.station_id] ?? priorInspection.station_id} · ${time(priorInspection.occurred_at)} · ${priorInspection.data.inspection_result === 'no_signs_detected' ? 'признаков не выявлено' : priorInspection.data.inspection_result === 'unable_to_assess' ? 'оценить не удалось' : 'есть признаки'}. Другая точка контроля не исключает текущий дефект.` : 'Более раннего результата контроля нет.'}</p>{masterInspection && <><strong>Очный осмотр мастера</strong><p>{String(masterInspection.data.inspection_note ?? masterInspection.data.comment ?? '')}</p></>}<strong>Что проверить дальше</strong><p>{observation.data.next_verification ?? 'Следовать утверждённому маршруту контроля.'}</p><strong>Почему в очереди</strong><p>{selected.why}</p><strong>Повторные наблюдения</strong><p>{selected.observations.length === 1 ? 'Один уникальный результат контроля по этой зоне.' : `${selected.observations.length} уникальных наблюдений объединены в эту заявку. Дубли доставки не создают отдельную запись.`}</p></div></section></div>
      <details className="dossier-history"><summary>Хронология и решения по заявке <span>{selected.observations.length} наблюд. · {decisions.length} решений</span></summary><div>{[...selected.observations, ...decisions].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at)).map(event => <article key={event.event_id}><span className="mono">{time(event.occurred_at)} · {event.event_id}</span><strong>{event.event_type === 'quality_decision' ? decisionNames[event.data.decision ?? ''] : 'Наблюдение CV'}</strong><p>{describeEvent(event)}</p></article>)}</div></details>
      <div className="dossier-links"><button className="button" onClick={onPassport}>Открыть полный паспорт изделия<Icon name="arrow" size={15}/></button><label>Посмотреть в другой роли<select aria-label="Посмотреть изделие в другой роли" value="controller" onChange={event => onRoleChange(event.target.value as RoleId)}>{roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label></div>
      <p className="dossier-footnote">Условная схема не заменяет кадр, замер или очный контроль.</p>
    </div></>;
}
