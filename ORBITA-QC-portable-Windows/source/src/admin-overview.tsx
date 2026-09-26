import { useCallback, useEffect, useState } from 'react';
import { ingestState } from './domain';
import type { ModuleId } from './navigation';
import { secureFetch } from './security-client';
import { Badge, Button, Icon, Note } from './ui';

type Navigate = (module: ModuleId, section?: string) => void;
type QueueEntry = { status: string; last_error?: string | null };
type IntegrationState = { mode: string; configured: boolean; orders: unknown[]; outbox: QueueEntry[] };
type PlantState = {
  mes: { configured: boolean; received: number; last_error: string | null; outbox: QueueEntry[] };
  cad: { configured: boolean; imports: unknown[] };
};
type MobileState = { robots: { online: boolean }[]; buffered: number; delivered: number };
type AuditState = { valid: boolean; entries: number };
type ContractState = { status: string; count: number; loadedAt: string };
type Overview = { integration?: IntegrationState; plant?: PlantState; mobile?: MobileState; audit?: AuditState; contracts?: ContractState };

async function read<T>(url: string): Promise<T> {
  const response = await secureFetch(url);
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error ?? `HTTP ${response.status}`), { status: response.status });
  return value as T;
}

const problemCount = (rows: QueueEntry[] = []) => rows.filter(row => row.status === 'failed').length;
const waitingCount = (rows: QueueEntry[] = []) => rows.filter(row => ['pending', 'sending', 'retry_wait'].includes(row.status)).length;

