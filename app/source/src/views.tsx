import { useState } from 'react';
import { Badge, Button, Empty, Icon, ImagePreview, Metric, Note, Panel, ProductDrawing } from './ui';
import { canAccess, moduleById, roles, roleById, sectionsFor, type ModuleId, type RoleId, type Route, type Section } from './navigation';
import { causeReviewNeedsRevision, cases, catalogs, decisionNames, defectNames, deliveryFor, describeEvent, events, eventNames, eventsFor, ingestState, inScope, inspectionPlan, items, mediaFor, mediaUrl, metrics, operations, productStatus, profiles, resultNames, stationNames, tasks, time, type Case, type Scope } from './domain';
import { EventReplayView, IngestOutcomes, SmartQueue } from './live-views';
import { ControllerCockpit } from './controller-cockpit';
import { MasterTerminal } from './master-terminal';
import { projectRegistryRow, type RegistryGroup } from './product-registry';
import { AdminCadView, AdminExchangeView, AdminMappingsView, AdminMesView } from './admin-integrations';
import { AdminContractsView } from './admin-contracts';
import { AdminOverview } from './admin-overview';
import { AdminHealthView, SecurityBackupView, SecurityCryptoView, SecuritySessionsPanel } from './admin-operations';
import { SecurityAuditView } from './security-ui';
import { MobileOpsView } from './mobileops-ui';
import { TechnologistWorkbench } from './technologist-workbench';
import { TechnologistAnalyticsView } from './technologist-analytics-view';
import { RoleAnalyticsView } from './role-analytics-view';
import { ProductionHeadView } from './ProductionHeadView';
import { pendingEvidenceRequests } from './technologist-evidence';
import { recipientName } from './investigation-services';
import { productSpecification } from './product-catalog';
import { DataQualityView } from './data-quality-view';
import planet from './assets/planet-orbita.webp';

export type Navigate = (module: ModuleId, section?: string, item?: string) => void;
export interface ViewProps { route: Route; scope: Scope; navigate: Navigate; openItem: (id: string) => void; openCase: (item: string, caseId: string) => void; changeRole: (role: RoleId, module?: ModuleId) => void }

function CaseTable({ data, openItem, openCase }: { data: Case[]; openItem: (id: string) => void; openCase?: (item: string, caseId: string) => void }) {
  const open = (row: Case) => openCase ? openCase(row.item, row.id) : openItem(row.item);
  return data.length ? <div className="table-wrap"><table><thead><tr><th>Случай / изделие</th><th>Наблюдение</th><th>Рассмотрение</th><th>Причина</th><th><span className="sr-only">Открыть</span></th></tr></thead><tbody>{data.map(c => <tr key={c.id}><td><button className="cell-link mono" onClick={() => open(c)}>{c.id}</button><small>{c.item}</small></td><td><strong>{defectNames[c.type]}</strong><small>{stationNames[c.observations[0].station_id]} · {c.observations.length} набл.</small></td><td><Badge tone={c.tone}>{c.status}</Badge></td><td><span className={c.review?.data.status === 'confirmed' ? 'text-green' : 'text-sub'}>{c.review?.data.status === 'confirmed' ? 'Установлена' : c.review ? 'Гипотеза' : 'Не установлена'}</span></td><td><button className="icon-button" aria-label={`Открыть ${c.id}`} onClick={() => open(c)}><Icon name="arrow" size={17} /></button></td></tr>)}</tbody></table></div> : <Empty title="В этом срезе случаев нет" text="Измените смену или условия отбора." />;
}

const homeStory: Record<RoleId, { eyebrow: string; title: string; text: string; cta: string; module: ModuleId; section?: string; item?: string }> = {
  controller: { eyebrow: 'ОТ ПРИЗНАКА К РЕШЕНИЮ', title: 'У каждого вывода\nесть основание.', text: 'Сигналы, контекст операции и история проверок — в одной карточке изделия.', cta: 'Открыть контроль качества', module: 'quality' },
  master: { eyebrow: 'ПРОИЗВОДСТВО В ФОКУСЕ', title: 'Видеть отклонение.\nОрганизовать действие.', text: 'Приостановленные операции, карантин и доработка собраны в рабочем пространстве участка.', cta: 'Открыть пульт участка', module: 'operations' },
  technologist: { eyebrow: 'ПОНИМАТЬ ПРИЧИНЫ', title: 'Факты складываются\nв полную картину.', text: 'Сопоставляйте контроль до и после, журналы оборудования и действия на операции.', cta: 'Открыть расследования', module: 'investigation' },
  leader: { eyebrow: 'УПРАВЛЯТЬ НА ОСНОВЕ ДАННЫХ', title: 'Качество в деталях.\nПроизводство целиком.', text: 'От общего показателя до конкретного изделия, решения и подтверждающих событий.', cta: 'Исследовать показатели', module: 'executive' },
  administrator: { eyebrow: 'ЕДИНЫЙ ПРОИЗВОДСТВЕННЫЙ КОНТУР', title: 'Связанные системы.\nПрослеживаемые данные.', text: 'Источники, обмен, права доступа и состояние компонентов собраны в одном месте.', cta: 'Открыть центр интеграций', module: 'integrations' },
};

