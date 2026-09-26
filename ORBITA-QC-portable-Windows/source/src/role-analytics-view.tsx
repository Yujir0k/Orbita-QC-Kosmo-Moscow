import { useEffect, useMemo, useState } from 'react';
import { cases, events, tasks, defectNames, stationNames, getVersion, type Scope } from './domain';
import { currentSecurityUser } from './security-client';
import { dayKey } from './technologist-analytics';
import { buildRoleAnalytics, roleTitles, type AnalyticsRole, type AnalyticsSection, type RoleDashboard, type RoleFilter } from './role-analytics';
import { dashboardCsv, dashboardHtml, downloadAnalytics, rowsCsv, filterText, type SnapshotMeta } from './analytics-export';
import type { ViewProps } from './views';
import { Button, Empty, Metric, Note, Panel } from './ui';
import { Modal } from './dialogs';

export const reportNames: Record<AnalyticsRole,string> = { controller: 'Сменный отчёт ОТК', master: 'Сменный отчёт участка и передача работ', leader: 'Сводка качества и производственных рисков' };
function initialFilter(role: AnalyticsRole, scope: Scope): RoleFilter {
  const fallback: RoleFilter = { from: '', to: '', line: 'all', station: 'all', scope };
  try { const saved = JSON.parse(sessionStorage.getItem(`orbita-analytics-${role}`) ?? 'null'); if (saved) for (const key of ['from','to','line','station'] as const) if (typeof saved[key] === 'string') fallback[key] = saved[key]; } catch { /* Defaults also work with browser storage disabled. */ }
  return fallback;
}
function AnalyticsTable({ section, model, openItem, openCase }: { section: AnalyticsSection; model: RoleDashboard; openItem: ViewProps['openItem']; openCase: ViewProps['openCase'] }) {
  const [search, setSearch] = useState(''); const [page, setPage] = useState(0);
  const filtered = section.rows.filter(r => r.cells.join(' ').toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru')));
  const lastPage = Math.max(0, Math.ceil(filtered.length / 15) - 1); const current = Math.min(page, lastPage);
  return <Panel title={section.title} eyebrow="ПРИНЯТЫЕ ДАННЫЕ" action={<Button disabled={!filtered.length} icon="file" onClick={() => downloadAnalytics(rowsCsv([[section.title], [section.note], ['Фильтры', filterText(model)], ['Роль', model.role], ['Сформирован', new Date().toISOString()], ['Поиск в таблице', search], section.headers, ...filtered.map(r => r.cells)]), `orbita-${section.id}.csv`, 'text/csv;charset=utf-8')}>CSV таблицы</Button>}>
    <p className="chart-caption">{section.note}</p>
    {!!section.chart?.length && <div className="ra-bars" aria-label={section.title}>{section.chart.slice(0,12).map(row => <div key={row.label}><span>{row.label}</span><strong>{row.value}</strong><i style={{ width: `${row.value / Math.max(1,...section.chart!.map(r => r.value))*100}%` }}/></div>)}{section.chart.length>12&&<small>Первые 12 групп; все записи доступны в таблице и экспорте.</small>}</div>}
    <div className="ra-table-toolbar"><label>Поиск в таблице<input value={search} placeholder="Изделие, статус, исполнитель…" onChange={e => { setSearch(e.target.value); setPage(0); }}/></label><span>{filtered.length} из {section.rows.length} записей</span>{search&&<Button onClick={() => setSearch('')}>Очистить</Button>}</div>
    {filtered.length ? <><div className="table-wrap"><table><thead><tr>{section.headers.map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{filtered.slice(current*15, current*15+15).map(row => <tr key={row.id}>{row.cells.map((cell,i) => <td key={i}>{i===0 && row.item ? <button type="button" className="cell-link" onClick={() => row.caseId ? openCase(row.item!,row.caseId) : openItem(row.item!)}>{cell}</button> : cell}</td>)}</tr>)}</tbody></table></div><div className="ra-pagination"><Button disabled={!current} onClick={() => setPage(current-1)}>Назад</Button><span>{current+1} / {lastPage+1}</span><Button disabled={current>=lastPage} onClick={() => setPage(current+1)}>Далее</Button></div></> : <Empty title="Записей нет" text={search ? 'Измените поиск в таблице.' : 'Измените период или дождитесь данных по выбранной области.'}/>}
  </Panel>;
}
function RoleReport({ model }: { model: RoleDashboard }) {
  const [title, setTitle] = useState(reportNames[model.role]);
  const [selected, setSelected] = useState(() => model.sections.map(s => s.id));
  const [snapshot, setSnapshot] = useState<{ html:string; csv:string; meta:SnapshotMeta } | null>(null);
  const [preview, setPreview] = useState(false);
  const create = () => {
    const meta = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), author: currentSecurityUser()?.id ?? 'Учебный просмотр', title: title.trim(), revision: getVersion() };
    const sections = model.sections.filter(s => selected.includes(s.id));
    setSnapshot({ meta, html: dashboardHtml(model,meta,sections), csv: dashboardCsv(model,meta,sections) }); setPreview(true);
  };
  const download = (format: 'html'|'csv') => { if (snapshot) downloadAnalytics(snapshot[format], `orbita-${model.role}-${snapshot.meta.id}.${format}`, format==='html'?'text/html;charset=utf-8':'text/csv;charset=utf-8'); };
  return <><Panel title={reportNames[model.role]} eyebrow="ЗАФИКСИРОВАТЬ ВЫБРАННЫЙ СРЕЗ"><div className="ta-report-layout"><div className="ta-report-form"><label>Название отчёта<input value={title} onChange={e => setTitle(e.target.value)}/></label><fieldset><legend>Разделы отчёта</legend>{model.sections.map(s => <label key={s.id}><input type="checkbox" checked={selected.includes(s.id)} onChange={e => setSelected(old => e.target.checked ? [...old,s.id] : old.filter(id=>id!==s.id))}/>{s.title}</label>)}</fieldset><Button primary disabled={!title.trim()||!selected.length} onClick={create}>Сформировать снимок</Button></div><div className="ta-report-explanation"><h3>Дашборд, таблицы и основания</h3><p>HTML содержит графики и все строки выбранных таблиц; работает без интернета. Внутри него есть кнопка «Печать / сохранить PDF».</p><p>CSV подходит для дальнейшей работы в Excel. Поиск и пагинация отдельных таблиц не сокращают общий отчёт.</p><p>Фильтры, роль, автор, версия данных и определения показателей входят в оба формата. Числа фиксируются при формировании.</p>{snapshot&&<><p>Готов снимок от {new Date(snapshot.meta.createdAt).toLocaleString('ru-RU')}. Изменение фильтров не меняет сохранённый снимок.</p><div className="ta-report-actions"><Button onClick={()=>setPreview(true)}>Просмотреть</Button><Button onClick={()=>download('html')}>HTML / PDF</Button><Button onClick={()=>download('csv')}>CSV</Button></div></>}</div></div></Panel>{preview&&snapshot&&<Modal title="Предпросмотр ролевого отчёта" className="ta-report-dialog" onClose={()=>setPreview(false)}><div className="ta-report-preview-header"><h2>{snapshot.meta.title}</h2><Button onClick={()=>download('html')}>Скачать HTML</Button><Button onClick={()=>download('csv')}>Скачать CSV</Button><Button onClick={()=>setPreview(false)}>Закрыть</Button></div><iframe title="Снимок ролевой аналитики" sandbox="allow-scripts allow-modals" srcDoc={snapshot.html}/></Modal>}</>;
}
export function RoleAnalyticsView(props: ViewProps) {
  const { route, scope, openItem, openCase, navigate } = props;
  const role = route.role as AnalyticsRole;
  const [filter, setFilter] = useState(() => initialFilter(role, scope));
  const user = currentSecurityUser();
  const allowed = user?.lineIds;
  const visibleEvents = useMemo(() => events.filter(e => !allowed || allowed.includes(e.line_id)), [events,allowed]);
  const allowedIds = useMemo(() => new Set(visibleEvents.map(e=>e.event_id)),[visibleEvents]);
  const model = useMemo(() => buildRoleAnalytics({ events: visibleEvents, cases: cases.filter(c => c.observations.every(e=>allowedIds.has(e.event_id))).map(c => ({...c,decisions:c.decisions.filter(e=>allowedIds.has(e.event_id)),review:c.review&&allowedIds.has(c.review.event_id)?c.review:undefined})), tasks: tasks.filter(t=>allowedIds.has(t.event.event_id)), defectNames, stationNames }, role, { ...filter, scope }), [visibleEvents,allowedIds,role,filter,scope,cases,tasks]);
  useEffect(() => { try { sessionStorage.setItem(`orbita-analytics-${role}`,JSON.stringify(filter)); } catch { /* Optional. */ } }, [filter,role]);
  const change = (key: keyof RoleFilter, value:string) => setFilter(old=>({...old,[key]:value,...(key==='line'?{station:'all'}:{})}));
  const lines = [...new Set(visibleEvents.map(e=>e.line_id))].sort();
  const stations = [...new Set(visibleEvents.filter(e=>filter.line==='all'||e.line_id===filter.line).map(e=>e.station_id))].sort();
  const invalid = !!filter.from&&!!filter.to&&filter.from>filter.to;
  const sections = route.section==='overview' ? model.sections.filter(s => s.tab==='overview'||s.id==='trend'||role==='master'&&['queue','reworks'].includes(s.id)) : model.sections.filter(s=>s.tab===route.section);
  const period = visibleEvents.map(e=>dayKey(e.occurred_at)).sort();
  return <div className="ta-dashboard ra-dashboard"><div className="ra-heading"><div><span className="eyebrow">{roleTitles[role]}</span><p>{filter.from||period[0]||'Нет данных'} — {filter.to||period.at(-1)||'Нет данных'} · Москва · {scope==='all'?'Все смены':scope}</p></div><Button icon="file" onClick={()=>navigate('analytics','reports')}>Отчёт и экспорт</Button></div><div className="ta-filter-bar"><label>С<input type="date" aria-label="Аналитика: дата начала" value={filter.from} onChange={e=>change('from',e.target.value)}/></label><label>По<input type="date" aria-label="Аналитика: дата окончания" value={filter.to} onChange={e=>change('to',e.target.value)}/></label><label>Линия<select aria-label="Аналитика: линия" value={filter.line} onChange={e=>change('line',e.target.value)}><option value="all">Все доступные линии</option>{lines.map(id=><option key={id}>{id}</option>)}</select></label><label>Участок<select aria-label="Аналитика: участок" value={filter.station} onChange={e=>change('station',e.target.value)}><option value="all">Все участки</option>{stations.map(id=><option key={id} value={id}>{stationNames[id]??id}</option>)}</select></label><Button onClick={()=>setFilter({from:'',to:'',line:'all',station:'all',scope})}>Сбросить фильтры</Button></div>
  {invalid?<Note tone="amber">Дата начала должна быть не позже даты окончания.</Note>:<><div className="metric-grid ra-metrics">{model.metrics.map(m=><Metric key={m.label} label={m.label} value={m.value} note={m.note} icon="analytics" onClick={()=>navigate('analytics',m.tab)}/>)}</div>{route.section==='reports'?<RoleReport model={model}/>:<>{route.section==='overview'&&<Panel title="На что обратить внимание" eyebrow="СЛЕДУЮЩИЕ ДЕЙСТВИЯ"><ul className="ta-insights">{model.insights.map(s=><li key={s}>{s}</li>)}</ul></Panel>}{sections.map(s=><AnalyticsTable key={`${role}-${s.id}`} section={s} model={model} openItem={openItem} openCase={openCase}/>)}</>}<details className="ra-method"><summary>Как рассчитаны показатели</summary>{model.definitions.map(d=><p key={d}>{d}</p>)}</details></>}
  </div>;
}
