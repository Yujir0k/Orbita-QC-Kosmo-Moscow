import { useEffect, useState } from 'react';
import { Badge, Button, Empty, Note, Panel } from './ui';
import { secureFetch } from './security-client';

const json = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const response = await secureFetch(url, init);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value as T;
};
const bytes = (value: number | null) => value === null ? '—' : value < 1024 * 1024 ? `${Math.round(value / 1024)} КБ` : value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(1)} МБ` : `${(value / 1024 ** 3).toFixed(1)} ГБ`;
const when = (value?: string | null) => value ? new Date(value).toLocaleString('ru-RU') : 'Нет данных';

type Health = {
  status: string; checkedAt: string; startedAt: string; uptimeSeconds: number;
  process: { node: string; pid: number; memoryBytes: number };
  storage: { dataBytes: number; files: number; freeBytes: number | null; totalBytes: number | null };
  audit: { valid: boolean; entries?: number; error?: string };
  contracts: { count: number; status: string };
  sessions: { active: number; idleMinutes: number };
  queues: { erp: Queue; mes: Queue };
  components: {
    erp: { configured: boolean; mode: string; lastActivityAt: string | null };
    mes: { configured: boolean; lastError: string | null; lastActivityAt: string | null };
    cad: { configured: boolean; imports: number; lastActivityAt: string | null };
  };
  backup: Backup | null;
  crypto: { fingerprint: string; profile: string; rotation: { completedAt?: string } | null };
};
type Queue = { pending: number; failed: number; total: number };
type Backup = { backupId: string; createdAt: string; verifiedAt: string; filename: string; bytes: number; files: number; sha256: string };

export function AdminHealthView() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState('');
  const load = async () => { try { setHealth(await json<Health>('/api/operations/health')); setError(''); } catch (problem) { setError(problem instanceof Error ? problem.message : 'Диагностика недоступна'); } };
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15_000); return () => window.clearInterval(timer); }, []);
  const queueTone = (queue?: Queue) => queue?.failed ? 'red' : queue?.pending ? 'amber' : 'green';
  return <>
    <Note>Показатели читаются с сервера каждые 15 секунд. Экран не перезапускает компоненты и не скрывает состояние «не настроено».</Note>
    {error && <Note tone="amber">{error}</Note>}
    <div className="metric-grid operations-metrics">
      <div className="metric-static"><span>Сервер</span><strong>{health ? `${Math.floor(health.uptimeSeconds / 60)} мин` : '—'}</strong><small>{health?.process.node ?? 'Загрузка…'}</small></div>
      <div className="metric-static"><span>Аудит</span><strong>{health?.audit.valid ? health.audit.entries : '!'}</strong><small>{health?.audit.valid ? 'Целостность подтверждена' : health?.audit.error ?? 'Проверка…'}</small></div>
      <div className="metric-static"><span>Контракты</span><strong>{health?.contracts.count ?? '—'}</strong><small>{health?.contracts.status ?? 'Загрузка…'}</small></div>
      <div className="metric-static"><span>Сеансы</span><strong>{health?.sessions.active ?? '—'}</strong><small>тайм-аут {health?.sessions.idleMinutes ?? 30} минут</small></div>
    </div>
    <div className="two-columns">
      <Panel title="Компоненты" eyebrow="ФАКТИЧЕСКОЕ СОСТОЯНИЕ" action={<Button onClick={() => void load()}>Обновить</Button>}>
        <div className="operations-list">
          <div><Badge tone={health?.components.erp.configured ? 'green' : 'amber'}>ERP</Badge><span>{health?.components.erp.mode ?? '—'}<small>Последняя активность: {when(health?.components.erp.lastActivityAt)}</small></span></div>
          <div><Badge tone={health?.components.mes.lastError ? 'red' : health?.components.mes.configured ? 'green' : 'muted'}>MES</Badge><span>{health?.components.mes.lastError ?? (health?.components.mes.configured ? 'Шлюз настроен' : 'Не настроен')}<small>Последняя активность: {when(health?.components.mes.lastActivityAt)}</small></span></div>
          <div><Badge tone={health?.components.cad.configured ? 'green' : 'muted'}>CAD</Badge><span>{health?.components.cad.configured ? 'Адаптер настроен' : 'Резервный импорт'}<small>Импортировано ревизий: {health?.components.cad.imports ?? 0}</small></span></div>
        </div>
      </Panel>
      <Panel title="Очереди" eyebrow="ДОСТАВКА И ОШИБКИ">
        <div className="operations-list">
          {(['erp', 'mes'] as const).map(name => { const queue = health?.queues[name]; return <div key={name}><Badge tone={queueTone(queue)}>{name.toUpperCase()}</Badge><span>{queue?.pending ?? '—'} ожидают · {queue?.failed ?? '—'} ошибок<small>Всего сообщений: {queue?.total ?? '—'}</small></span></div>; })}
        </div>
      </Panel>
    </div>
    <Panel title="Хранилище и восстановление" eyebrow="ЛОКАЛЬНЫЕ ДАННЫЕ">
      <dl className="facts"><div><dt>Данные</dt><dd>{bytes(health?.storage.dataBytes ?? null)} · {health?.storage.files ?? '—'} файлов</dd></div><div><dt>Свободно</dt><dd>{bytes(health?.storage.freeBytes ?? null)}</dd></div><div><dt>Последняя проверенная копия</dt><dd>{when(health?.backup?.verifiedAt)}</dd></div><div><dt>Криптопрофиль</dt><dd>{health?.crypto.profile ?? '—'} · {health?.crypto.fingerprint ?? '—'}</dd></div></dl>
    </Panel>
  </>;
}

export function SecurityBackupView() {
  const [backup, setBackup] = useState<Backup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async () => { try { setBackup((await json<{ last: Backup | null }>('/api/operations/backups')).last); setError(''); } catch (problem) { setError(problem instanceof Error ? problem.message : 'Состояние копий недоступно'); } };
  useEffect(() => { void load(); }, []);
  const create = async () => { setBusy(true); try { setBackup(await json<Backup>('/api/operations/backups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })); setError(''); } catch (problem) { setError(problem instanceof Error ? problem.message : 'Копия не создана'); } finally { setBusy(false); } };
  return <>
    <Note tone="amber">Архив создаётся только на сервере и содержит корневой ключ вместе с зашифрованными состояниями. Перенесите его в отдельное защищённое хранилище; не отправляйте через обычную почту.</Note>
    {error && <Note tone="amber">{error}</Note>}
    <Panel title="Проверенная резервная копия" eyebrow="СОЗДАНИЕ → ПРОБНОЕ ВОССТАНОВЛЕНИЕ → SHA-256" action={<Button primary disabled={busy} onClick={() => void create()}>{busy ? 'Проверка…' : 'Создать и проверить'}</Button>}>
      {backup ? <dl className="facts"><div><dt>Создана</dt><dd>{when(backup.createdAt)}</dd></div><div><dt>Проверена</dt><dd>{when(backup.verifiedAt)}</dd></div><div><dt>Состав</dt><dd>{backup.files} файлов · {bytes(backup.bytes)}</dd></div><div><dt>Локальный файл</dt><dd className="mono">data/backups/{backup.filename}</dd></div><div><dt>SHA-256</dt><dd className="mono break-value">{backup.sha256}</dd></div></dl> : <Empty title="Проверенных копий пока нет" text="Создайте первую копию. Сервер распакует её во временную папку и сверит каждый файл с манифестом."/>}
    </Panel>
  </>;
}

type SessionRow = { id: string; user: { id: string; role: string }; source: string; createdAt: string; lastSeenAt: string; expiresAt: string; current: boolean };
export function SecuritySessionsPanel() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [error, setError] = useState('');
  const load = async () => { try { setSessions((await json<{ sessions: SessionRow[] }>('/api/security/sessions')).sessions); setError(''); } catch (problem) { setError(problem instanceof Error ? problem.message : 'Сеансы недоступны'); } };
  useEffect(() => { void load(); }, []);
  const revoke = async (id: string) => { try { await json('/api/security/sessions/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id }) }); await load(); } catch (problem) { setError(problem instanceof Error ? problem.message : 'Не удалось завершить сеанс'); } };
  return <Panel title="Активные сеансы" eyebrow="ОТЗЫВ ДОСТУПА" action={<Button onClick={() => void load()}>Обновить</Button>}>
    {error && <Note tone="amber">{error}</Note>}
    {sessions.length ? <div className="table-wrap"><table><thead><tr><th>Учётная запись</th><th>Источник</th><th>Создан</th><th>Последняя активность</th><th>Действие</th></tr></thead><tbody>{sessions.map(row => <tr key={row.id}><td>{row.user.id}<small>{row.user.role}{row.current ? ' · текущий' : ''}</small></td><td className="mono">{row.source}</td><td>{when(row.createdAt)}</td><td>{when(row.lastSeenAt)}</td><td>{row.current ? <Badge tone="green">Текущий</Badge> : <Button onClick={() => void revoke(row.id)}>Завершить</Button>}</td></tr>)}</tbody></table></div> : <Empty title="Активных сеансов нет" text="Истёкшие сеансы удаляются автоматически."/>}
  </Panel>;
}

export function SecurityCryptoView() {
  const [status, setStatus] = useState<{ fingerprint: string; profile: string; rotation: { completedAt?: string; previousFingerprint?: string; stateFiles?: number } | null } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { void json<typeof status>('/api/security/crypto/status').then(setStatus).catch(problem => setError(problem instanceof Error ? problem.message : 'Статус ключа недоступен')); }, []);
  return <>
    <Note tone="amber">Ротация выполняется только при остановленном сервере. Это исключает запись данных половиной старого и половиной нового ключа.</Note>
    {error && <Note tone="amber">{error}</Note>}
    <Panel title="Корневой ключ и криптопрофиль" eyebrow="ОФЛАЙН-РОТАЦИЯ">
      <dl className="facts"><div><dt>Профиль</dt><dd>{status?.profile ?? '—'}</dd></div><div><dt>Отпечаток ключа</dt><dd className="mono">{status?.fingerprint ?? '—'}</dd></div><div><dt>Последняя ротация</dt><dd>{when(status?.rotation?.completedAt)}</dd></div><div><dt>Перешифровано состояний</dt><dd>{status?.rotation?.stateFiles ?? '—'}</dd></div></dl>
      <p className="helper-text">Команда после остановки START.cmd:</p><pre className="command-block">cd source{`\n`}pnpm security:rotate -- --confirm</pre>
      <p className="helper-text">Перед заменой сохраняется локальный комплект восстановления. После ротации учебные пароли изменятся и будут напечатаны при следующем запуске.</p>
    </Panel>
  </>;
}
