import { isProduction } from './security-client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { events, items, time } from './domain';
import { Badge, Button, Empty, Note, Panel } from './ui';
import { secureFetch } from './security-client';

type Payload = { item_id: string; work_order_id: string; quality_status: 'accepted' | 'quarantined' | 'released_after_rework' | 'rework_required' | 'scrapped'; basis_event_ids: string[] };
type Order = { delivery_id: string; received_at: string; message: { message_id: string; payload: { work_order_id: string; item_ids: string[]; quantity: number; assembly_revision: string } }; external_refs?: { order_key: string; item_keys: Record<string, string> } };
type Receipt = { message_id: string; status: string; error_code: string | null; attempt: number };
type Outbox = { message: { correlation_key: string; payload: Payload }; status: string; attempts: number; receipts: Receipt[]; last_error: string | null; next_retry_at: string | null; created_at: string };
type Assembly = { assembly_id: string; item_type_id: string; revision: string; geometry_included: false; components: { component_type_id: string; quantity: number; parent: string }[]; imported_at?: string };
type IntegrationState = { mode: string; profile: 'emulator' | '1c' | 'galaktika'; configured: boolean; available_orders: string[]; orders: Order[]; outbox: Outbox[]; assemblies: Assembly[]; emulator_received: number; sample_results: Payload[]; sample_assembly: Assembly };
type PlantState = { mes: { configured: boolean; cursor: string; received: number; last_error: string | null; deliveries: { message: { event_id: string; event_type: string; item_id: string } }[]; outbox: { event: { event_id: string; item_id: string }; status: string; attempts: number; last_error: string | null }[] }; cad: { configured: boolean; available_assemblies: string[]; imports: { assembly_id: string; revision: string; imported_at: string }[] } };

async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await secureFetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value as T;
}

function useIntegration() {
  const [state, setState] = useState<IntegrationState | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setState(await api<IntegrationState>('/api/integrations/state')); setError(''); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Сервер недоступен'); }
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 2000); return () => window.clearInterval(timer); }, [load]);
  return { state, error, load };
}

function usePlantState() {
  const [state, setState] = useState<PlantState | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setState(await api<PlantState>('/api/plant/state')); setError(''); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Сервер недоступен'); }
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 2000); return () => window.clearInterval(timer); }, [load]);
  return { state, error, load };
}

const statusLabel: Record<string, string> = { accepted: 'Принято ERP', sending: 'Отправляется', pending: 'Ожидает', retry_wait: 'Повторная отправка', failed: 'Ошибка доставки' };
const qualityLabel: Record<Payload['quality_status'], string> = { accepted: 'Годно', quarantined: 'Карантин', released_after_rework: 'Выпущено после доработки', rework_required: 'Направлено на доработку', scrapped: 'Списание подтверждено ОТК' };

