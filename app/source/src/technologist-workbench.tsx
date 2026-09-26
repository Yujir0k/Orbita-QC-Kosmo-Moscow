import { readWorkspaceValue, saveWorkspaceValue } from './workspace-storage';
import { useEffect, useState } from 'react';
import { Badge, Button, Empty, Icon, ImagePreview, Note } from './ui';
import { causeReviewNeedsRevision, catalogs, defectNames, deliveryFor, describeEvent, eventNames, eventsFor, mediaUrl, resultNames, stationNames, technicalCatalog, time, type Case, type QualityEvent } from './domain';
import { currentSecurityUser, secureRecordCauseReview, secureRequestInvestigationEvidence } from './security-client';
import { confirmedInvestigations, investigationEvidence, investigationStatus, pendingEvidenceRequests } from './technologist-evidence';
import { regionLabel } from './controller-case';
import { HistoricalComparison, VibrationTimeline } from './technologist-comparison';
import { InvestigationChecklist } from './technologist-checklist';
import { telemetryConclusion } from './technologist-assistant';
import { evidenceRecipients, recipientName, type EvidenceRecipient } from './investigation-services';
import type { ViewProps } from './views';

const causeTypes = [
  ['incoming_defect', 'Входной дефект'], ['equipment_deviation', 'Оборудование'],
  ['tooling_or_setup', 'Инструмент / наладка'], ['process_parameters', 'Режим операции'],
  ['procedural_error', 'Нарушение процедуры'], ['handling', 'Перемещение / обращение'],
  ['undetermined', 'Другая / пока не определена'],
] as const;
const tabs = [['facts', 'Обстоятельства'], ['parameters', 'Режимы станка'], ['timeline', 'Хронология'], ['comparison', 'Сравнить операции'], ['conclusion', 'Заключение']] as const;
type DeskTab = typeof tabs[number][0];
function field(value: unknown) { return value == null || value === '' ? 'Не поступило' : String(value); }
function condition(value: unknown) { return ({ checked: 'Проверено, отклонений не отмечено', issue: 'Мастер отметил отклонение', unknown: 'Не проверено', not_applicable: 'Не относится к операции' } as Record<string, string>)[String(value)] ?? 'Не указано'; }
function origin(event: QualityEvent) {
  if (['manual_inspection', 'manual_measurement', 'quality_decision'].includes(event.event_type)) return 'ОТК';
  if (event.event_type === 'master_process_report') return 'Мастер';
  if (event.event_type === 'machine_state') return 'Станок';
  if (event.event_type === 'operator_action') return 'Действие';
  if (event.event_type === 'service_report') return recipientName(event.data.recipient_role);
  if (event.event_type === 'inspection_result') return 'Контроль';
  return 'MES';
}
function historyStatus(record: Case) {
  return causeReviewNeedsRevision(record) ? { label: 'Новые данные — пересмотреть', tone: 'amber' } : investigationStatus(record);
}

interface Draft {
  status: 'hypothesis' | 'confirmed' | 'unknown'; causeType: string; reason: string;
  alternatives: string; missingData: string; actor: string; selected: string[];
}
function loadDraft(record: Case): Draft {
  const facts = investigationEvidence(record);
  const fresh: Draft = { status: 'hypothesis', causeType: '', reason: '', alternatives: '', missingData: facts.missing.join('; '), actor: 'TECH-DEMO', selected: [facts.signal.event_id, facts.confirmedDecision?.event_id].filter((id): id is string => !!id) };
  try {
    const stored = readWorkspaceValue(`orbita-tech-draft-v1:${record.id}`) as Partial<Draft> | null;
    if (stored && typeof stored === 'object' && ['hypothesis', 'confirmed', 'unknown'].includes(stored.status ?? '') && Array.isArray(stored.selected)) {
      return { ...fresh, ...Object.fromEntries(Object.entries(stored).filter(([key, value]) => key === 'status' || (['causeType', 'reason', 'alternatives', 'missingData', 'actor'].includes(key) && typeof value === 'string'))), selected: stored.selected.filter((id: unknown) => typeof id === 'string' && facts.evidence.some(event => event.event_id === id)) };
    }
  } catch { /* Keep a usable empty draft if browser storage is unavailable. */ }
  return fresh;
}

