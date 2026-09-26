import { useEffect, useState } from 'react';
import { secureFetch } from './security-client';
import { Badge, Empty, Note, Panel } from './ui';

type ContractRow = { name: string; file: string; label: string; purpose: string; id: string; title: string; draft: string; fingerprint: string };
type Registry = { status: string; draft: string; loadedAt: string; count: number; policies: { remoteReferences: boolean; rejectUnknownFields: boolean; maxDepth: number; maxKeys: number; forbiddenKeys: string[] }; schemas: ContractRow[] };

export function AdminContractsView() {
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { void (async () => {
    try {
      const response = await secureFetch('/api/contracts');
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
      setRegistry(value); setError('');
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Реестр контрактов недоступен'); }
  })(); }, []);
  return <div className="stack">
    <Note>Схемы загружаются сервером при старте и исполняются до записи или отправки сообщения. Этот экран показывает метаданные, но не раскрывает ключи, токены и настройки внешних шлюзов.</Note>
    {error && <Note tone="amber">{error}</Note>}
    <div className="metric-grid integration-metrics">
      <div className="integration-kpi"><span>Загружено схем</span><strong>{registry?.count ?? '—'}</strong></div>
      <div className="integration-kpi"><span>Спецификация</span><strong className="contract-kpi-text">Draft {registry?.draft ?? '—'}</strong></div>
      <div className="integration-kpi"><span>Сетевые ссылки</span><strong className="contract-kpi-text">{registry ? registry.policies.remoteReferences ? 'Разрешены' : 'Запрещены' : '—'}</strong></div>
      <div className="integration-kpi"><span>Неизвестные поля</span><strong className="contract-kpi-text">{registry ? registry.policies.rejectUnknownFields ? 'Отклоняются' : 'Разрешены' : '—'}</strong></div>
    </div>
    <Panel title="Исполняемые схемы" eyebrow="ЕДИНЫЙ ИСТОЧНИК ФОРМАТОВ">
      {registry?.schemas.length ? <div className="table-wrap"><table><thead><tr><th>Контракт</th><th>Файл и ID</th><th>Назначение</th><th>Контрольная сумма</th><th>Состояние</th></tr></thead><tbody>{registry.schemas.map(row => <tr key={row.name}><td><strong>{row.label}</strong><small className="mono">{row.name}</small></td><td className="mono">{row.file}<small>{row.id}</small></td><td className="wide-cell">{row.purpose}</td><td className="mono">{row.fingerprint.slice(0, 16)}…</td><td><Badge tone="green">Загружен</Badge></td></tr>)}</tbody></table></div> : <Empty title="Схемы не загружены" text="Проверьте запуск переносимого сервера и папку contracts/."/>}
    </Panel>
    {registry && <Panel title="Ограничения входного JSON" eyebrow="ЗАЩИТА ГРАНИЦЫ API"><dl className="facts"><div><dt>Максимальная глубина</dt><dd>{registry.policies.maxDepth}</dd></div><div><dt>Максимум ключей</dt><dd>{registry.policies.maxKeys.toLocaleString('ru-RU')}</dd></div><div><dt>Опасные ключи</dt><dd className="mono">{registry.policies.forbiddenKeys.join(' · ')}</dd></div><div><dt>Проверка набора</dt><dd className="mono">cd source; pnpm contracts:check</dd></div></dl></Panel>}
  </div>;
}