export function AdminExchangeView() {
  const { state, error, load } = useIntegration();
  const [orderId, setOrderId] = useState('WO-B');
  const [resultKey, setResultKey] = useState('sample:ITEM-007');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const liveResults = useMemo(() => {
    const latest = new Map<string, Payload>();
    for (const event of events) {
      if (event.event_type !== 'quality_decision') continue;
      const item = items.find(row => row.id === event.item_id);
      if (!item) continue;
      const decision = event.data.decision;
      if (!['confirmed', 'rejected', 'release_after_rework', 'scrap_approved'].includes(decision ?? '')) continue;
      const status: Payload['quality_status'] = event.data.disposition === 'scrap' ? 'scrapped' : event.data.disposition === 'rework' ? 'rework_required' : decision === 'release_after_rework' ? 'released_after_rework' : event.data.disposition === 'release' ? 'accepted' : 'quarantined';
      latest.set(item.id, { item_id: item.id, work_order_id: item.work_order_id, quality_status: status, basis_event_ids: [event.event_id] });
    }
    return [...latest.values()];
  }, [state]);
  const options = [
    ...liveResults.filter(row => state?.orders.some(order => order.message.payload.item_ids.includes(row.item_id))).map(row => ({ key: `live:${row.item_id}`, label: `${row.item_id} · ${qualityLabel[row.quality_status]} · решение в приложении`, payload: row })),
    ...(isProduction() ? [] : state?.sample_results ?? []).filter(row => state?.orders.some(order => order.message.payload.item_ids.includes(row.item_id))).map(row => ({ key: `sample:${row.item_id}`, label: `${row.item_id} · ${qualityLabel[row.quality_status]} · пример из набора`, payload: row })),
  ];
  const selected = options.find(option => option.key === resultKey) ?? options[0];
  const act = async (work: () => Promise<unknown>, message: string) => {
    setBusy(true); setNotice('');
    try { await work(); await load(); setNotice(message); }
    catch (problem) { setNotice(problem instanceof Error ? problem.message : 'Ошибка обмена'); }
    finally { setBusy(false); }
  };
  return <>
    <Note>Активный профиль: {state?.mode ?? 'сервер недоступен'}. {state?.profile === 'emulator' ? 'Работает локальный ERP-эмулятор.' : 'Адаптер ожидает согласованный HTTP/JSON-шлюз установленной ERP.'} Задания и квитанции сохраняются сервером на диск.</Note>
    {state && !state.configured && <Note tone="amber">Профиль не настроен: задайте адрес шлюза ERP и файл сопоставления ID на сервере.</Note>}
    {error && <Note tone="amber">API недоступен: {error}. Запустите приложение через portable server.mjs.</Note>}
    <div className="metric-grid integration-metrics">
      <div className="integration-kpi"><span>Получено заданий</span><strong>{state?.orders.length ?? '—'}</strong></div>
      <div className="integration-kpi"><span>Подтверждено результатов</span><strong>{state?.outbox.filter(row => row.status === 'accepted').length ?? '—'}</strong></div>
      <div className="integration-kpi"><span>Ожидают подтверждения</span><strong>{state?.outbox.filter(row => ['pending', 'sending', 'retry_wait'].includes(row.status)).length ?? '—'}</strong></div>
      <div className="integration-kpi"><span>Ошибки доставки</span><strong>{state?.outbox.filter(row => row.status === 'failed').length ?? '—'}</strong></div>
    </div>
    <div className="two-columns">
      <Panel title="1. Получить задание" eyebrow="ERP → ОРБИТА.QC"><p className="panel-description">Выберите внутренний ID заказа. Сервер запросит его у активной ERP и проверит номера изделий.</p><div className="integration-form"><label>Заказ<select value={state?.available_orders.includes(orderId) ? orderId : state?.available_orders[0] ?? ''} onChange={event => setOrderId(event.target.value)}>{(state?.available_orders ?? []).map(id => <option key={id}>{id}</option>)}</select></label><Button primary disabled={!state?.configured || !state.available_orders.length || busy} onClick={() => { const id = state?.available_orders.includes(orderId) ? orderId : state?.available_orders[0]; if (id) void act(() => api('/api/integrations/pull', { work_order_id: id }), `Задание ${id} получено и сохранено`); }}>Получить из ERP</Button></div><p className="helper-text">Повторное получение того же задания не создаёт дубликат.</p></Panel>
      <Panel title="2. Передать результат" eyebrow="ОРБИТА.QC → ERP"><p className="panel-description">После получения задания отправьте подтверждённое решение или воспроизводимый пример из набора.</p><div className="integration-form"><label>Результат<select value={selected?.key ?? ''} onChange={event => setResultKey(event.target.value)}>{options.length ? options.map(option => <option key={option.key} value={option.key}>{option.label}</option>) : <option value="">Сначала получите задание</option>}</select></label><Button primary disabled={!state?.configured || !selected || busy} onClick={() => void act(() => api('/api/integrations/results', selected.payload), `Результат ${selected.payload.item_id} поставлен в обмен`)}>Отправить в ERP</Button></div><p className="helper-text">{state?.profile === 'emulator' ? 'Для ITEM-007 первая попытка вернёт временную ошибку. Сервер повторит отправку автоматически.' : 'При временном отказе сервер повторит отправку с тем же ключом идемпотентности.'}</p></Panel>
    </div>
    {notice && <Note tone="blue">{notice}</Note>}
    <Panel title="Полученные задания" eyebrow="ВХОДЯЩИЙ ЖУРНАЛ">{state?.orders.length ? <div className="table-wrap"><table><thead><tr><th>Заказ</th><th>Изделия</th><th>Ревизия</th><th>Получен</th></tr></thead><tbody>{state.orders.map(row => <tr key={row.delivery_id}><td className="mono">{row.message.payload.work_order_id}<small>{row.message.message_id}</small></td><td>{row.message.payload.item_ids.join(', ')}</td><td>{row.message.payload.assembly_revision}</td><td>{time(row.received_at)}</td></tr>)}</tbody></table></div> : <Empty title="Заданий пока нет" text="Выберите заказ и получите его из активного профиля ERP." />}</Panel>
    <Panel title="Исходящие результаты и квитанции" eyebrow="ЖУРНАЛ ДОСТАВКИ">{state?.outbox.length ? <div className="table-wrap"><table><thead><tr><th>Сообщение</th><th>Изделие / решение</th><th>Состояние</th><th>Попытки и квитанции</th><th>Действие</th></tr></thead><tbody>{[...state.outbox].reverse().map(row => <tr key={row.message.correlation_key}><td className="mono">{row.message.correlation_key}</td><td>{row.message.payload.item_id}<small>{qualityLabel[row.message.payload.quality_status]}</small></td><td><Badge tone={row.status === 'accepted' ? 'green' : 'amber'}>{statusLabel[row.status] ?? row.status}</Badge>{row.last_error && <small>{row.last_error}</small>}</td><td>{row.attempts} попыток<small>{row.receipts.at(-1)?.message_id ?? 'Нет квитанции'}</small></td><td>{row.status !== 'accepted' && <Button disabled={busy} onClick={() => void act(() => api(`/api/integrations/retry/${encodeURIComponent(row.message.correlation_key)}`, {}), 'Повтор выполнен')}>Повторить</Button>}</td></tr>)}</tbody></table></div> : <Empty title="Исходящих сообщений пока нет" text="Отправьте результат контроля после получения задания." />}</Panel>
  </>;
}