export function AdminOverview({ navigate }: { navigate: Navigate }) {
  const [data, setData] = useState<Overview>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [requiresLogin, setRequiresLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    const next: Overview = {};
    const failed: string[] = [];
    let loginRequired = false;
    const recordFailure = (label: string, problem: unknown) => {
      const error = problem as Error & { status?: number };
      if (error.status === 401) loginRequired = true;
      failed.push(`${label}: ${error.status === 401 ? 'Требуется вход' : error.message}`);
    };
    await Promise.all([
      read<IntegrationState>('/api/integrations/state').then(value => { next.integration = value; }).catch(error => recordFailure('ERP', error)),
      read<PlantState>('/api/plant/state').then(value => { next.plant = value; }).catch(error => recordFailure('MES/CAD', error)),
      read<MobileState>('/api/mobile/state').then(value => { next.mobile = value; }).catch(error => recordFailure('MobileOps', error)),
      read<AuditState>('/api/security/verify').then(value => { next.audit = value; }).catch(error => recordFailure('Аудит', error)),
      read<ContractState>('/api/contracts').then(value => { next.contracts = value; }).catch(error => recordFailure('Контракты', error)),
    ]);
    setData(next); setErrors(failed); setRequiresLogin(loginRequired); setBusy(false);
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15_000); return () => window.clearInterval(timer); }, [load]);

  const ingest = ingestState();
  const erpFailed = problemCount(data.integration?.outbox);
  const erpWaiting = waitingCount(data.integration?.outbox);
  const mesFailed = problemCount(data.plant?.mes.outbox);
  const mesWaiting = waitingCount(data.plant?.mes.outbox);
  const offline = data.mobile?.robots.filter(robot => !robot.online).length ?? 0;
  const alerts = [
    ...(ingest.counts.error ? [`Карантин входа: ${ingest.counts.error}`] : []),
    ...(erpFailed ? [`Ошибки ERP: ${erpFailed}`] : []),
    ...(mesFailed ? [`Ошибки MES: ${mesFailed}`] : []),
    ...(erpWaiting + mesWaiting ? [`Ожидают квитанции: ${erpWaiting + mesWaiting}`] : []),
    ...(data.mobile?.buffered ? [`MobileOps в буфере: ${data.mobile.buffered}`] : []),
    ...(offline ? [`Комплексы без связи: ${offline}`] : []),
    ...errors,
  ];
  const noDataStatus = requiresLogin ? 'Требуется вход' : 'Нет ответа';
  const noDataDetail = requiresLogin ? 'Сеанс завершён' : 'Нет ответа API';
  const components = [
    { name: 'ERP', icon: 'integrations', tone: !data.integration ? 'amber' : erpFailed ? 'red' : erpWaiting ? 'amber' : data.integration.configured ? 'green' : 'blue', status: !data.integration ? noDataStatus : erpFailed ? 'Есть ошибки' : erpWaiting ? 'Ожидает квитанцию' : data.integration.configured ? 'Работает' : 'Не настроено', detail: data.integration ? `${data.integration.mode} · ${data.integration.orders.length} заданий` : noDataDetail, module: 'integrations' as ModuleId, section: 'exchange' },
    { name: 'MES', icon: 'flow', tone: !data.plant ? 'amber' : data.plant.mes.last_error || mesFailed ? 'red' : mesWaiting ? 'amber' : data.plant.mes.configured ? 'green' : 'blue', status: !data.plant ? noDataStatus : data.plant.mes.last_error || mesFailed ? 'Есть ошибка' : mesWaiting ? 'Ожидает квитанцию' : data.plant.mes.configured ? 'Работает' : 'Не настроено', detail: data.plant ? `${data.plant.mes.received} фактов · ${data.plant.mes.outbox.length} решений` : noDataDetail, module: 'integrations' as ModuleId, section: 'mes' },
    { name: 'КОМПАС-3D', icon: 'box', tone: !data.plant ? 'amber' : data.plant.cad.configured ? 'green' : 'blue', status: !data.plant ? noDataStatus : data.plant.cad.configured ? 'Подключён' : 'Резервный импорт', detail: data.plant ? `${data.plant.cad.imports.length} импортированных ревизий` : noDataDetail, module: 'integrations' as ModuleId, section: 'cad' },
    { name: 'Поток событий', icon: 'events', tone: ingest.counts.error ? 'red' : ingest.counts.late ? 'amber' : 'green', status: ingest.counts.error ? 'Есть карантин' : ingest.counts.late ? 'Есть поздние' : 'Приём штатный', detail: `${ingest.counts.accepted + ingest.counts.late} принято · ${ingest.counts.error} ошибок`, module: 'events' as ModuleId, section: 'quality' },
    { name: 'MobileOps', icon: 'mobile', tone: !data.mobile ? 'amber' : offline || data.mobile.buffered ? 'amber' : 'green', status: !data.mobile ? noDataStatus : offline ? 'Потеря связи' : data.mobile.buffered ? 'Есть буфер' : 'На связи', detail: data.mobile ? `${data.mobile.robots.length - offline}/${data.mobile.robots.length} комплексов · ${data.mobile.buffered} в буфере` : noDataDetail, module: 'mobile' as ModuleId, section: 'connectivity' },
    { name: 'Аудит', icon: 'security', tone: !data.audit ? 'amber' : data.audit.valid ? 'green' : 'red', status: !data.audit ? noDataStatus : data.audit.valid ? 'Целостность подтверждена' : 'Проверка не пройдена', detail: data.audit ? `${data.audit.entries} защищённых записей` : noDataDetail, module: 'security' as ModuleId, section: 'audit' },
    { name: 'Контракты', icon: 'layer', tone: data.contracts?.status === 'loaded' && data.contracts.count === 5 ? 'green' : data.contracts ? 'red' : 'amber', status: data.contracts?.status === 'loaded' ? 'Загружены' : noDataStatus, detail: data.contracts ? `${data.contracts.count}/5 схем · JSON Schema 2020-12` : noDataDetail, module: 'integrations' as ModuleId, section: 'contracts' },
  ];
  return <section className="admin-command-center">
    <div className="admin-command-heading"><div><span className="eyebrow">ОПЕРАЦИОННОЕ СОСТОЯНИЕ</span><h2>Компоненты и обмен</h2><p>Фактическое состояние серверных контуров. «Не настроено» не считается аварией учебного стенда.</p></div><Button onClick={() => void load()} disabled={busy} icon="source">{busy ? 'Обновление…' : 'Обновить'}</Button></div>
    <div className="admin-status-grid">{components.map(component => <button key={component.name} className={`admin-status-card ${component.tone}`} onClick={() => navigate(component.module, component.section)}><span className="admin-status-icon"><Icon name={component.icon}/></span><span><strong>{component.name}</strong><small>{component.detail}</small></span><Badge tone={component.tone}>{component.status}</Badge></button>)}</div>
    {alerts.length ? <Note tone="amber" icon="alert"><strong>Требуют внимания:</strong> {alerts.join(' · ')}</Note> : <Note tone="green" icon="check">Очередей с ошибками и неподтверждённых доставок сейчас нет.</Note>}
    <div className="admin-quick-actions"><Button onClick={() => navigate('events', 'quality')}>Открыть карантин</Button><Button onClick={() => navigate('integrations', 'exchange')}>Проверить обмен</Button><Button onClick={() => navigate('security', 'audit')}>Проверить аудит</Button><Button onClick={() => navigate('integrations', 'contracts')}>Открыть контракты</Button></div>
  </section>;
}