export function HomeView(props: ViewProps) {
  const { route, scope, navigate, openItem, openCase } = props;
  const role = route.role;
  const m = metrics(scope);
  const story = homeStory[role];
  const relevantTasks = tasks.filter(t => inScope(t.event, scope) && (role === 'leader' || t.role === role) && !t.done);
  const visibleCases = cases.filter(c => c.observations.some(e => inScope(e, scope)));
  const focusItem = relevantTasks[0]?.item ?? visibleCases.find(c => role !== 'technologist' || c.confirmed)?.item ?? events.find(e => inScope(e, scope))?.item_id;
  const focusCases = visibleCases.filter(c => c.item === focusItem);
  const focusProduct = items.find(item => item.id === focusItem);
  const focusReview = focusCases.map(c => c.review).filter(review => !!review).at(-1);
  const intake = ingestState();
  return <>
    {role === 'administrator' && <AdminOverview navigate={navigate}/>}
    <div className="hero">
      <div className="hero-copy"><span className="eyebrow"><i />{story.eyebrow}</span><h2>{story.title}</h2><p>{story.text}</p><Button primary onClick={() => navigate(story.module, story.section)}>{story.cta}</Button></div>
      <div className="hero-orbit" aria-hidden="true"><div className="orbital-ring ring-one"/><div className="orbital-ring ring-two"/><img src={planet} alt=""/><span className="orbit-label">ОРБИТА / КОНТУР КАЧЕСТВА</span><span className="orbit-cross">+</span></div>
      <div className="hero-stamp"><span className="status-dot"/>УЧЕБНЫЙ КОНТУР<span className="mono">01 / QC</span></div>
    </div>
    <div className="metric-grid">
      {role === 'administrator' ? <>
        <Metric label="Источники в наборе" value={new Set(events.map(e => e.source_id)).size} note="Синтетические события" icon="source" onClick={() => navigate('platform', 'topology')} />
        <Metric label="События" value={m.events} note="После исключения дубля доставки" icon="events" onClick={() => navigate('events')} />
        <Metric label="Профили в наборе" value={profiles.length} note="Состояние подключений — в центре интеграций" icon="integrations" onClick={() => navigate('integrations')} />
        <Metric label="Рабочие роли" value={roles.length} note="Права и области доступа" icon="users" onClick={() => navigate('platform', 'users')} />
      </> : role === 'master' ? <>
        <Metric label="Изделия в срезе" value={m.items} note="По производственным событиям" icon="products" onClick={() => navigate('products')} />
        <Metric label="Незавершённые операции" value={m.unfinished} note="Требуют внимания мастера" icon="clock" tone="amber" onClick={() => navigate('operations')} />
        <Metric label="Повторные запуски" value={m.rework} note="Связаны с первичной обработкой" icon="branch" onClick={() => navigate('operations')} />
        <Metric label="Открытые действия" value={relevantTasks.length} note="Из фактов учебной смены" icon="tasks" tone="red" onClick={() => navigate('operations')} />
      </> : role === 'technologist' ? <>
        <Metric label="Подтверждённые случаи" value={visibleCases.filter(c => c.confirmed).length} note="Каждый дефект — отдельное дело" icon="quality" onClick={() => navigate('investigation')}/>
        <Metric label="Нужен разбор" value={visibleCases.filter(c => c.confirmed && (!['confirmed', 'unknown'].includes(c.review?.data.status ?? '') || causeReviewNeedsRevision(c))).length} note="Без вывода, гипотезы и новые данные" icon="investigation" tone="amber" onClick={() => navigate('investigation')}/>
        <Metric label="Ожидают сведений" value={visibleCases.filter(c => c.confirmed && pendingEvidenceRequests(c).length > 0).length} note="Открытые запросы" icon="clock" onClick={() => navigate('tasks')}/>
        <Metric label="Причина установлена" value={visibleCases.filter(c => c.confirmed && c.review?.data.status === 'confirmed' && !causeReviewNeedsRevision(c)).length} note="Актуальные заключения" icon="check" tone="green" onClick={() => navigate('analytics', 'causes')}/>
      </> : <>
        <Metric label="Проверено изделий" value={m.inspected} note="С оцениваемым наблюдением" icon="quality" tone="green" onClick={() => navigate('products')} />
        <Metric label="Изделия с дефектами" value={m.defectiveItems} note="За всю историю выбранной смены" icon="products" tone="red" onClick={() => navigate('analytics')} />
        <Metric label="Подтверждённые дефекты" value={m.defects} note="Повторные наблюдения объединены" icon="investigation" tone="amber" onClick={() => navigate('analytics')} />
        <Metric label={role === 'controller' ? 'Ожидают решения' : 'Причина не установлена'} value={role === 'controller' ? m.pending : m.defectiveItems - m.established} note={role === 'controller' ? 'Требуют решения контролёра' : 'Изделия с подтверждённым дефектом'} icon="help" onClick={() => navigate(role === 'controller' ? 'quality' : 'analytics', role === 'leader' ? 'causes' : undefined)} />
      </>}
    </div>
    <div className="home-columns">
      <div className="stack">
        {role === 'administrator' ? <Panel title="Приём событий" eyebrow="ТЕКУЩИЙ ЖУРНАЛ" action={<Button onClick={() => navigate('events')}>Открыть журнал</Button>}><div className="connection-list">{[['Принято', intake.counts.accepted], ['Поздние события', intake.counts.late], ['Точные дубли', intake.counts.duplicate], ['Ошибки приёма', intake.counts.error]].map(([label, count]) => <button key={label} onClick={() => navigate('events')}><span className="connector-symbol"><Icon name="events" size={18}/></span><div><strong>{label}</strong><small>{count} в текущем журнале</small></div><Icon name="chevron" /></button>)}</div></Panel>
          : role === 'master' || role === 'leader' ? <Panel title="Требуют действия" eyebrow="ОТКЛОНЕНИЯ И ИСПОЛНЕНИЕ" action={<Button onClick={() => navigate('tasks', role === 'leader' ? 'team' : 'mine')}>Все задачи</Button>}><TaskList data={relevantTasks.slice(0, 4)} openItem={openItem} /></Panel>
          : <Panel title={role === 'technologist' ? 'Подтверждённые случаи для разбора' : ''} eyebrow={role === 'technologist' ? 'ОТК ПОДТВЕРДИЛ · ПРИЧИНА ОТДЕЛЬНО' : undefined} action={<Button onClick={() => navigate(role === 'technologist' ? 'investigation' : 'quality', role === 'technologist' ? 'cases' : 'signals')}>Все случаи</Button>}><CaseTable data={visibleCases.filter(c => role !== 'technologist' || c.confirmed).slice(0, 4)} openItem={openItem} openCase={role === 'technologist' ? openCase : undefined}/></Panel>}
        <Panel title="Состояние процесса" eyebrow="ПО ПРИНЯТЫМ СОБЫТИЯМ" className="workflow-panel"><WorkflowStrip {...props} /></Panel>
      </div>
      <div className="stack">
        <Panel title={role === 'administrator' ? 'Доверие к истории' : `В фокусе · ${focusItem}`} eyebrow={role === 'administrator' ? 'ЦЕЛОСТНОСТЬ' : 'ПАСПОРТ ИЗДЕЛИЯ'} className="focus-panel">
          {role === 'administrator' ? <><div className="security-orbit"><Icon name="security" size={72} /></div><h3>Принятая история</h3><dl className="facts"><div><dt>События в срезе</dt><dd>{m.events}</dd></div><div><dt>Решения ОТК</dt><dd>{events.filter(e => e.event_type === 'quality_decision' && inScope(e, scope)).length}</dd></div><div><dt>Ошибки приёма</dt><dd>{intake.counts.error}</dd></div></dl><Button onClick={() => navigate('security', 'integrity')}>Проверить целостность</Button></> : focusProduct && focusItem ? <><ProductDrawing /><div className="focus-title"><strong>{productSpecification(focusItem).name}</strong><Badge tone={productStatus(focusItem).tone}>{productStatus(focusItem).label}</Badge></div><dl className="facts"><div><dt>Заказ</dt><dd className="mono">{focusProduct.work_order_id}</dd></div><div><dt>Ревизия / состав</dt><dd>{focusProduct.assembly_revision} · {focusProduct.components.length} компонента(ов)</dd></div><div><dt>Наблюдения</dt><dd>{focusCases.length ? focusCases.map(c => defectNames[c.type] ?? c.type).join(', ') : 'Нет случаев в выбранном срезе'}</dd></div><div><dt>Причина</dt><dd>{focusReview?.data.status === 'confirmed' ? 'Установлена' : focusReview ? 'На рассмотрении' : 'Не установлена'}</dd></div></dl><Button className="full" onClick={() => openItem(focusItem)}>Открыть всю историю</Button></> : <Empty title="Нет изделия в выбранном срезе" text="Выберите другую смену, чтобы увидеть паспорт."/>}
        </Panel>
        <div className="context-tip"><Icon name="layer" size={21} /><div><strong>Общий контекст для команды</strong><p>Карточка изделия сохраняет маршрут, наблюдения и решения при переходе между ролями.</p></div></div>
      </div>
    </div>
  </>;
}