export function AdminCadView() {
  const { state, error, load } = useIntegration();
  const { state: plant, error: plantError } = usePlantState();
  const [assemblyId, setAssemblyId] = useState('ASM-BRACKET-01');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const upload = async (content: Assembly) => {
    setBusy(true);
    try { const result = await api<{ status: string }>('/api/integrations/cad', content); await load(); setNotice(result.status === 'duplicate' ? 'Такая ревизия уже импортирована.' : 'Структура сборки импортирована.'); }
    catch (problem) { setNotice(problem instanceof Error ? problem.message : 'Ошибка импорта'); }
    finally { setBusy(false); }
  };
  const pull = async () => {
    setBusy(true);
    try {
      const id = plant?.cad.available_assemblies.includes(assemblyId) ? assemblyId : plant?.cad.available_assemblies[0];
      if (!id) return;
      const result = await api<{ status: string }>('/api/plant/cad/pull', { assembly_id: id });
      await load(); setNotice(result.status === 'duplicate' ? 'Ревизия уже импортирована.' : `Сборка ${id} получена через адаптер.`);
    } catch (problem) { setNotice(problem instanceof Error ? problem.message : 'Ошибка адаптера КОМПАС-3D'); }
    finally { setBusy(false); }
  };
  return <>
    <Note>Резервный импорт JSON работает локально. При настроенном SDK-адаптере можно запросить структуру сборки напрямую; геометрия в этот контур не передаётся.</Note>
    {(error || plantError) && <Note tone="amber">API недоступен: {error || plantError}</Note>}
    <Panel title="Импорт сборки" eyebrow="КОМПАС-3D → ОРБИТА.QC">
      <div className="integration-form">
        <Button primary disabled={!state || busy} onClick={() => state && void upload(state.sample_assembly)}>Импортировать пример</Button>
        <label className="button upload-button">Выбрать JSON<input type="file" accept=".json,application/json" onChange={event => { const file = event.target.files?.[0]; if (file) void file.text().then(text => upload(JSON.parse(text) as Assembly)).catch(problem => setNotice(problem.message)); event.target.value = ''; }} /></label>
      </div>
      <div className="integration-form">
        <label>Сборка в КОМПАС-3D<select value={plant?.cad.available_assemblies.includes(assemblyId) ? assemblyId : plant?.cad.available_assemblies[0] ?? ''} onChange={event => setAssemblyId(event.target.value)}>{(plant?.cad.available_assemblies ?? []).map(id => <option key={id}>{id}</option>)}</select></label>
        <Button disabled={!plant?.cad.configured || busy} onClick={() => void pull()}>Получить через адаптер</Button>
      </div>
      {!plant?.cad.configured && <p className="helper-text">Для прямого запроса нужен локальный адаптер КОМПАС-3D и файл сопоставления ID.</p>}
      {notice && <Note>{notice}</Note>}
    </Panel>
    <Panel title="Версии сборок" eyebrow="СОХРАНЁННАЯ СТРУКТУРА">{state?.assemblies.length ? state.assemblies.map(assembly => <div className="assembly-entry" key={`${assembly.assembly_id}:${assembly.revision}`}><strong>{assembly.assembly_id} · ревизия {assembly.revision}</strong><small>{assembly.components.map(c => `${c.component_type_id} × ${c.quantity}`).join(' · ')}</small><Badge>Без геометрии</Badge></div>) : <Empty title="Сборки ещё не импортированы" text="Загрузите пример или подключите адаптер КОМПАС-3D." />}</Panel>
  </>;
}

