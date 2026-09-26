import { isProduction, secureImportText } from './security-client';
import { useState, type ChangeEvent } from 'react';
import { Badge, Button, Empty, Metric, Note, Panel } from './ui';
import { cases, defectNames, deliveryFor, describeEvent, events, eventNames, importText, ingestState, inScope, loadErrorDemo, nextStep, productStatus, resetDemo, setPlaying, sourceDeliveries, tasks, time, type Scope, type Task } from './domain';
import type { ViewProps } from './views';

/** Keep the expanded event priority queue inside the original role screens. */
export function SmartQueue({ scope, openItem, role }: { scope: Scope; openItem: (id: string) => void; role: ViewProps['route']['role'] }) {
  const [showHistory, setShowHistory] = useState(false);
  const [query, setQuery] = useState('');
  const [state, setState] = useState('all');
  const [urgency, setUrgency] = useState('all');
  const [line, setLine] = useState('all');
  const [shift, setShift] = useState('all');
  const [defect, setDefect] = useState('all');
  const [photo, setPhoto] = useState('all');
  const [assignment, setAssignment] = useState<string>(role);
  const relevant = tasks.filter(t => inScope(t.event, scope) && (assignment === 'all' || t.role === assignment));
  const history: Task[] = cases.map(c => ({ id: c.id, item: c.item, title: defectNames[c.type] ?? c.type, role: 'controller', event: c.observations.at(-1)!, done: !tasks.some(t => t.item === c.item && t.role === 'controller'), description: c.status, priority: c.priority, why: c.why }));
  const base = showHistory ? history : relevant;
  const filtered = base.filter(t => {
    const ownCase = cases.find(c => c.item === t.item);
    const status = productStatus(t.item);
    const hasPhoto = events.some(e => e.item_id === t.item && (e.data.evidence_refs?.length ?? 0) > 0);
    return (!query || `${t.item} ${t.title}`.toLowerCase().includes(query.toLowerCase()))
      && (state === 'all' || (state === 'held' ? /Удержано|Карантин|повторного/.test(status.label) : state === 'open' ? !t.done : t.done))
      && (urgency === 'all' || (urgency === 'critical' ? t.priority >= 120 : urgency === 'high' ? t.priority >= 70 && t.priority < 120 : t.priority < 70))
      && (line === 'all' || t.event.line_id === line) && (shift === 'all' || t.event.shift_id === shift)
      && (defect === 'all' || ownCase?.type === defect) && (photo === 'all' || (photo === 'yes' ? hasPhoto : !hasPhoto));
  }).sort((a, b) => b.priority - a.priority || a.item.localeCompare(b.item));
  return <Panel className="smart-queue" title={showHistory ? 'История сигналов и решений' : 'Открытая очередь работы'} eyebrow="ПРИОРИТЕТ — ОЧЕРЁДНОСТЬ ПРОВЕРКИ, НЕ ВЕРДИКТ"><div className="workspace-toolbar"><label className="local-search"><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Поиск по ID изделия" aria-label="Поиск по ID изделия"/></label><div className="filter-chips"><button className={!showHistory ? 'active' : ''} onClick={() => setShowHistory(false)}>Открытые</button><button className={showHistory ? 'active' : ''} onClick={() => setShowHistory(true)}>Вся история</button></div></div><div className="queue-filters">
    <label>Назначение<select value={assignment} onChange={e => setAssignment(e.target.value as typeof assignment)}><option value={role}>Моя роль</option><option value="all">Все роли</option><option value="controller">Контролёр</option><option value="master">Мастер</option><option value="technologist">Технолог</option></select></label>
    <label>Состояние<select value={state} onChange={e => setState(e.target.value)}><option value="all">Все</option><option value="open">Открытые</option><option value="held">Удержание</option><option value="closed">Закрытые</option></select></label>
    <label>Срочность<select value={urgency} onChange={e => setUrgency(e.target.value)}><option value="all">Все</option><option value="critical">Критическая</option><option value="high">Высокая</option><option value="medium">Средняя / низкая</option></select></label>
    <label>Линия<select value={line} onChange={e => setLine(e.target.value)}><option value="all">Все</option><option value="LINE-01">LINE-01</option><option value="LINE-02">LINE-02</option></select></label>
    <label>Смена<select value={shift} onChange={e => setShift(e.target.value)}><option value="all">Все</option><option value="SHIFT-A">Смена А</option><option value="SHIFT-B">Смена Б</option></select></label>
    <label>Признак<select value={defect} onChange={e => setDefect(e.target.value)}><option value="all">Все</option>{Object.entries(defectNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    <label>Фото<select value={photo} onChange={e => setPhoto(e.target.value)}><option value="all">Любое</option><option value="yes">Есть</option><option value="no">Нет</option></select></label>
  </div><div className="table-wrap"><table><thead><tr><th>Приоритет</th><th>Изделие и задача</th><th>Почему наверху</th><th>Состояние</th><th>Действие</th></tr></thead><tbody>{filtered.slice(0, 120).map(t => <tr key={t.id}><td><Badge tone={t.priority >= 120 ? 'red' : t.priority >= 70 ? 'amber' : 'blue'}>{t.priority >= 120 ? 'Критический' : t.priority >= 70 ? 'Высокий' : 'Средний'} · {t.priority}</Badge></td><td><button className="cell-link mono" onClick={() => openItem(t.item)}>{t.item}</button><small>{t.title} · {t.role === 'controller' ? 'ОТК' : t.role === 'master' ? 'Мастер' : 'Технолог'}</small></td><td className="wide-cell">{t.why}</td><td><Badge tone={productStatus(t.item).tone}>{productStatus(t.item).label}</Badge></td><td><Button onClick={() => openItem(t.item)}>Открыть</Button></td></tr>)}</tbody></table></div>{!filtered.length && <Empty title="Задач по фильтрам нет" text="Измените фильтры или откройте историю."/>}<p className="chart-caption">Показано {Math.min(filtered.length, 120)} из {filtered.length}. Нормальные изделия доступны в реестре и аналитике.</p></Panel>;
}

function SourcesPanel() {
  const pending = new Set(ingestState().pendingIds);
  const sourceIds = [...new Set(sourceDeliveries.map(row => row.message.source_id))].sort();
  return <Panel title="Состояние демоисточников" eyebrow="ЛОКАЛЬНЫЙ НАБОР · НЕ СЕТЕВОЕ ПОДКЛЮЧЕНИЕ"><div className="table-wrap"><table><thead><tr><th>Источник</th><th>Принято уникальных</th><th>Ожидают шага</th><th>Последняя доставка</th></tr></thead><tbody>{sourceIds.map(id => { const accepted = events.filter(e => e.source_id === id); const queued = sourceDeliveries.filter(row => row.message.source_id === id && pending.has(row.delivery_id)); const last = accepted.at(-1); return <tr key={id}><td className="mono">{id}</td><td>{accepted.length}</td><td><Badge tone={queued.length ? 'amber' : 'green'}>{queued.length}</Badge></td><td>{last ? time(deliveryFor(last.event_id)?.deliver_at ?? last.occurred_at) : 'Нет доставок'}</td></tr>; })}</tbody></table></div></Panel>;
}

/** Show accepted deliveries, duplicates, late arrivals and quarantined input. */
export function IngestOutcomes({ openItem }: { openItem: (id: string) => void }) {
  const state = ingestState();
  const [kind, setKind] = useState<'all' | 'error' | 'late' | 'duplicate'>('all');
  const [query, setQuery] = useState('');
  const rows = state.outcomes.filter(row => (kind === 'all' || row.kind === kind) && `${row.delivery_id} ${row.event_id} ${row.item_id} ${row.source_id ?? ''} ${row.reason}`.toLowerCase().includes(query.toLowerCase())).slice(0, 100);
  return <Panel title="Результат приёма и карантин" eyebrow="ПРИНЯТО · ДУБЛЬ · ПОЗДНЕЕ · ОШИБКА" action={<Badge tone={state.counts.error ? 'red' : 'green'}>{state.counts.error} в карантине</Badge>}>
    <div className="workspace-toolbar"><label className="local-search"><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Доставка, событие, источник…" aria-label="Поиск в журнале приёма"/></label><div className="filter-chips">{([['all', 'Все'], ['error', 'Карантин'], ['late', 'Поздние'], ['duplicate', 'Дубли']] as const).map(([value, label]) => <button key={value} className={kind === value ? 'active' : ''} onClick={() => setKind(value)}>{label}</button>)}</div></div>
    {rows.length ? <div className="table-wrap"><table><thead><tr><th>Доставка / время</th><th>Источник / событие</th><th>Изделие</th><th>Результат</th><th>Причина</th></tr></thead><tbody>{rows.map((row, i) => <tr key={`${row.delivery_id}-${i}`}><td className="mono">{row.delivery_id}<small>{row.received_at ? time(row.received_at) : 'Время старой записи не сохранено'}</small></td><td className="mono">{row.source_id ?? 'UNKNOWN'}<small>{row.event_id}</small></td><td>{row.item_id !== '?' ? <button className="cell-link mono" onClick={() => openItem(row.item_id)}>{row.item_id}</button> : '—'}</td><td><Badge tone={row.kind === 'error' ? 'red' : row.kind === 'late' ? 'amber' : row.kind === 'accepted' ? 'green' : 'blue'}>{row.kind === 'accepted' ? 'Принято' : row.kind === 'duplicate' ? 'Точный дубль' : row.kind === 'late' ? 'Позднее' : 'Карантин'}</Badge></td><td className="wide-cell">{row.reason}</td></tr>)}</tbody></table></div> : <Empty title="Записей по фильтру нет" text="Измените фильтр или загрузите внешние события."/>}
  </Panel>;
}

/** Controls and ingestion outcomes for the original replay tab. */
export function EventReplayView({ route, scope, openItem, navigate }: ViewProps) {
  const [query, setQuery] = useState(''); const [notice, setNotice] = useState('');
  const state = ingestState();
  const rows = events.filter(e => inScope(e, scope) && `${e.event_id} ${e.item_id} ${e.source_id}`.toLowerCase().includes(query.toLowerCase())).slice(-250).reverse();
  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target, file = input.files?.[0];
    if (!file) return;
    try {
      const result = isProduction() ? await secureImportText(await file.text()) : importText(await file.text());
      setNotice(`Файл ${file.name}: принято ${result.filter(x => x.kind === 'accepted' || x.kind === 'late').length}, дублей ${result.filter(x => x.kind === 'duplicate').length}, ошибок ${result.filter(x => x.kind === 'error').length}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Не удалось принять файл'); }
    finally { input.value = ''; }
  };
  return <><div className="metric-grid"><Metric label="Принято" value={state.counts.accepted} note="Обычный приём" icon="check" onClick={() => navigate('events', 'quality')}/><Metric label="Поздние" value={state.counts.late} note="Хронология по occurred_at" icon="clock" tone="amber" onClick={() => navigate('events', 'quality')}/><Metric label="Точные дубли" value={state.counts.duplicate} note="Не создают новый случай" icon="branch" onClick={() => navigate('events', 'quality')}/><Metric label="Карантин входа" value={state.counts.error} note="Причина указана в журнале" icon="alert" tone="red" onClick={() => navigate('events', 'quality')}/></div><Panel title={isProduction() ? 'Приём внешних событий' : 'Управление демопотоком'} eyebrow="ВНЕШНИЕ СООБЩЕНИЯ · РЕШЕНИЯ В ИНТЕРФЕЙСЕ"><div className="stream-controls">{!isProduction() && <><Button disabled={isProduction()} onClick={() => { resetDemo(); setNotice('Демо возвращено к состоянию до решений людей.'); }}>Загрузить встроенный набор</Button><Button disabled={isProduction()} onClick={() => { const result = nextStep(); setNotice(result ? `${result.event_id}: ${result.reason}` : 'Сейчас нет доступных событий. Выполните действие нужной роли.'); }}>Следующий шаг</Button><Button disabled={isProduction()} onClick={() => setPlaying(!state.playing)}>{state.playing ? 'Пауза' : 'Продолжить'}</Button><Button disabled={isProduction()} onClick={() => { resetDemo(); setNotice('Демо сброшено.'); }}>Сбросить</Button></>}<label className="button upload-button">Загрузить JSON / JSONL<input type="file" accept=".json,.jsonl,application/json" onChange={upload}/></label>{!isProduction() && <Button disabled={isProduction()} onClick={async () => { try { const result = await loadErrorDemo(); setNotice(`Тест ошибок: ${result.filter(x => x.kind === 'error').length} сообщений в карантине.`); } catch { setNotice('Не удалось открыть тестовый поток.'); } }}>Проверить ошибочный поток</Button>}</div>{isProduction() ? <p className="helper-text">Приём сохраняет исходные сообщения и результат каждой доставки. Повторы не создают новые события; ошибки остаются в карантине.</p> : <p className="helper-text">Ожидают следующего шага: {state.pendingIds.length}. События после решений остаются закрытыми, пока соответствующая роль не выполнит действие. Тестовый поток ошибок не подставляет решения людей.</p>}{notice && <Note>{notice}</Note>}</Panel>{!isProduction() && <SourcesPanel/>}<IngestOutcomes openItem={openItem}/>{route.section !== 'replay' && <Panel title="Журнал поступивших событий" eyebrow="ВРЕМЯ ОПЕРАЦИИ И ДОСТАВКИ"><div className="workspace-toolbar"><label className="local-search"><input value={query} onChange={e => setQuery(e.target.value)} placeholder="ID изделия или события" aria-label="Поиск событий"/></label><span>{rows.length} из {events.length} событий</span></div><div className="table-wrap"><table><thead><tr><th>Событие</th><th>Произошло / доставлено</th><th>Источник</th><th>Изделие</th><th>Суть</th></tr></thead><tbody>{rows.map(e => <tr key={e.event_id}><td className="mono">{e.event_id}</td><td>{time(e.occurred_at)}<small>доставка {deliveryFor(e.event_id) ? time(deliveryFor(e.event_id)!.deliver_at) : '—'}</small></td><td>{eventNames[e.event_type]}<small>{e.source_id}</small></td><td><button className="cell-link mono" onClick={() => openItem(e.item_id)}>{e.item_id}</button></td><td>{describeEvent(e)}</td></tr>)}</tbody></table></div></Panel>}</>;
}