function WorkflowStrip({ route, scope, navigate, changeRole }: ViewProps) {
  const scopedEvents = events.filter(event => inScope(event, scope));
  const scopedCases = cases.filter(record => record.observations.some(event => inScope(event, scope)));
  const flow: { label: string; detail: string; icon: string; role: RoleId; module: ModuleId }[] = [
    { label: 'Наблюдения', detail: `${scopedEvents.filter(event => event.event_type === 'inspection_result').length} событий`, icon: 'source', role: 'administrator', module: 'events' },
    { label: 'Рассмотрение ОТК', detail: `${scopedCases.filter(record => !record.decisions.length).length} ждут решения`, icon: 'quality', role: 'controller', module: 'quality' },
    { label: 'Разбор причин', detail: `${scopedCases.filter(record => record.confirmed && !record.review).length} без заключения`, icon: 'investigation', role: 'technologist', module: 'investigation' },
    { label: 'Действия мастера', detail: `${tasks.filter(task => task.role === 'master' && !task.done && inScope(task.event, scope)).length} открыто`, icon: 'tasks', role: 'master', module: 'operations' },
    { label: 'Решения ОТК', detail: `${scopedEvents.filter(event => event.event_type === 'quality_decision').length} записано`, icon: 'events', role: 'administrator', module: 'events' },
  ];
  return <div className="workflow-strip">{flow.map((step, i) => <button key={step.label} onClick={() => canAccess(route.role, step.module) ? navigate(step.module) : changeRole(step.role, step.module)} title={canAccess(route.role, step.module) ? `Открыть: ${step.label}` : `Показать рабочее место: ${roleById[step.role].name}`}><span className="flow-icon"><Icon name={step.icon} /><em>{String(i + 1).padStart(2, '0')}</em></span><strong>{step.label}</strong><small>{step.detail}</small>{i < flow.length - 1 && <Icon className="flow-arrow" name="chevron" size={14} />}</button>)}</div>;
}

function TaskList({ data, openItem, openCase }: { data: typeof tasks; openItem: (id: string) => void; openCase?: (item: string, caseId: string) => void }) {
  return data.length ? <div className="task-list">{data.map(task => <button key={task.id} onClick={() => task.caseId && openCase ? openCase(task.item, task.caseId) : openItem(task.item)}><span className={`task-symbol ${task.done ? 'green' : 'amber'}`}><Icon name={task.done ? 'check' : 'clock'} /></span><div><strong>{task.title}</strong><small><span className="mono">{task.item}</span> · {roleById[task.role].name}</small><p>{task.description}</p></div><Badge tone={task.done ? 'green' : 'amber'}>{task.done ? 'Завершено' : 'Требует действия'}</Badge><Icon name="chevron" /></button>)}</div> : <Empty title="Открытых задач в этом срезе нет" text="Новые действия будут появляться здесь вместе с основанием и карточкой изделия." />;
}

function QualityView({ route, scope, openItem, openCase, navigate }: ViewProps) {
  if (route.role === 'controller') return <ControllerCockpit scope={scope} caseId={route.caseId} openCase={openCase} openPassport={openItem} onExit={() => navigate('home')}/>;
  const [filter, setFilter] = useState('all');
  const source = cases.filter(c => c.observations.some(e => inScope(e, scope)));
  const data = source.filter(c => filter === 'all' || (filter === 'confirmed' && c.confirmed) || (filter === 'pending' && !c.decisions.length) || (filter === 'closed' && ['Отклонено', 'Выпуск после доработки'].includes(c.status)));
  if (route.section === 'rechecks') return <Panel title="Уточнение наблюдений" eyebrow="ПОВТОРНЫЙ КОНТРОЛЬ"><TaskList data={tasks.filter(t => t.role === 'controller' && inScope(t.event, scope))} openItem={openItem} /></Panel>;
  if (route.section === 'decisions') return <Panel title="Записанные решения" eyebrow="УЧЕБНАЯ ИСТОРИЯ"><div className="table-wrap"><table><thead><tr><th>Изделие</th><th>Решение</th><th>Основание</th><th>Автор / время</th></tr></thead><tbody>{events.filter(e => e.event_type === 'quality_decision' && inScope(e, scope)).map(e => <tr key={e.event_id}><td><button className="cell-link mono" onClick={() => openItem(e.item_id)}>{e.item_id}</button></td><td><Badge tone={e.data.decision === 'confirmed' ? 'red' : 'green'}>{decisionNames[e.data.decision!]}</Badge></td><td className="wide-cell">{e.data.reason}</td><td><span className="mono">{e.actor_id}</span><small>{time(e.occurred_at)}</small></td></tr>)}</tbody></table></div></Panel>;
  return <>{route.section === 'signals' && <SmartQueue role={route.role} scope={scope} openItem={openItem}/>}<div className="workspace-toolbar"><div className="filter-chips" aria-label="Фильтр случаев">{[['all', 'Все'], ['pending', 'На рассмотрении'], ['confirmed', 'Подтверждённые'], ['closed', 'Закрытые']].map(([key, label]) => <button key={key} aria-pressed={filter === key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}{key === 'all' && <span>{source.length}</span>}</button>)}</div><span className="toolbar-note">Поступившие наблюдения</span></div><Panel title={route.section === 'signals' ? 'Наблюдения и их рассмотрение' : 'Реестр несоответствий'} eyebrow="ОБЪЕДИНЕНИЕ ПО ИЗДЕЛИЮ И ОБЛАСТИ"><CaseTable data={data} openItem={openItem} /></Panel><Note>Сигнал анализатора и подтверждённый дефект имеют разные статусы. Повторные наблюдения одной области в одной операции объединены; исходные события доступны в истории.</Note></>;
}