function ReviewForm({ record, onSaved }: { record: Case; onSaved: () => void }) {
  const facts = investigationEvidence(record);
  const [draft, setDraft] = useState(() => loadDraft(record));
  const [notice, setNotice] = useState('');
  const [storageNotice, setStorageNotice] = useState('Черновик сохраняется на сервере');
  const [requestRole, setRequestRole] = useState<EvidenceRecipient>('master');
  const [requestText, setRequestText] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(async () => { try { await saveWorkspaceValue(`orbita-tech-draft-v1:${record.id}`, draft); setStorageNotice('Черновик сохранён на сервере'); } catch (error) { setStorageNotice(error instanceof Error ? error.message : 'Черновик не сохранён'); } }, 700);
    return () => window.clearTimeout(timer);
  }, [draft, record.id]);
  const suggested = telemetryConclusion(record, facts.evidence);
  const change = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const toggle = (id: string) => change('selected', draft.selected.includes(id) ? draft.selected.filter(value => value !== id) : [...draft.selected, id]);
  const submit = async () => {
    try {
      await secureRecordCauseReview({ caseId: record.id, status: draft.status, causeType: draft.causeType, reason: draft.reason, alternatives: draft.alternatives, missingData: draft.missingData, basisEventIds: draft.selected, actor: draft.actor });
      onSaved();
      setNotice('Вывод сохранён в истории. Исходный сигнал и решение ОТК сохранены отдельно.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Не удалось сохранить заключение'); }
  };
  const request = async () => {
    try {
      await secureRequestInvestigationEvidence(record.id, requestRole, requestText);
      setRequestText(''); setNotice('Запрос появился в очереди выбранной роли.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Не удалось создать запрос'); }
  };
  return <section className="tech-analysis">
    <div className="tech-card-heading"><span className="eyebrow">ЗАКЛЮЧЕНИЕ ТЕХНОЛОГА</span><h3>Что связано с возникновением дефекта?</h3><p>Опишите связь, проверьте альтернативы и выберите события, на которых основан вывод.</p></div>
    <Button icon="forecast" disabled={!suggested} onClick={() => { if (suggested) { setDraft(current => ({ ...current, ...suggested })); setNotice('Заполнено по телеметрии и протоколам проверки. Проверьте обоснование и альтернативы перед записью.'); } }}>Заполнить по телеметрии и историческим аналогам</Button>
    {!suggested && <p className="helper-text">Для автозаполнения установленной причины нужен связанный протокол диагностики и проверка альтернатив. Сейчас их нет.</p>}
    {record.review && <div className="tech-prior-review"><Badge tone={historyStatus(record).tone}>{historyStatus(record).label}</Badge><p>{record.review.data.reason}</p><small>{record.review.actor_id} · {time(record.review.occurred_at)}</small></div>}
    <div className="tech-form-pair">
      <label>Статус вывода<select aria-label="Статус вывода" value={draft.status} onChange={event => change('status', event.target.value as Draft['status'])}><option value="hypothesis">Гипотеза — требуется проверка</option><option value="confirmed">Причина установлена</option><option value="unknown">Причина не установлена</option></select></label>
      <label>Категория причины<select aria-label="Категория причины" disabled={draft.status === 'unknown'} value={draft.causeType} onChange={event => change('causeType', event.target.value)}><option value="">Выберите категорию</option>{causeTypes.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    </div>
    <label>Обоснование<textarea aria-label="Обоснование" value={draft.reason} onChange={event => change('reason', event.target.value)} rows={4} placeholder="Что показывают события и почему этого достаточно или недостаточно для вывода?"/></label>
    <label>Проверенные альтернативы<textarea aria-label="Проверенные альтернативы" value={draft.alternatives} onChange={event => change('alternatives', event.target.value)} rows={2} placeholder="Например: дефект мог быть на входе; предупреждение станка могло быть несвязанным"/></label>
    <label>Недостающие сведения<textarea aria-label="Недостающие сведения" value={draft.missingData} onChange={event => change('missingData', event.target.value)} rows={2}/></label>
    <div className="tech-basis"><strong>Основания · выбрано {draft.selected.length}</strong><small>Два события не доказывают причину автоматически. Технолог отвечает за обоснование связи и проверку альтернатив.</small><div className="tech-basis-list">{facts.evidence.map(event => <label key={event.event_id}><input type="checkbox" checked={draft.selected.includes(event.event_id)} onChange={() => toggle(event.event_id)}/><span><b>{origin(event)}</b> · {time(event.occurred_at)}<small>{event.event_id} · {describeEvent(event)}</small></span></label>)}</div></div>
    <label>Автор заключения<input aria-label="Автор заключения" value={currentSecurityUser()?.id ?? 'Текущая роль технолога'} readOnly/></label>
    <div className="tech-save-row"><button className="button primary tech-save" type="button" onClick={submit}>Записать вывод<Icon name="check" size={16}/></button><small>{storageNotice}</small></div>
    <div className="tech-request"><strong>Запросить уточнение</strong><p>Запрос сохраняется в деле. Ответ мастера сообщает факты, а вывод оформляет технолог. Службы ОГМ и ЦЗЛ пока не подключены к автоматическому обмену.</p><div className="tech-request-row"><select aria-label="Кому направить запрос" value={requestRole} onChange={event => setRequestRole(event.target.value as typeof requestRole)}>{Object.entries(evidenceRecipients).map(([id, recipient]) => <option key={id} value={id}>{recipient.label}</option>)}</select><Button onClick={request} disabled={requestText.trim().length < 8}>Запросить</Button></div><textarea aria-label="Что необходимо уточнить" value={requestText} onChange={event => setRequestText(event.target.value)} rows={2} placeholder="Укажите конкретный факт, который нужно проверить…"/></div>
    {notice && <p className="tech-form-notice" role="status">{notice}</p>}
    <details className="tech-review-history"><summary>История выводов и запросов</summary>{eventsFor(record.item).filter(event => event.data.case_id === record.id && ['cause_review', 'evidence_request'].includes(event.event_type)).map(event => <article key={event.event_id}><strong>{eventNames[event.event_type]} · {event.data.status === 'confirmed' ? 'Причина установлена' : event.data.status === 'unknown' ? 'Не установлена' : event.data.status === 'hypothesis' ? 'Гипотеза' : 'Запрос'}</strong><p>{event.data.reason}</p><small>{event.actor_id} · {time(event.occurred_at)} · {event.event_id}</small></article>)}</details>
  </section>;
}

