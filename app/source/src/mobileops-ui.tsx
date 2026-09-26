import { useEffect, useState } from 'react';
import { Badge, Button, Empty, Note, Panel } from './ui';
import { eventsFor, items, time } from './domain';
import { secureFetch, synchronizeMobileHistory } from './security-client';

type Robot = { id: string; lineId: string; online: boolean; sensors: string[]; simulator: boolean };
type Mission = { id: string; itemId: string; lineId: string; robotId: string; checkpoint: string; status: 'issued' | 'buffered' | 'delivered'; createdAt: string; createdBy: string; observationId: string | null; capturedAt: string | null; deliveredAt: string | null };
type DeliverySummary = { eventId: string; missionId: string; itemId: string; robotId: string; occurredAt: string; deliveredAt: string | null };
type MobileState = { robots: Robot[]; missions: Mission[]; buffered: number; delivered: number; bufferedEvents: DeliverySummary[]; recentDeliveries: DeliverySummary[] };
const checkpoints = [['CP-IN', 'Входной контроль'], ['CP-POST-MILL', 'После обработки'], ['CP-FINAL', 'После сборки']];
const statusLabel = { issued: 'Задание выдано', buffered: 'В локальном буфере', delivered: 'Наблюдение доставлено' };

async function api<T>(route: string, body?: object): Promise<T> {
  const response = await secureFetch(route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value as T;
}

export function MobileOpsView({ section, openItem }: { section: string; openItem: (id: string) => void }) {
  const [state, setState] = useState<MobileState | null>(null);
  const [itemId, setItemId] = useState('ITEM-013');
  const [checkpoint, setCheckpoint] = useState('CP-POST-MILL');
  const [result, setResult] = useState<'unable_to_assess' | 'no_signs_detected'>('unable_to_assess');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = async () => { const value = await api<MobileState>('/api/mobile/state'); setState(value); await synchronizeMobileHistory(); };
  useEffect(() => { void refresh().catch(problem => setError(problem instanceof Error ? problem.message : 'Состояние MobileOps недоступно')); }, []);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await action(); await refresh(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'Операция не выполнена'); }
    finally { setBusy(false); }
  };
  const lineId = eventsFor(itemId).at(-1)?.line_id;
  const robot = state?.robots.find(row => row.lineId === lineId);
  const missions = [...(state?.missions ?? [])].reverse();
  const create = () => run(() => api('/api/mobile/missions', { itemId, robotId: robot?.id, checkpoint }));
  const simulate = (id: string) => run(() => api(`/api/mobile/missions/${id}/simulate`, { result }));
  const link = (entry: Robot) => run(() => api(`/api/mobile/robots/${entry.id}/link`, { online: !entry.online }));

  return <div className="stack">
    <Note>Учебный эмулятор комплекса. Задания и наблюдения сохраняет сервер; реальный робот и беспроводной транспорт пока не подключены. Наблюдение не является решением о годности изделия.</Note>
    {error && <Note tone="amber">{error}</Note>}
    {section === 'missions' && <>
      <Panel title="Выдать задание на осмотр" eyebrow="МАСТЕР → МОБИЛЬНЫЙ КОМПЛЕКС">
        <div className="mobileops-controls">
          <label>Изделие<select value={itemId} onChange={event => setItemId(event.target.value)}>{items.filter(item => eventsFor(item.id).length).map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
          <label>Контрольная точка<select value={checkpoint} onChange={event => setCheckpoint(event.target.value)}>{checkpoints.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
          <div className="mobileops-assignee"><span>Комплекс на линии</span><strong>{robot?.id ?? 'Не назначен'}</strong><small>{lineId ?? 'Линия неизвестна'} · {robot?.online ? 'связь есть' : 'нет связи'}</small></div>
          <Button onClick={create} disabled={busy || !robot?.online} primary>Выдать задание</Button>
        </div>
      </Panel>
      <Panel title="Задания и результаты" eyebrow="ПРОСЛЕЖИВАЕМАЯ ДОСТАВКА" action={<Button onClick={() => void run(async () => {})} disabled={busy} icon="source">Обновить</Button>}>
        <div className="mobileops-controls"><label>Результат эмулятора<select value={result} onChange={event => setResult(event.target.value as typeof result)}><option value="unable_to_assess">Нужна очная оценка</option><option value="no_signs_detected">Признаков не выявлено</option></select></label><p>Если связь отключена, результат останется в буфере до восстановления.</p></div>
        {missions.length ? <div className="table-wrap"><table><thead><tr><th>Задание</th><th>Комплекс / точка</th><th>Состояние</th><th>Действие</th></tr></thead><tbody>{missions.map(mission => <tr key={mission.id}>
          <td><button className="cell-link mono" onClick={() => openItem(mission.itemId)}>{mission.itemId}</button><small>{time(mission.createdAt)} · {mission.createdBy}</small></td>
          <td>{mission.robotId}<small>{mission.checkpoint}</small></td>
          <td><Badge tone={mission.status === 'delivered' ? 'green' : mission.status === 'buffered' ? 'amber' : 'blue'}>{statusLabel[mission.status]}</Badge>{mission.observationId && <small className="mono">{mission.observationId}</small>}{mission.deliveredAt && <small>Принято {time(mission.deliveredAt)}</small>}</td>
          <td>{mission.status === 'issued' ? <Button onClick={() => simulate(mission.id)} disabled={busy}>Сымитировать осмотр</Button> : <span className="text-sub">{mission.status === 'buffered' ? 'Ожидает связь' : 'В истории изделия'}</span>}</td>
        </tr>)}</tbody></table></div> : <Empty title="Заданий пока нет" text="Выдайте первое задание и проверьте путь наблюдения до контролёра."/>}
      </Panel>
    </>}
    {section === 'robots' && <Panel title="Учебные комплексы" eyebrow="РЕЕСТР УСТРОЙСТВ">
      {state?.robots.map(entry => <div className="mobileops-robot" key={entry.id}><div><strong>{entry.id}</strong><small>{entry.lineId} · визуальный сенсор · эмулятор</small></div><Badge tone={entry.online ? 'green' : 'amber'}>{entry.online ? 'На связи' : 'Связь потеряна'}</Badge><Button onClick={() => link(entry)} disabled={busy}>{entry.online ? 'Отключить связь' : 'Восстановить связь'}</Button></div>)}
      <Note>Переключатель имитирует состояние канала. После восстановления сервер доставляет накопленные наблюдения один раз по идентификатору события.</Note>
    </Panel>}
    {section === 'connectivity' && <Panel title="Буфер и синхронизация" eyebrow="ПРОВЕРКА ПОТЕРИ СВЯЗИ">
      <div className="mobileops-summary"><div><strong>{state?.buffered ?? 0}</strong><span>ждут связи</span></div><div><strong>{state?.delivered ?? 0}</strong><span>доставлены в историю</span></div></div>
      {!!state?.bufferedEvents.length && <div className="mobileops-sync-list"><h3>Ожидают доставки</h3>{state.bufferedEvents.map(entry => <div key={entry.eventId}><span><strong>{entry.itemId}</strong><small>{entry.robotId} · {time(entry.occurredAt)}</small></span><Badge tone="amber">В буфере</Badge></div>)}</div>}
      {!!state?.recentDeliveries.length && <div className="mobileops-sync-list"><h3>Последние квитанции</h3>{state.recentDeliveries.map(entry => <div key={entry.eventId}><span><button className="cell-link mono" onClick={() => openItem(entry.itemId)}>{entry.itemId}</button><small>{entry.robotId} · {entry.eventId}</small></span><span className="mobileops-receipt"><Badge tone="green">Принято</Badge><small>{entry.deliveredAt ? time(entry.deliveredAt) : '—'}</small></span></div>)}</div>}
      <ol className="text-steps"><li>Выдайте задание, пока комплекс на связи.</li><li>В разделе «Комплексы» отключите связь и сымитируйте осмотр.</li><li>Наблюдение останется в зашифрованном серверном буфере.</li><li>Восстановите связь: сервер подтвердит доставку и добавит исходное событие в историю изделия.</li></ol>
      <Note>В будущем вместо локального эмулятора можно подключить шлюз робота с теми же идентификаторами задания и события. Транспорт и удостоверение устройства потребуется настроить отдельно.</Note>
    </Panel>}
  </div>;
}