function ProductsView({ scope, openItem }: ViewProps) {
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<RegistryGroup | 'all'>('all');
  const rows = items.filter(item => item.item_type_id === 'TYPE-BRACKET-01' && (scope === 'all' || events.some(event => event.item_id === item.id && inScope(event, scope))))
    .map(item => projectRegistryRow(item, eventsFor(item.id)));
  const filtered = rows.filter(row => (group === 'all' || row.group === group) && `${row.item.id} ${row.item.work_order_id} ${row.lot} ${row.traveler} ${productSpecification(row.item.id).name} ${productSpecification(row.item.id).assembly} ${productSpecification(row.item.id).designation}`.toLowerCase().includes(query.toLowerCase()));
  const filters: { id: RegistryGroup | 'all'; label: string; tone: string }[] = [
    { id: 'all', label: 'Все изделия', tone: 'muted' }, { id: 'needs', label: 'Требуют решения ОТК', tone: 'amber' },
    { id: 'rework', label: 'На доработке в цехе', tone: 'blue' }, { id: 'good', label: 'Годны (контроль пройден)', tone: 'green' },
    { id: 'scrap', label: 'Брак / Изолятор', tone: 'red' },
  ];

  return <>
    <div className="registry-overview"><div><span className="eyebrow">ЕДИНЫЙ РЕЕСТР УЧАСТКА</span><h2>Изделия и их маршрут</h2><p>Местонахождение, решение ОТК и целостность истории для каждого кронштейна.</p></div><strong className="mono">{rows.length}<small>изделий в срезе</small></strong></div>
    <div className="registry-filters" role="group" aria-label="Фильтр по статусу качества">{filters.map(filter => <button key={filter.id} className={['registry-chip', filter.tone, group === filter.id && 'active'].filter(Boolean).join(' ')} aria-pressed={group === filter.id} onClick={() => setGroup(filter.id)}>{filter.label}<span>{filter.id === 'all' ? `(${rows.length})` : rows.filter(row => row.group === filter.id).length}</span></button>)}</div>
    <div className="workspace-toolbar registry-toolbar">
      <label className="local-search"><Icon name="search" /><input aria-label="Поиск по реестру" placeholder="Изделие, название, ЕСКД, заказ или МЛ…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <span className="toolbar-note">Показано {filtered.length} из {rows.length}</span>
    </div>
    <Panel title="Реестр изделий" eyebrow="ПРОИЗВОДСТВО · ОТК · АУДИТ">
      <div className="table-wrap registry-table"><table><thead><tr><th>Изделие</th><th>Заказ и МЛ</th><th>Текущее местонахождение</th><th>Статус качества</th><th>Целостность</th><th>Действие</th></tr></thead><tbody>
        {filtered.map(row => <tr key={row.item.id} className="product-open-row" tabIndex={0} aria-label={`Открыть паспорт ${row.item.id}`} onClick={() => openItem(row.item.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openItem(row.item.id); } }}><td><strong className="mono registry-id">{row.item.id}</strong><small>{productSpecification(row.item.id).name}</small><small className="mono">{productSpecification(row.item.id).designation} · партия {row.lot}</small></td><td><strong className="mono">{row.item.work_order_id}</strong><small className="mono">МЛ {row.traveler}</small></td><td className="registry-location">{row.location}</td><td><Badge tone={row.tone}>{row.status}</Badge></td><td><span className="registry-audit"><Icon name="security" size={16}/>Audit OK <small>(SHA-256)</small></span></td><td><button className="registry-open" onClick={event => { event.stopPropagation(); openItem(row.item.id); }} aria-label={`Паспорт ${row.item.id}`}>Паспорт <Icon name="arrow" size={15}/></button></td></tr>)}
      </tbody></table></div>
      {!filtered.length && <Empty title="Изделия не найдены" text="Проверьте номер или выберите другую смену." />}
    </Panel>
  </>;
}

function OperationsTable({ scope, openItem, onlyRework = false }: { scope: Scope; openItem: (id: string) => void; onlyRework?: boolean }) {
  const filtered = operations.filter(op => (scope === 'all' || op.shift === scope) && (!onlyRework || op.rework));
  return <div className="table-wrap"><table><thead><tr><th>Изделие / операция</th><th>Смена / оператор</th><th>Время</th><th>Длительность</th><th>Состояние</th></tr></thead><tbody>{filtered.map(op => <tr key={op.id}><td><button className="cell-link mono" onClick={() => openItem(op.item)}>{op.item}</button><small>{op.name}</small></td><td>{op.shift === 'SHIFT-A' ? 'Смена А' : 'Смена Б'}<small className="mono">{op.actor}</small></td><td className="mono">{time(op.start)} → {op.end ? time(op.end) : '—'}</td><td className="mono">{op.duration === undefined ? '—' : `${op.duration} мин`}</td><td><Badge tone={op.paused ? 'amber' : op.rework ? 'blue' : 'green'}>{op.paused ? 'Пауза' : op.rework ? 'Повторный запуск' : 'Завершена'}</Badge></td></tr>)}</tbody></table>{!filtered.length && <Empty title="Операций в этом срезе нет" text="Выберите другую смену." />}</div>;
}

function ProductionView(props: ViewProps) {
  const { route, scope, openItem, navigate } = props;
  if (route.section === 'operations') return <><Panel title="Выполнение операций" eyebrow="ФАКТЫ MES"><OperationsTable scope={scope} openItem={openItem} /></Panel><Note>Длительность — интервал от начала до завершения одного запуска. Незавершённые операции показаны отдельно и не включаются в среднюю длительность.</Note></>;
  if (route.section === 'rework') return <div className="stack"><Panel title="Повторная обработка" eyebrow="СВЯЗЬ С ПЕРВОЙ ОПЕРАЦИЕЙ"><OperationsTable scope={scope} openItem={openItem} onlyRework /></Panel><Panel title="Действия по карантину" eyebrow="НА ОСНОВАНИИ РЕШЕНИЙ КОНТРОЛЁРА"><TaskList data={tasks.filter(t => t.title.includes('карантин') && inScope(t.event, scope))} openItem={openItem} /></Panel></div>;
  if (route.section === 'shifts') return <div className="card-grid">{catalogs.shifts.map(shift => <Panel key={shift.id} title={shift.id === 'SHIFT-A' ? 'Смена А' : 'Смена Б'} eyebrow={`${shift.local_start} — ${shift.local_end}`}><div className="shift-number mono">{metrics(shift.id as Scope).items}<small>изделий</small></div><p className="panel-description">Выполнение операций, подтверждённые отклонения и незавершённая работа смены.</p><Button onClick={() => navigate('production', 'operations')}>Операции и передача</Button></Panel>)}</div>;
  return <>
    {(['LINE-01', 'LINE-02'] as const).map(line => <section className="line-section" key={line}>
      <div className="line-banner"><div><span className="eyebrow">{line}</span><h2>Демонстрационная линия {line === 'LINE-01' ? '01' : '02'}</h2><p>Входной контроль → обработка → сборка → выпуск</p></div><Badge tone="amber">Поступившие события</Badge></div>
      <div className="station-grid">{catalogs.stations.filter(station => station.id.endsWith('-02') === (line === 'LINE-02')).map((station, index) => {
        const count = new Set(events.filter(event => event.station_id === station.id && inScope(event, scope)).map(event => event.item_id)).size;
        return <button className="station-card" key={station.id} onClick={() => navigate(index === 3 ? 'quality' : 'production', index === 3 ? 'cases' : 'operations')}><div><span className="station-number mono">0{index + 1}</span><Icon name={['quality', 'production', 'box', 'done'][index]} size={23}/></div><h3>{station.name}</h3><strong className="mono">{count}<small>изделий в истории</small></strong><span className="station-link">Открыть рабочую область<Icon name="arrow" size={16}/></span></button>;
      })}</div>
    </section>)}
    <Panel title="Действия мастера" eyebrow="ПО СОБЫТИЯМ УЧАСТКА"><TaskList data={tasks.filter(task => task.role === 'master' && !task.done && inScope(task.event, scope))} openItem={openItem}/></Panel>
  </>;
}