function ParameterPanel({ record }: { record: Case }) {
  const facts = investigationEvidence(record);
  const samples = facts.machine.filter(event => event.data.profile_id === 'MILL-BRACKET-A');
  const profile = technicalCatalog.profiles[0];
  if (!facts.start) return <Empty title="Нет операции до обнаружения" text="Это входной случай. Режимы станка не относятся к имеющимся основаниям."/>;
  return <section className="tech-info-card"><div className="tech-card-heading"><span className="eyebrow">МАШИННЫЙ ЖУРНАЛ · {facts.runId}</span><h3>Фактические параметры и регламент контроля</h3><p>Каждый образец связан с запуском, временем и единицей измерения. Пределы приводятся по профилю контроля операции.</p></div>
    <VibrationTimeline record={record}/>
    {samples.length ? <><div className="tech-parameter-grid">{profile.parameters.map(parameter => {
      const values = samples.map(event => event.data[parameter.key]).filter((value): value is number => typeof value === 'number');
      const breached = values.some(value => value < parameter.lower || value > parameter.upper);
      return <article key={parameter.key} className={breached ? 'is-warning' : ''}><small>{parameter.label}</small><strong>{values.length ? `${Math.min(...values)}–${Math.max(...values)}` : 'Нет данных'} <em>{parameter.unit}</em></strong><span>{parameter.key === "vibration_velocity_rms_mm_s" ? "Допуск по ТУ" : "Контрольный интервал"}: {parameter.lower}–{parameter.upper}{parameter.key === "vibration_velocity_rms_mm_s" ? " мм/с" : ""}</span><Badge tone={breached ? 'amber' : 'blue'}>{breached ? 'Есть выход из интервала' : 'В контрольном интервале'}</Badge></article>;
    })}</div><div className="table-wrap tech-samples"><table><thead><tr><th>Время образца</th>{profile.parameters.map(parameter => <th key={parameter.key}>{parameter.label}<small>{parameter.unit}</small></th>)}<th>Нагрузка</th></tr></thead><tbody>{samples.map(event => <tr key={event.event_id}><td>{time(event.occurred_at)}<small>{event.event_id}</small></td>{profile.parameters.map(parameter => <td key={parameter.key} className={typeof event.data[parameter.key] === 'number' && (Number(event.data[parameter.key]) < parameter.lower || Number(event.data[parameter.key]) > parameter.upper) ? 'text-amber' : ''}>{field(event.data[parameter.key])}</td>)}<td>{typeof event.data.spindle_load_peak_pct === 'number' ? `${event.data.spindle_load_peak_pct}%` : 'Не поступило'}</td></tr>)}</tbody></table></div></> : <Note tone="amber">Образцы режима ещё не поступили. В деле сохранены доступные предупреждения и другие факты.</Note>}
    {facts.machine.filter(event => event.data.state === 'warning').map(event => <div className="tech-warning-event" key={event.event_id}><Icon name="alert" size={17}/><div><strong>{time(event.occurred_at)} · {field(event.data.alarm_code ?? event.data.parameter ?? 'Предупреждение')}</strong><p>{describeEvent(event)}</p><small>{event.source_id} · {event.event_id}</small></div></div>)}
    <Note tone="amber">Предупреждение станка — обстоятельство операции. Его причинную связь с дефектом нужно обосновать отдельно.</Note>
  </section>;
}