export function AdminMesView() {
  const { state, error, load } = usePlantState();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const retry = async (eventId: string) => {
    setBusy(true); setNotice('');
    try { await api(`/api/plant/mes/retry/${encodeURIComponent(eventId)}`, {}); await load(); setNotice(`Повтор решения ${eventId} выполнен.`); }
    catch (problem) { setNotice(problem instanceof Error ? problem.message : 'Повтор MES не выполнен'); }
    finally { setBusy(false); }
  };
  return <>
    <Note>При настроенном шлюзе MES факты операций поступают автоматически. Решения ОТК передаются после записи в паспорте изделия, без отдельного ввода в MES.</Note>
    {error && <Note tone="amber">API недоступен: {error}</Note>}
    {state && !state.mes.configured && <Note tone="amber">Шлюз MES и сопоставления ID пока не настроены. Учебный поток приложения продолжает работать.</Note>}
    {state?.mes.last_error && <Note tone="amber">Последняя ошибка MES: {state.mes.last_error}</Note>}
    {notice && <Note>{notice}</Note>}
    <div className="metric-grid integration-metrics">
      <div className="integration-kpi"><span>Получено фактов MES</span><strong>{state?.mes.received ?? '—'}</strong></div>
      <div className="integration-kpi"><span>Подтверждено решений</span><strong>{state?.mes.outbox.filter(row => row.status === 'accepted').length ?? '—'}</strong></div>
      <div className="integration-kpi"><span>Ожидают подтверждения</span><strong>{state?.mes.outbox.filter(row => ['pending', 'sending', 'retry_wait'].includes(row.status)).length ?? '—'}</strong></div>
      <div className="integration-kpi"><span>Ошибки доставки</span><strong>{state?.mes.outbox.filter(row => row.status === 'failed').length ?? '—'}</strong></div>
    </div>
    <Panel title="Факты операций" eyebrow="MES → ОРБИТА.QC">{state?.mes.deliveries.length ? <div className="table-wrap"><table><thead><tr><th>Событие</th><th>Тип</th><th>Изделие</th></tr></thead><tbody>{[...state.mes.deliveries].reverse().slice(0, 20).map(row => <tr key={row.message.event_id}><td className="mono">{row.message.event_id}</td><td>{row.message.event_type}</td><td>{row.message.item_id}</td></tr>)}</tbody></table></div> : <Empty title="Фактов MES пока нет" text="После настройки шлюза они будут поступать автоматически." />}</Panel>
    <Panel title="Решения ОТК для MES" eyebrow="ОРБИТА.QC → MES">{state?.mes.outbox.length ? <div className="table-wrap"><table><thead><tr><th>Решение</th><th>Изделие</th><th>Состояние</th><th>Попытки</th><th>Действие</th></tr></thead><tbody>{[...state.mes.outbox].reverse().map(row => <tr key={row.event.event_id}><td className="mono">{row.event.event_id}</td><td>{row.event.item_id}</td><td><Badge tone={row.status === 'accepted' ? 'green' : row.status === 'failed' ? 'red' : 'amber'}>{statusLabel[row.status] ?? row.status}</Badge>{row.last_error && <small>{row.last_error}</small>}</td><td>{row.attempts}</td><td>{row.status !== 'accepted' && <Button disabled={busy || !state.mes.configured} onClick={() => void retry(row.event.event_id)}>Повторить</Button>}</td></tr>)}</tbody></table></div> : <Empty title="Решений для MES пока нет" text="Запишите решение контролёра в паспорте изделия." />}</Panel>
  </>;
}

export function AdminMappingsView() {
  const { state, error } = useIntegration();
  const rows = state?.orders.flatMap(order => order.message.payload.item_ids.map(itemId => ({ externalOrder: order.external_refs?.order_key ?? order.message.payload.work_order_id, externalItem: order.external_refs?.item_keys?.[itemId] ?? itemId, internalItem: itemId, revision: order.message.payload.assembly_revision }))) ?? [];
  return <><Note>ERP владеет номером заказа и номенклатурой; ОРБИТА.QC хранит решения контроля. Для адаптеров внешние ID явно сопоставляются с внутренними; неизвестные ключи отклоняются.</Note>{error && <Note tone="amber">API недоступен: {error}</Note>}<Panel title="Связи полученных заданий" eyebrow="ERP ↔ ВНУТРЕННЯЯ МОДЕЛЬ">{rows.length ? <div className="table-wrap"><table><thead><tr><th>Заказ ERP</th><th>ID в ERP</th><th>ID в ОРБИТА.QC</th><th>Ревизия сборки</th></tr></thead><tbody>{rows.map(row => <tr key={`${row.externalOrder}:${row.externalItem}`}><td className="mono">{row.externalOrder}</td><td className="mono">{row.externalItem}</td><td className="mono">{row.internalItem}</td><td>{row.revision}</td></tr>)}</tbody></table></div> : <Empty title="Сопоставлений пока нет" text="Получите задание в журнале обмена, чтобы увидеть связи ID." />}</Panel><Note tone="amber">Для подключения к установленной ERP заполните таблицы ключей заказов, номенклатуры и серийных номеров в файле сопоставления.</Note></>;
}