function InvestigationView({ route, scope, openItem }: ViewProps) {
  const [chosen, setChosen] = useState('ITEM-013');
  if (route.section === 'cases') return <><Panel title="Дефект подтверждён. Причину нужно проверить." eyebrow="НЕЗАВИСИМЫЙ РАЗБОР ПРИЧИН"><CaseTable data={cases.filter(c => c.confirmed && c.observations.some(e => inScope(e, scope)))} openItem={openItem} /></Panel><Note>Подтверждение дефекта не устанавливает виновную сторону. Заключение технолога содержит основания, альтернативные объяснения и недостающие сведения.</Note></>;
  if (route.section === 'equipment' || route.section === 'procedure') { const types = route.section === 'equipment' ? ['machine_state'] : ['operator_action', 'cause_review']; return <Panel title={route.section === 'equipment' ? 'Журнал оборудования в контексте изделия' : 'Наблюдения и заключения по процедурам'} eyebrow="ОСНОВАНИЯ ДЛЯ ПРОВЕРКИ"><div className="event-list">{events.filter(e => types.includes(e.event_type) && inScope(e, scope) && (route.section === 'equipment' || e.data.cause_type === 'procedural_error' || e.event_type === 'operator_action')).map(e => <button key={e.event_id} onClick={() => openItem(e.item_id)}><span className="event-time mono">{time(e.occurred_at)}</span><div><strong>{eventNames[e.event_type]}</strong><p>{describeEvent(e)}</p><small>{e.item_id} · {e.source_id}</small></div><Icon name="arrow" /></button>)}</div></Panel>; }
  const own = eventsFor(chosen);
  const observations = own.filter(event => event.event_type === 'inspection_result');
  const before = observations.find(event => ['signs_detected', 'unable_to_assess'].includes(event.data.inspection_result ?? ''));
  const after = before ? observations.filter(event => Date.parse(event.occurred_at) > Date.parse(before.occurred_at)).at(-1) : undefined;
  const evidence = mediaFor(chosen);
  const beforePhotos = evidence.filter(({ asset }) => ['before_machine', 'before_rework', 'after_machine', 'ambiguous_observation'].includes(asset.stage));
  const afterPhotos = evidence.filter(({ asset }) => !['before_machine', 'before_rework', 'after_machine', 'ambiguous_observation'].includes(asset.stage));
  return <><div className="workspace-toolbar"><label className="inline-select">Изделие<select value={chosen} onChange={e => setChosen(e.target.value)}>{items.filter(item => cases.some(c => c.item === item.id)).map(item => <option key={item.id}>{item.id}</option>)}</select></label><Button onClick={() => openItem(chosen)}>Полная история</Button></div><div className="two-columns">{[{ label: 'До действия', event: before, photos: beforePhotos }, { label: 'После действия', event: after, photos: afterPhotos }].map(({ label, event, photos }) => <Panel key={label} title={label} eyebrow={event ? `${event.source_id} / ${time(event.occurred_at)}` : 'НЕТ НОВОГО НАБЛЮДЕНИЯ'}>{photos.length ? <div className="comparison-media">{photos.map(({ event: photoEvent, asset }) => <figure key={asset.asset_id}><ImagePreview src={mediaUrl(asset)} alt={asset.description} title={`${label} · ${asset.description}`} /><figcaption><strong>{asset.capture_source === 'fixed_camera' ? 'Камера CV' : 'Фото мастера'}</strong><span>{time(photoEvent.occurred_at)} · {photoEvent.data.observation_quality === 'poor' ? 'плохой обзор' : 'достаточный обзор'}</span><p>{asset.description}</p></figcaption></figure>)}</div> : <div className="evidence-placeholder"><Icon name="control" size={40}/><span>Кадр не поступил</span><small>Фото появится только после события с вложением</small></div>}{event ? <><Badge tone={event.data.observation_quality === 'poor' ? 'amber' : 'blue'}>{resultNames[event.data.inspection_result!]}</Badge><p className="panel-description">{describeEvent(event)}</p><div className="field-tags">{event.data.defects?.map(finding => <span key={finding.finding_id}>{defectNames[finding.defect_type_id]} · {finding.region}</span>)}</div></> : <Note tone="amber">Повторный результат ещё не поступил. Фото само по себе не устанавливает годность и размерный допуск.</Note>}</Panel>)}</div><Note tone="amber">Разница между наблюдениями помогает ограничить время появления признака. Для вывода о причине нужны дополнительные основания и проверка качества обоих наблюдений.</Note></>;
}

function AnalyticsView(props: ViewProps) {
  const { route, scope, openItem, navigate } = props; const m = metrics(scope);
  const firstConfirmed = cases.find(itemCase => itemCase.confirmed && itemCase.observations.some(event => inScope(event, scope)))?.item;
  const firstProcedureError = events.find(event => event.event_type === 'cause_review' && event.data.cause_type === 'procedural_error' && event.data.status === 'confirmed' && inScope(event, scope))?.item_id;
  if (route.section === 'losses') return <PreparedSection section={moduleById.analytics.sections.find(s => s.id === 'losses')!}/>;
  if (route.section === 'time' || route.section === 'rework') return <><Panel title={route.section === 'time' ? 'Длительности сравнимых операций' : 'Повторные запуски и затраты времени'} eyebrow="ПО НАЧАЛУ И ЗАВЕРШЕНИЮ"><OperationsTable scope={scope} openItem={openItem} onlyRework={route.section === 'rework'} /></Panel><Note>Для сравнения доступны тип операции, смена и исполнитель. Расчёт ожиданий, активного времени и выхода с первого предъявления потребует согласованных правил учёта.</Note></>;
  if (route.section === 'reports') return <div className="two-columns"><Panel title="Сводка качества" eyebrow="ЭКСПОРТ ДОСТУПНЫХ ПОКАЗАТЕЛЕЙ"><dl className="facts"><div><dt>Источник</dt><dd>Учебный набор событий</dd></div><div><dt>Период</dt><dd>17–26 февраля 2026</dd></div><div><dt>Смена</dt><dd>{scope === 'all' ? 'Все смены' : scope === 'SHIFT-A' ? 'А' : 'Б'}</dd></div><div><dt>Формат</dt><dd>CSV · UTF-8</dd></div></dl><Button primary icon="file" onClick={() => exportMetrics(scope)}>Скачать сводку CSV</Button></Panel><PreparedSection section={moduleById.analytics.sections.find(s => s.id === 'reports')!} compact /></div>;
  return <><div className="metric-grid"><Metric label="Проверено" value={m.inspected} note="Уникальные изделия" icon="quality" tone="green" onClick={() => navigate('products')} /><Metric label="С дефектами" value={m.defectiveItems} note="Уникальные изделия за историю" icon="products" tone="red" onClick={() => firstConfirmed ? openItem(firstConfirmed) : navigate('products')} /><Metric label="Всего дефектов" value={m.defects} note="Подтверждённые случаи" icon="investigation" tone="amber" onClick={() => firstConfirmed ? openItem(firstConfirmed) : navigate('products')} /><Metric label="Ошибки процедуры" value={m.errors} note="Подтверждены технологом" icon="tasks" onClick={() => firstProcedureError ? openItem(firstProcedureError) : navigate('products')} /></div><div className="two-columns"><Panel title={route.section === 'causes' ? 'Установление причины' : 'Подтверждённые типы дефектов'} eyebrow="ИСТОРИЯ ВЫБРАННОЙ СМЕНЫ"><div className="bar-chart">{(route.section === 'causes' ? [{ label: 'Причина установлена', count: m.established }, { label: 'Причина не установлена', count: m.defectiveItems - m.established }] : Object.entries(defectNames).map(([key, label]) => ({ label, count: cases.filter(c => c.confirmed && c.type === key && c.observations.some(e => inScope(e, scope))).length }))).map((row, i) => <div key={row.label}><div><span>{row.label}</span><strong className="mono">{row.count}</strong></div><div className="bar-track"><span style={{ width: `${row.count / Math.max(m.defects, 1) * 100}%` }} className={`bar-${i}`} /></div></div>)}</div><p className="chart-caption">{route.section === 'causes' ? 'Число изделий с подтверждёнными дефектами.' : 'Число уникальных случаев. Повторная доставка не увеличивает показатель.'}</p></Panel><Panel title="Как читать показатели" eyebrow="ОПРЕДЕЛЕНИЯ И ГРАНИЦЫ"><div className="definition-list"><div><span className="mono">01</span><p><strong>Изделие и дефект — разные единицы</strong>У одного изделия может быть несколько дефектов.</p></div><div><span className="mono">02</span><p><strong>Исправление сохраняет историю</strong>После доработки исходный дефект остаётся в статистике.</p></div><div><span className="mono">03</span><p><strong>Причина требует подтверждения</strong>Предупреждение станка само по себе не доказывает причину.</p></div></div></Panel></div><Panel title="От показателя к конкретному случаю" eyebrow="ПРОВЕРЯЕМЫЕ ОСНОВАНИЯ"><CaseTable data={cases.filter(c => c.confirmed && c.observations.some(e => inScope(e, scope)))} openItem={openItem} /></Panel></>;
}