function ComparisonPanel({ record, openPassport }: { record: Case; openPassport: (item: string) => void }) {
  const facts = investigationEvidence(record);
  if (facts.runId === 'RUN-007-MILLING-1') return <HistoricalComparison record={record}/>;
  const loads = facts.peers.map(peer => peer.sample?.data.spindle_load_peak_pct).filter((value): value is number => typeof value === 'number');
  const median = loads.length >= 3 ? [...loads].sort((a, b) => a - b)[Math.floor(loads.length / 2)] : undefined;
  return <section className="tech-info-card"><div className="tech-card-heading"><span className="eyebrow">СОПОСТАВИМЫЕ ЗАПУСКИ</span><h3>Тот же станок, программа и операция</h3><p>Сравниваются только принятые завершённые запуски того же изделия по типу, ревизии программы и первичной либо повторной обработке. Ближайшие по времени — наверху.</p></div>
    {facts.peers.length ? <><div className="table-wrap"><table><thead><tr><th>Изделие / запуск</th><th>Время</th><th>Длительность</th><th>Нагрузка</th><th>Контроль</th></tr></thead><tbody>{facts.peers.map(peer => <tr key={peer.operation.id}><td><button className="cell-link" onClick={() => openPassport(peer.operation.item)}>{peer.operation.item}</button><small>{peer.operation.id}</small></td><td>{time(peer.operation.start)}</td><td>{peer.operation.duration ?? '—'} мин</td><td>{peer.sample?.data.spindle_load_peak_pct != null ? `${peer.sample.data.spindle_load_peak_pct}%` : 'Не передана'}</td><td>{peer.inspection ? resultNames[peer.inspection.data.inspection_result ?? ''] : 'Не поступил'}</td></tr>)}</tbody></table></div><p className="tech-source-line">{median == null ? 'Измерений пока мало для сводного значения.' : `Медиана пика нагрузки в ${loads.length} сопоставимых запусках: ${median}%. Это описательная статистика, не норматив.`}</p></> : <Note>В истории этого случая пока нет завершённых аналогов с тем же станком и версией программы. Архив фрезерования доступен в деле ITEM-007; он не относится к входным дефектам и другим режимам.</Note>}
  </section>;
}

