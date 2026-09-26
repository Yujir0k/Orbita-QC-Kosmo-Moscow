import { useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Empty, Note, Panel } from './ui';
import { secureFetch } from './security-client';

const accounts = [
  ['controller-01', 'Контролёр качества'], ['master-01', 'Мастер участка'], ['technologist-01', 'Технолог'],
  ['leader-01', 'Руководитель'], ['administrator-01', 'Администратор'],
];

export function SecurityLogin({ onLogin, error, initialRole = 'controller' }: { onLogin: (id: string, password: string) => Promise<void>; error: string; initialRole?: string }) {
  const [id, setId] = useState(`${initialRole}-01`);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true);
    try { await onLogin(id, password); setPassword(''); }
    finally { setBusy(false); }
  };
  return <main className="security-login-page"><div className="security-login-card"><span className="eyebrow">ОРБИТА.QC · ЗАЩИЩЁННЫЙ УЧЕБНЫЙ КОНТУР</span><h1>Вход в рабочее место</h1><p>Действия записываются с учётной записью и проверяются сервером. Пароли для учебных ролей показаны в окне запущенного сервера.</p><form onSubmit={event => void submit(event)}><label>Учётная запись<select value={id} onChange={event => setId(event.target.value)}>{accounts.map(([value, label]) => <option value={value} key={value}>{label} · {value}</option>)}</select></label><label>Пароль<input autoComplete="current-password" type="password" value={password} onChange={event => setPassword(event.target.value)} required/></label><button className="button primary" type="submit" disabled={busy || !password}>{busy ? 'Проверка…' : 'Войти'}</button></form>{error && <p className="security-error" role="alert">{error}</p>}<small>Адрес демо: 127.0.0.1. Учётные данные и ключи не входят в исходный код и архив.</small></div></main>;
}

type AuditEntry = { id: string; seq: number; mac: string; type: string; at: string; actor?: string; role?: string; itemId?: string; action?: string; path?: string; reason?: string };
export function SecurityAuditView() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [verification, setVerification] = useState('Проверка не выполнялась');
  const [error, setError] = useState('');
  const load = async () => {
    try {
      const checkResponse = await secureFetch('/api/security/verify');
      const check = await checkResponse.json();
      if (!checkResponse.ok) throw new Error(check.error ?? `HTTP ${checkResponse.status}`);
      const response = await secureFetch('/api/security/audit');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setEntries(data.entries); setVerification(`Целостность подтверждена: ${check.entries} записей`); setError('');
    } catch (problem) { setEntries([]); setVerification('Целостность не подтверждена'); setError(problem instanceof Error ? problem.message : 'Не удалось открыть аудит'); }
  };
  useEffect(() => { void load(); }, []);
  return <>
    <Note>Права проверяются сервером до выполнения команд. Журнал действий шифруется и связывается HMAC-цепочкой; старые записи не переписываются приложением. Журнал защищён от изменения ролью приложения в PostgreSQL.</Note>
    <div className="security-audit-toolbar">
      <Badge tone={verification.startsWith('Целостность подтверждена') ? 'green' : 'amber'}>{verification}</Badge>
      <Button onClick={() => void load()}>Проверить целостность</Button>
    </div>
    {error && <Note tone="amber">{error}</Note>}
    <Panel title="Критические действия и отказы" eyebrow="СЕРВЕРНЫЙ АУДИТ">
      {entries.length ? <div className="table-wrap"><table>
        <thead><tr><th>№ / время</th><th>Событие</th><th>Учётная запись</th><th>Объект / маршрут</th><th>Основание</th><th>Контроль</th></tr></thead>
        <tbody>{entries.slice(0, 100).map(row => <tr key={row.id ?? row.mac}>
          <td className="mono">{row.seq}<small>{row.at}</small></td>
          <td>{row.type}{row.action && <small>{row.action}</small>}</td>
          <td>{row.actor ?? '—'}<small>{row.role ?? ''}</small></td>
          <td>{row.itemId ?? row.path ?? '—'}</td>
          <td>{row.reason ?? '—'}</td>
          <td className="mono">{row.mac.slice(0, 12)}…</td>
        </tr>)}</tbody>
      </table></div> : <Empty title="Журнал пуст" text="Войдите и выполните действие роли."/>}
    </Panel>
  </>;
}