function exportMetrics(scope: Scope) {
  const m = metrics(scope); const csv = '\uFEFFПоказатель;Значение\r\n' + [['Срез', scope], ['Период', '2026-02-17 — 2026-02-26'], ['Проверено изделий', m.inspected], ['Изделий с дефектами за историю', m.defectiveItems], ['Подтверждённых дефектов', m.defects], ['Установленная причина (изделий)', m.established], ['Подтверждённых ошибок процедуры', m.errors], ['Повторных запусков', m.rework], ['Незавершённых операций', m.unfinished]].map(row => row.join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `orbita-quality-${scope}.csv`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function IntegrationsView({ route, navigate }: ViewProps) {
  const [selected, setSelected] = useState(0);
  if (route.section === 'exchange') return <AdminExchangeView />;
  if (route.section === 'mes') return <AdminMesView />;
  if (route.section === 'mappings') return <AdminMappingsView />;
  if (route.section === 'cad') return <AdminCadView />;
  if (route.section === 'contracts') return <AdminContractsView />;
  if (route.section !== 'connections') return <PreparedSection section={moduleById.integrations.sections.find(s => s.id === route.section)!} />;
  const profile = profiles[selected];
  return <><div className="integration-cards">{profiles.map((p, i) => <button key={p.system} className={`integration-card ${i === selected ? 'selected' : ''}`} aria-pressed={selected === i} onClick={() => setSelected(i)}><span className="connector-symbol">{['1C', 'Г', 'M', 'К'][i]}</span><h3>{['1С:Предприятие', 'Галактика ERP', 'MES', 'КОМПАС-3D'][i]}</h3><p>{['Заказы и результаты качества', 'Планирование и учёт', 'Ход производства', 'Состав и ревизии сборки'][i]}</p><Badge>Профиль подключения</Badge></button>)}</div><div className="two-columns"><Panel title={['1С:Предприятие', 'Галактика ERP', 'MES', 'КОМПАС-3D'][selected]} eyebrow="НАПРАВЛЕНИЯ ОБМЕНА"><div className="exchange-flow"><div><Icon name="integrations"/><strong>Внешняя система</strong><small>{profile.system}</small></div><span>⇄</span><div><Icon name="orbit"/><strong>ОРБИТА.QC</strong><small>Единая модель событий</small></div></div><dl className="facts"><div><dt>Входящие данные</dt><dd>{selected < 2 ? 'Заказы, номенклатура' : selected === 2 ? 'Операции, действия, оборудование' : 'Структура и ревизии сборки'}</dd></div><div><dt>Исходящие данные</dt><dd>{selected < 2 ? 'Результаты качества и решения' : selected === 2 ? 'Статусы несоответствий' : 'Не предусмотрены профилем'}</dd></div><div><dt>Интерфейс</dt><dd>{profile.technical_interface}</dd></div></dl><Button onClick={() => navigate('integrations', 'mappings')}>Сопоставления данных</Button></Panel><Panel title="Ввод в эксплуатацию" eyebrow="ШАГИ ПОДКЛЮЧЕНИЯ"><ol className="setup-list"><li><span>1</span><div><strong>Выбрать источник истины</strong><p>Для заказов выбирается авторитетная ERP предприятия.</p></div></li><li><span>2</span><div><strong>Сопоставить идентификаторы</strong><p>Заказ, изделие, операция и ревизия должны иметь устойчивые связи.</p></div></li><li><span>3</span><div><strong>Проверить доставку и возврат</strong><p>Квитанция, временный отказ, повтор и неизвестный идентификатор.</p></div></li></ol><Note>{selected < 3 ? 'Серверный адаптер готов к согласованному HTTP/JSON-шлюзу. Установленная система пока не подключена.' : 'Серверный клиент CAD-адаптера готов; SDK-процесс КОМПАС-3D на рабочей станции ещё требуется.'}</Note><Button onClick={() => navigate('integrations', 'exchange')}>Рабочая область обмена</Button></Panel></div></>;
}

function EventsView(props: ViewProps) {
  const { route, scope, openItem, navigate } = props;
  const [query, setQuery] = useState('');
  const state = ingestState();
  if (route.section === 'replay') return <EventReplayView {...props}/>;
  if (route.section === 'quality' && route.role === 'technologist') return <DataQualityView openItem={openItem}/>;
  if (route.section === 'quality') return <>
    <div className="metric-grid">
      <Metric label="Принято" value={state.counts.accepted + state.counts.late} note="Уникальные поступившие события" icon="events" onClick={() => navigate('events', 'journal')}/>
      <Metric label="Поздние" value={state.counts.late} note="Сортировка по occurred_at" icon="clock" tone="amber" onClick={() => navigate('events', 'journal')}/>
      <Metric label="Точные дубли" value={state.counts.duplicate} note="Не создают второй случай" icon="branch" tone="amber" onClick={() => navigate('events', 'replay')}/>
      <Metric label="Карантин входа" value={state.counts.error} note="Ошибки с причиной" icon="alert" tone="red" onClick={() => navigate('events', 'replay')}/>
    </div>
    <IngestOutcomes openItem={openItem}/>
    <Note tone={state.counts.error ? 'amber' : 'green'}>{state.counts.error ? 'Ошибочное сообщение не изменяет историю и остаётся в карантине с причиной. Исправьте исходный JSON и повторно загрузите его в разделе «Сценарии и воспроизведение».' : 'Карантин пуст. Ошибочные сообщения не попадают в историю изделия.'} <Button onClick={() => navigate('events', 'replay')}>Открыть импорт и воспроизведение</Button></Note>
  </>;
  const filtered = events.filter(event => inScope(event, scope) && `${event.event_id} ${event.item_id} ${event.source_id} ${eventNames[event.event_type]}`.toLowerCase().includes(query.toLowerCase()));
  return <><div className="workspace-toolbar"><label className="local-search"><Icon name="search"/><input value={query} onChange={e => setQuery(e.target.value)} aria-label="Поиск событий" placeholder="Изделие, источник или событие…"/></label><span className="toolbar-note">{filtered.length} поступивших событий</span></div><Panel title="Сохранённая история учебного набора" eyebrow="ВРЕМЯ СОБЫТИЯ И ДОСТАВКИ"><div className="table-wrap"><table><thead><tr><th>Событие</th><th>Произошло / доставлено</th><th>Тип и источник</th><th>Изделие</th><th>Контекст</th></tr></thead><tbody>{filtered.map(event => <tr key={event.event_id}><td className="mono">{event.event_id}</td><td className="mono">{time(event.occurred_at)}<small>доставка {deliveryFor(event.event_id) ? time(deliveryFor(event.event_id)!.deliver_at) : '—'}</small></td><td><strong>{eventNames[event.event_type]}</strong><small className="mono">{event.source_id}</small></td><td><button className="cell-link mono" onClick={() => openItem(event.item_id)}>{event.item_id}</button></td><td className="wide-cell">{describeEvent(event)}</td></tr>)}</tbody></table></div>{!filtered.length && <Empty title="События не найдены" text="Измените поиск или смену." />}</Panel></>;
}

function ControlView({ route }: ViewProps) {
  if (route.section !== 'points') return <PreparedSection section={moduleById.control.sections.find(s => s.id === route.section)!} />;
  return <><div className="control-grid">{inspectionPlan.control_points.map((point, i) => <Panel key={point.id} title={['Входной контроль', 'После обработки', 'Финальный контроль'][i]} eyebrow={point.id}><div className="control-illustration"><Icon name="control" size={36} /><span className="control-ray"/><Icon name="products" size={45}/></div><p className="panel-description">{point.purpose}</p><div className="field-tags">{point.used_defect_types.map(type => <span key={type}>{defectNames[type]}</span>)}</div><h3 className="small-heading">Условия наблюдения</h3><ul className="plain-list">{point.observation_conditions.map(condition => <li key={condition}>{condition}</li>)}</ul><h3 className="small-heading">Границы контроля</h3><ul className="plain-list">{point.limits.map(limit => <li key={limit}>{limit.replace('unable_to_assess', '«оценить невозможно»')}</li>)}</ul></Panel>)}</div><Note tone="amber">План является проектным предположением. Разрешение камер, частота, минимальный размер признака и задержка анализа должны быть измерены и проверены на площадке.</Note></>;
}

function PlatformView({ route }: ViewProps) {
  if (route.section === 'users') return <><Panel title="Матрица рабочих ролей" eyebrow="ОБЛАСТЬ ДАННЫХ И ПРАВА НА ДЕЙСТВИЯ"><div className="table-wrap"><table><thead><tr><th>Роль</th><th>Основная ответственность</th><th>Рабочие пространства</th></tr></thead><tbody>{roles.map(role => <tr key={role.id}><td><strong>{role.name}</strong></td><td>{role.focus}</td><td>{[...role.primary, ...role.secondary].filter(id => id !== 'home').map(id => moduleById[id].label).join(' · ')}</td></tr>)}</tbody></table></div><Note>Смена роли требует нового входа. Сервер проверяет права на изменяющие действия и область линии; рабочие разделы без серверных данных отдельно помечены.</Note></Panel><SecuritySessionsPanel/></>;
  if (route.section === 'health') return <AdminHealthView/>;
  if (route.section === 'topology') return <><Panel title="От источника до рабочего места" eyebrow="АРХИТЕКТУРА КОНТУРА"><div className="topology"><div><Icon name="source" size={30}/><h3>Источники</h3><p>VisionQC · OperatorVision<br/>MachineLogs · MES</p></div><Icon name="arrow"/><div><Icon name="cpu" size={30}/><h3>Edge-агенты</h3><p>Сбор · буфер<br/>защищённая доставка</p></div><Icon name="arrow"/><div><Icon name="database" size={30}/><h3>Центральное ядро</h3><p>Оригиналы · анализ<br/>проекции · обмен</p></div></div></Panel><PreparedSection section={moduleById.platform.sections[1]} compact /></>;
  return <PreparedSection section={moduleById.platform.sections.find(s => s.id === route.section)!} />;
}

/** A distinct, explicit home for functionality whose backend is not implemented yet. */
export function PreparedSection({ section, compact = false }: { section: Section; compact?: boolean }) {
  return <div className={`prepared-section ${compact ? 'compact-prepared' : ''}`}><div className="prepared-intro"><span className="module-token"><Icon name={section.optional ? 'sparkles' : 'layer'} size={25}/></span><div><Badge tone="blue">{section.optional ? 'Расширение запланировано' : 'Запланировано'}</Badge><h2>{section.label}</h2><p>{section.purpose}</p></div></div>{!compact && <div className="process-grid">{section.steps.map((step, i) => <div key={step}><span className="mono">0{i + 1}</span><h3>{step}</h3><small>{['Вход и основание', 'Рабочее действие', 'Результат и связь'][i]}</small>{i < 2 && <Icon name="arrow"/>}</div>)}</div>}<div className="prepared-body"><div><span className="eyebrow">В РАБОЧЕЙ ОБЛАСТИ</span><div className="field-grid">{section.fields.map(field => <div key={field}><Icon name="dot" size={15}/>{field}</div>)}</div></div><div className="prepared-status"><Icon name="layer" size={24}/><div><strong>Место в процессе определено</strong><p>Серверные данные и действия этого раздела пока не подключены. Здесь показана запланированная структура.</p></div></div></div></div>;
}

function GuideView(props: ViewProps) {
  const { route, changeRole } = props;
  if (route.section === 'workflow') return <><Panel title="Как работает система" eyebrow="ОДИН ПРОЦЕСС · ПЯТЬ РОЛЕЙ"><WorkflowStrip {...props}/></Panel><div className="two-columns"><Panel title="Наблюдение → факт → объяснение" eyebrow="УРОВНИ ВЫВОДОВ"><ol className="text-steps"><li><strong>Внешний анализатор сообщает признак.</strong> Система связывает его с изделием, участком и операцией.</li><li><strong>Контролёр проверяет наличие дефекта.</strong> Может подтвердить, отклонить или запросить дополнительный контроль.</li><li><strong>Технолог исследует причину.</strong> Гипотезы, подтверждённые ошибки и неизвестные причины хранятся отдельно.</li><li><strong>Мастер организует действие.</strong> Карантин, повторная обработка и передача на проверку привязаны к основанию.</li><li><strong>Результат попадает в учёт.</strong> Для подключения реальных ERP и MES потребуется согласовать их шлюзы и проверить обмен на тестовых стендах.</li></ol></Panel><Panel title="Что объединяет рабочие места" eyebrow="ОБЩИЙ КОНТЕКСТ"><ProductDrawing/><p className="panel-description">Паспорт изделия, состав, хронология событий и авторство решений доступны по контекстной ссылке. Исходные наблюдения сохраняются независимо от последующих выводов.</p></Panel></div></>;
  if (route.section === 'help') return <div className="two-columns"><Panel title="Текущая версия приложения" eyebrow="НАВИГАЦИОННАЯ ОСНОВА"><div className="definition-list"><p><strong>Уже работает</strong>Пять рабочих мест, приём JSON/JSONL, сохранение событий и действий ролей, фото, очередь, фильтры и текущие показатели.</p><p><strong>Данные</strong>Расширенный синтетический набор: 180 изделий. Начальное состояние содержит поступившие сигналы без решений людей; дальнейшие события открываются по ходу сценария.</p><p><strong>Подготовлено к развитию</strong>Серверная авторизация, интеграции и учебный MobileOps работают; подключение промышленных устройств, внешнее WORM-хранилище и фоновые уведомления остаются развитием.</p></div></Panel><Panel title="Словарь качества" eyebrow="ЕДИНЫЕ ПОНЯТИЯ"><dl className="glossary"><dt>Наблюдение</dt><dd>Что сообщил источник, включая качество и ограничения.</dd><dt>Несоответствие</dt><dd>Случай, который рассматривает и подтверждает контролёр.</dd><dt>Гипотеза</dt><dd>Возможная причина, ещё требующая доказательств.</dd><dt>Решение</dt><dd>Действие конкретного человека с основанием и временем.</dd><dt>Доработка</dt><dd>Новый запуск, связанный с исходной операцией.</dd></dl></Panel></div>;
  return <><Note>Это карта всех рабочих пространств. Выберите роль, чтобы посмотреть её интерфейс. В реальной системе доступ назначается администратором.</Note><div className="role-map">{roles.map(role => <Panel key={role.id} title={role.name} eyebrow={role.focus}><div className="map-modules">{[...role.primary, ...role.secondary].map(id => <button key={id} onClick={() => changeRole(role.id, id)}><Icon name={moduleById[id].icon}/><span><strong>{id === 'home' ? role.title : moduleById[id].label}</strong>{id !== 'home' && <small>{sectionsFor(role.id, id).map(s => s.label).join(' · ')}</small>}</span><Icon name="arrow" size={16}/></button>)}</div></Panel>)}</div></>;
}

export function WorkspaceView(props: ViewProps) {
  const { route, scope, openItem, openCase } = props;
  if (route.module === 'tasks' && route.role === 'technologist') {
    const requests = events.filter(event => event.event_type === 'evidence_request' && inScope(event, scope));
    return <div className="stack"><Panel title="Дела, требующие разбора" eyebrow="МОИ ЗАДАЧИ"><TaskList data={tasks.filter(task => task.role === 'technologist' && inScope(task.event, scope))} openItem={openItem} openCase={openCase}/></Panel><Panel title="Запросы сведений" eyebrow="СЛУЖБЫ ПРЕДПРИЯТИЯ">{requests.length ? <div className="event-list">{requests.slice().reverse().map(request => {
      const record = cases.find(row => row.id === request.data.case_id);
      const pending = record && pendingEvidenceRequests(record).some(event => event.event_id === request.event_id);
      return <button key={request.event_id} onClick={() => record && openCase(record.item, record.id)}><div><strong>{recipientName(request.data.recipient_role)} · {request.item_id}</strong><p>{request.data.reason}</p><small>{request.actor_id} · {time(request.occurred_at)}</small></div><Badge tone={pending ? 'amber' : 'green'}>{pending ? 'Ожидаем ответ' : 'Ответ получен'}</Badge><Icon name="arrow"/></button>;
    })}</div> : <Empty title="Запросов пока нет" text="Их можно отправить из вкладки «Заключение» выбранного дела."/>}</Panel></div>;
  }
  switch (route.module) {
    case 'home': return route.role === 'leader' ? <ProductionHeadView {...props}/> : <HomeView {...props}/>;
    case 'executive': return <ProductionHeadView {...props}/>;
    case 'quality': return <QualityView {...props}/>;
    case 'products': return <ProductsView {...props}/>;
    case 'production': return <ProductionView {...props}/>;
    case 'operations': return <MasterTerminal scope={scope} openItem={openItem}/>;
    case 'investigation': return route.role === 'technologist' && route.section === 'cases' ? <TechnologistWorkbench {...props}/> : <InvestigationView {...props}/>;
    case 'analytics': return route.role === 'technologist' ? <TechnologistAnalyticsView {...props}/> : ['controller', 'master'].includes(route.role) ? <RoleAnalyticsView key={route.role} {...props}/> : <AnalyticsView {...props}/>;
    case 'integrations': return <IntegrationsView {...props}/>;
    case 'events': return <EventsView {...props}/>;
    case 'security': if (route.section === 'audit' || route.section === 'integrity') return <SecurityAuditView/>; if (route.section === 'backup') return <SecurityBackupView/>; if (route.section === 'crypto') return <SecurityCryptoView/>; break;
    case 'mobile': return <MobileOpsView section={route.section} openItem={openItem}/>;
    case 'control': return <ControlView {...props}/>;
    case 'platform': return <PlatformView {...props}/>;
    case 'guide': return <GuideView {...props}/>;
    case 'tasks': if (route.role === 'master') return <MasterTerminal scope={scope} openItem={openItem}/>; if (route.section !== 'rules') return <><SmartQueue role={route.role} scope={scope} openItem={openItem}/><Panel title={route.section === 'team' ? 'Действия команды' : 'Задачи рабочего места'} eyebrow="СВЯЗЬ С ИЗДЕЛИЕМ И ОСНОВАНИЕМ"><TaskList data={tasks.filter(t => inScope(t.event, scope) && (route.section === 'team' || route.role === 'leader' || t.role === route.role))} openItem={openItem}/></Panel><Note>Показаны действия, выведенные из поступивших событий. Назначение исполнителей, сроки и уведомления будут подключены к сервису задач.</Note></>;
  }
  return <PreparedSection section={sectionsFor(route.role, route.module).find(s => s.id === route.section)!}/>;
}