function FactsPanel({ record }: { record: Case }) {
  const facts = investigationEvidence(record);
  const operation = { ...facts.start?.data, ...facts.context?.data };
  const regimeSample = facts.machine.filter(event => typeof event.data.spindle_speed_rpm === 'number').sort((a,b) => Number(b.data.vibration_index ?? 0)-Number(a.data.vibration_index ?? 0))[0];
  const machine = facts.machine.filter(event => event.data.spindle_load_peak_pct != null || event.data.tool_life_used_min != null).at(-1);
  return <>
    <div className="tech-evidence-grid"><section className="tech-evidence-card"><span className="eyebrow">01 · ДО СИГНАЛА</span><h3>{facts.before ? resultNames[facts.before.data.inspection_result ?? ''] : 'Предыдущего контроля нет'}</h3><p>{facts.before ? `${time(facts.before.occurred_at)} · ${facts.before.data.inspection_point_id} · обзор ${facts.before.data.observation_quality === 'good' ? 'достаточный' : 'ограничен'}` : 'Предыдущего наблюдения нет. Проверьте сведения о поступлении изделия.'}</p><small>{facts.before?.event_id ?? 'Источник не поступил'}</small></section><section className="tech-evidence-card"><span className="eyebrow">02 · ОПЕРАЦИЯ</span><h3>{facts.start ? catalogs.operations.find(entry => entry.id === operation?.operation_id)?.name ?? String(operation?.operation_id) : 'Входной контроль'}</h3><p>{facts.start ? `${time(facts.start.occurred_at)} → ${facts.finish ? time(facts.finish.occurred_at) : 'не завершена'} · ${facts.start.equipment_id ?? 'станок не указан'}` : 'Связанная операция до сигнала не найдена.'}</p><small>{facts.runId ?? 'Операции нет'}</small></section><section className="tech-evidence-card"><span className="eyebrow">03 · СИГНАЛ И ПРОВЕРКА</span><h3>{defectNames[record.type]}</h3><p>{time(facts.signal.occurred_at)} · {facts.signal.data.observation_quality === 'good' ? 'достаточный обзор' : 'обзор ограничен'} · {facts.inspectionNotes.length ? 'есть осмотр ОТК' : 'очный осмотр не записан'}</p><small>{facts.signal.event_id} · {facts.signal.source_id}</small></section></div>
    <Note>Предыдущий контроль относится к изделию. Одинаковая зона и ракурс не всегда подтверждены; отсутствие признака ранее не исключает скрытый входной дефект.</Note>
    <div className="tech-evidence-columns"><section className="tech-info-card"><div className="tech-card-heading"><span className="eyebrow">MES / МАШИННЫЙ ЖУРНАЛ</span><h3>Условия операции</h3></div><dl className="tech-detail-list"><div><dt>Запуск</dt><dd>{facts.runId ?? 'Нет'}</dd></div><div><dt>Оператор / станок</dt><dd>{field(facts.context?.data.executor_id ?? facts.start?.actor_id)} / {field(facts.start?.equipment_id)}</dd></div><div><dt>Программа</dt><dd>{field(operation.program_name ?? operation.program_id)}</dd></div><div><dt>Ревизия / режим</dt><dd>{field(operation.program_revision)} · {regimeSample ? `Шпиндель ${regimeSample.data.spindle_speed_rpm} об/мин · Подача ${regimeSample.data.feed_rate_mm_min} мм/мин` : "По технологической карте"}</dd></div><div><dt>Инструмент</dt><dd>{field(operation.tool_name ?? operation.tool_id)}</dd></div><div><dt>Оснастка</dt><dd>{field(operation.fixture_name ?? operation.fixture_id)}</dd></div><div><dt>Пиковая нагрузка / наработка</dt><dd>{machine?.data.spindle_load_peak_pct == null ? 'Не поступило' : `${machine.data.spindle_load_peak_pct}%`} / {machine?.data.tool_life_used_min == null ? 'Не поступило' : `${machine.data.tool_life_used_min} мин`}</dd></div><div><dt>Образцы / предупреждения</dt><dd>{facts.machine.length} / {facts.machine.filter(event => event.data.state === 'warning').length}</dd></div></dl><small className="tech-source-line">Телеметрия не является измерением размера детали. Полные параметры доступны во вкладке «Режимы станка».</small></section>
      <section className="tech-info-card"><div className="tech-card-heading"><span className="eyebrow">СВЕДЕНИЯ ОТ МАСТЕРА</span><h3>Факты с участка</h3></div>{facts.masterReports.length ? facts.masterReports.map(report => <div className="tech-master-report" key={report.event_id}><dl className="tech-detail-list"><div><dt>Оснастка</dt><dd>{condition(report.data.fixture_condition)}</dd></div><div><dt>Инструмент</dt><dd>{condition(report.data.tool_condition)}</dd></div><div><dt>Наладка менялась</dt><dd>{report.data.setup_changed === 'yes' ? 'Да' : report.data.setup_changed === 'no' ? 'Нет' : 'Неизвестно'}</dd></div></dl><p>{report.data.comment}</p><small>{report.actor_id} · {time(report.occurred_at)} · {report.event_id}</small></div>) : <div className="tech-missing-report"><Icon name="help" size={22}/><strong>Сведения не переданы</strong><p>Запросите у мастера факты об инструменте, оснастке и наладке через вкладку «Заключение».</p></div>}</section></div>
    <div className="tech-evidence-columns"><section className="tech-info-card"><div className="tech-card-heading"><span className="eyebrow">РЕЗУЛЬТАТ ОСМОТРА ОТК</span><h3>Чем подтверждён дефект</h3></div>{facts.inspectionNotes.map(note => <article className="tech-master-report" key={note.event_id}><p>{note.data.reason}</p><small>{note.actor_id} · {time(note.occurred_at)} · {note.event_id}</small></article>)}{!facts.inspectionNotes.length && <p className="tech-no-image">Отдельный результат очного осмотра не записан; основание подтверждения указано в решении ОТК.</p>}{facts.measurements.map(measurement => <p key={measurement.event_id}>Замер: {field(measurement.data.feature_id)} · {field(measurement.data.measured_value)} {field(measurement.data.unit)} · прибор {field(measurement.data.instrument_id)}</p>)}{facts.image ? <figure className="tech-evidence-image"><ImagePreview src={mediaUrl(facts.image)} alt={facts.image.description} title={facts.image.description}/><figcaption>{facts.image.description}</figcaption></figure> : <p className="tech-no-image">Исходного кадра нет. Причину можно исследовать по другим основаниям; изображение не подставляется.</p>}</section>
      <section className="tech-info-card"><div className="tech-card-heading"><span className="eyebrow">ОГРАНИЧЕНИЯ ВЫВОДА</span><h3>Проверить перед заключением</h3></div><InvestigationChecklist record={record}/></section></div>
  </>;
}

