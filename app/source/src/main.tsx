import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';

const root = ReactDOM.createRoot(document.getElementById('root')!);
const runtime = window as unknown as { __ORBITA_PRODUCTION__: boolean; __ORBITA_DATASET__: unknown; __ORBITA_PREFERENCES__: unknown; __ORBITA_DEMO__: boolean };

function Login({ initialError = '' }: { initialError?: string }) {
  const [id, setId] = useState('controller-01');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  return <main className="security-login-page"><form className="security-login-card" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch('/api/security/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, password }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setPassword(''); await start();
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Сервер недоступен'); }
    finally { setBusy(false); }
  }}><span className="eyebrow">ОРБИТА.QC</span><h1>Вход в рабочее место</h1><p>Используйте учётную запись, выданную администратором.</p><label>Учётная запись<input value={id} onChange={event => setId(event.target.value)} autoComplete="username" required/></label><label>Пароль<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required/></label><button className="button primary" disabled={busy}>{busy ? 'Проверка…' : 'Войти'}</button>{error && <p role="alert">{error}</p>}</form></main>;
}

async function start() {
  const config = await (await fetch('/api/config')).json();
  runtime.__ORBITA_DEMO__ = config.authentication === 'demo';
  if (runtime.__ORBITA_DEMO__) {
    const role = /(?:controller|master|technologist|leader|administrator)/.exec(window.location.hash)?.[0] ?? 'controller';
    await fetch('/api/security/demo-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) });
  }
  const response = await fetch('/api/data/bootstrap');
  runtime.__ORBITA_PRODUCTION__ = true;
  if (response.status === 401) { root.render(<Login/>); return; }
  if (!response.ok) throw new Error('Не удалось загрузить данные из БД. Запустите Docker Compose.');
  const data = await response.json();
  runtime.__ORBITA_DATASET__ = data.dataset;
  runtime.__ORBITA_PREFERENCES__ = data.preferences;
  const domain = await import('./domain');
  domain.useAuthoritativeHistory(data.deliveries);
  const { default: App } = await import('./App');
  root.render(<React.StrictMode><App/></React.StrictMode>);
}
void start().catch(error => root.render(<Login initialError={error.message}/>));