function Dossier({ record, openPassport, initialTab, onSaved }: { record: Case; openPassport: (item: string) => void; initialTab: DeskTab; onSaved: () => void }) {
  const facts = investigationEvidence(record);
  const [activeTab, setActiveTab] = useState<DeskTab>(initialTab);
  const [eventQuery, setEventQuery] = useState('');
  const state = historyStatus(record);
  const requests = pendingEvidenceRequests(record);
  const timeline = facts.evidence.filter(event => `${event.event_id} ${event.source_id} ${event.actor_id ?? ''} ${event.equipment_id ?? ''} ${describeEvent(event)}`.toLowerCase().includes(eventQuery.toLowerCase()));
  return <div className="tech-dossier"><div className="tech-dossier-scroll">
    <div className="tech-dossier-top"><div><span className="eyebrow">ПОДТВЕРЖДЁННЫЙ СЛУЧАЙ · {record.id}</span><h2>{defectNames[record.type]} <span>· {record.item}</span></h2><p>{regionLabel(record.region)} · {record.component} · {stationNames[facts.signal.station_id]}</p></div><div className="tech-dossier-actions"><Badge tone={state.tone}>{state.label}</Badge><Button onClick={() => openPassport(record.item)}>Паспорт изделия</Button></div></div>
    <div className="tech-confirmation"><Icon name="quality" size={20}/><div><strong>ОТК подтвердил дефект</strong><p>{facts.confirmedDecision?.data.reason}</p><small>{facts.confirmedDecision?.actor_id} · {facts.confirmedDecision ? time(facts.confirmedDecision.occurred_at) : '—'} · {facts.confirmedDecision?.event_id}</small></div><Badge tone="muted">Цеховой контур №1</Badge></div>
    {requests.length > 0 && <div className="tech-pending-request"><Icon name="clock" size={17}/><span>Ожидаются ответы: {requests.map(request => `${recipientName(request.data.recipient_role)} — ${request.data.reason}`).join('; ')}</span></div>}
    <div className="tech-case-tabs" role="tablist" aria-label="Инструменты расследования">{tabs.map(([id, label]) => <button role="tab" id={`tech-tab-${id}`} aria-controls={`tech-panel-${id}`} aria-selected={activeTab === id} key={id} onClick={event => { setActiveTab(id); event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'center' }); }}>{label}</button>)}</div>
    <div role="tabpanel" id={`tech-panel-${activeTab}`} aria-labelledby={`tech-tab-${activeTab}`}>
      {activeTab === 'facts' && <FactsPanel record={record}/>}
      {activeTab === 'parameters' && <ParameterPanel record={record}/>}
      {activeTab === 'comparison' && <ComparisonPanel record={record} openPassport={openPassport}/>}
      {activeTab === 'timeline' && <section className="tech-info-card"><div className="tech-card-heading"><h3>События, относящиеся к этому дефекту</h3><p>Время события и время доставки различаются; исходные сообщения доступны под каждой записью.</p></div><input aria-label="Поиск в хронологии" value={eventQuery} onChange={event => setEventQuery(event.target.value)} placeholder="Источник, ID, оператор, факт…" className="tech-timeline-search"/><div className="tech-case-timeline">{timeline.map(event => <article key={event.event_id}><span className="tech-event-origin">{origin(event)}</span><div><strong>{eventNames[event.event_type]} · {time(event.occurred_at)}</strong><p>{describeEvent(event)}</p><small>{event.source_id} · {event.actor_id ?? 'Автоматический источник'} · {event.event_id}<br/>Доставлено: {deliveryFor(event.event_id) ? time(deliveryFor(event.event_id)!.deliver_at) : 'Не указано'}</small><details><summary>Исходное сообщение</summary><pre>{JSON.stringify(event, null, 2)}</pre></details></div></article>)}{!timeline.length && <p>Событий по запросу нет.</p>}</div></section>}
      <div hidden={activeTab !== 'conclusion'}><ReviewForm record={record} onSaved={onSaved}/></div>
    </div>
    </div>{activeTab !== 'conclusion' && <div className="tech-dossier-footer"><span><strong>Вывод оформляет технолог</strong><small>Статус ОТК и причина остаются раздельными</small></span><Button primary onClick={() => setActiveTab('conclusion')}>Оформить вывод / запрос</Button></div>}
  </div>;
}

export function TechnologistWorkbench({ route, scope, openItem, openCase }: ViewProps) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState(route.caseId ? 'all' : 'open');
  const [defectFilter, setDefectFilter] = useState('all');
  const [imageFilter, setImageFilter] = useState('all');
  useEffect(() => {
    if (route.caseId) { setStatusFilter('all'); setDefectFilter('all'); setImageFilter('all'); setQuery(''); }
  }, [route.caseId]);
  const all = confirmedInvestigations();
  const scoped = all.filter(record => scope === 'all' || record.observations.some(event => event.shift_id === scope));
  const filtered = scoped.filter(record => {
    const facts = investigationEvidence(record);
    const isOpen = !['confirmed', 'unknown'].includes(record.review?.data.status ?? '') || causeReviewNeedsRevision(record);
    return (statusFilter === 'all' || (statusFilter === 'open' && isOpen) || (statusFilter === 'waiting' && pendingEvidenceRequests(record).length > 0) || record.review?.data.status === statusFilter)
      && (defectFilter === 'all' || record.type === defectFilter)
      && (imageFilter === 'all' || (imageFilter === 'yes' ? !!facts.image : !facts.image))
      && `${record.id} ${record.item} ${defectNames[record.type]} ${regionLabel(record.region)} ${facts.runId ?? ''} ${facts.start?.equipment_id ?? ''} ${facts.context?.data.executor_id ?? facts.start?.actor_id ?? ''} ${facts.start?.data.program_id ?? ''}`.toLowerCase().includes(query.toLowerCase());
  });
  const selected = filtered.find(record => record.id === route.caseId) ?? filtered[0];
  const initialTab: DeskTab = route.section === 'equipment' ? 'parameters' : route.section === 'comparison' ? 'comparison' : route.section === 'procedure' ? 'timeline' : 'facts';
  return <div className="tech-workbench"><aside className="tech-queue"><div className="tech-queue-heading"><span className="eyebrow">ОТК ПОДТВЕРДИЛ ДЕФЕКТ</span><h2>Очередь расследований <b>{scoped.length}</b></h2><p>Выберите случай. Исследуйте обстоятельства и сохраните отдельный вывод.</p></div><label className="tech-search"><Icon name="search" size={17}/><input aria-label="Найти расследование" value={query} onChange={event => setQuery(event.target.value)} placeholder="Изделие, станок, запуск…"/></label><div className="tech-queue-filters"><select aria-label="Статус расследования" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="open">Нужен разбор</option><option value="all">Все</option><option value="waiting">Ожидают ответа</option><option value="hypothesis">Гипотезы</option><option value="confirmed">Причина установлена</option><option value="unknown">Не установлена</option></select><select aria-label="Тип дефекта" value={defectFilter} onChange={event => setDefectFilter(event.target.value)}><option value="all">Все дефекты</option>{Object.entries(defectNames).filter(([id]) => id !== 'UNASSESSABLE').map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><select aria-label="Наличие изображения" value={imageFilter} onChange={event => setImageFilter(event.target.value)}><option value="all">Любые изображения</option><option value="yes">Есть изображение</option><option value="no">Без изображения</option></select><span className="tech-filter-count">{filtered.length} из {scoped.length}</span></div><div className="tech-queue-list">{filtered.map(record => { const state = historyStatus(record); return <button key={record.id} type="button" aria-current={selected?.id === record.id ? 'true' : undefined} onClick={() => openCase(record.item, record.id)}><span className="tech-queue-row"><strong>{record.item}</strong><Badge tone={state.tone === 'green' ? 'green' : record.severity === 'critical' ? 'red' : 'amber'}>{state.tone === 'green' ? state.label : record.severity === 'critical' ? 'Критичный' : 'Подтверждён'}</Badge></span><span>{defectNames[record.type]} · {regionLabel(record.region)}</span><small>{state.label} · {stationNames[record.observations[0].station_id]}</small></button>; })}{!filtered.length && <Empty title={scoped.length ? 'Нет совпадений' : 'Подтверждённых случаев пока нет'} text={scoped.length ? 'Измените поиск или фильтры.' : 'После решения ОТК здесь появится расследование.'}/>}</div></aside><div className="tech-work-area">{selected ? <Dossier key={selected.id} record={selected} openPassport={openItem} initialTab={initialTab} onSaved={() => setStatusFilter('all')}/> : <div className="tech-start-empty"><Icon name="investigation" size={42}/><h2>{scoped.length ? 'Нет дел по выбранным условиям' : 'Ожидаем подтверждения ОТК'}</h2><p>{scoped.length ? 'Измените фильтр статуса, типа дефекта или поиск.' : 'Когда контролёр запишет решение, случай появится здесь вместе с принятой производственной историей.'}</p>{scoped.length > 0 && <Button onClick={() => { setStatusFilter('all'); setDefectFilter('all'); setImageFilter('all'); setQuery(''); }}>Показать все дела</Button>}</div>}</div></div>;
}
