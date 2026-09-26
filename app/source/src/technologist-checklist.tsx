import { readWorkspaceValue, saveWorkspaceValue } from './workspace-storage';
import { useEffect, useState } from 'react';
import { Note } from './ui';
import { type Case } from './domain';
import { investigationEvidence } from './technologist-evidence';
export function InvestigationChecklist({ record }: { record: Case }) {
  const facts = investigationEvidence(record);
  const ndt = facts.evidence.find(e => e.data.method === 'nondestructive_inspection');
  const tool = facts.masterReports.find(e => e.data.tool_operating_hours != null);
  const warning = facts.machine.find(e => e.data.state === 'warning');
  const entries = [
    { id: 'incoming', label: 'Проверен входной брак заготовки и границы входного контроля', source: ndt?.event_id ?? facts.before?.event_id, detail: ndt ? ndt.data.reason : 'Визуальное отсутствие признака не исключает скрытый дефект.' },
    { id: 'tool', label: 'Сопоставлены наработка, журнал смены и осмотр инструмента', source: tool?.event_id, detail: tool ? tool.data.comment : 'Запросите журнал смены и фактический осмотр инструмента.' },
    { id: 'timing', label: 'Проверена временная связь предупреждения ЧПУ и прохода', source: warning?.event_id, detail: warning ? 'Сверьте время образца, проход, предупреждение и контроль после обработки.' : 'Предупреждение в связанной операции не поступило.' },
  ];
  const key = `orbita-tech-checklist-v1:${record.id}`;
  const [checked, setChecked] = useState<string[]>(() => {try {const rows: unknown = readWorkspaceValue(key) ?? []; return Array.isArray(rows) ? rows.filter((v): v is string => typeof v === 'string' && entries.some(e => e.id === v)) : [];}catch{return [];}});
  const [notice, setNotice] = useState('');
  useEffect(() => { const timer = window.setTimeout(async () => { try { await saveWorkspaceValue(key, checked); setNotice('Проверки сохранены на сервере'); } catch (error) { setNotice(error instanceof Error ? error.message : 'Проверки не сохранены'); } }, 500); return () => window.clearTimeout(timer); }, [checked,key]);
  return <div className="tech-checklist">{entries.map(entry => <label key={entry.id}><input type="checkbox" checked={checked.includes(entry.id)} onChange={() => setChecked(rows => rows.includes(entry.id) ? rows.filter(id=>id!==entry.id) : [...rows,entry.id])}/><span><b>{entry.label}</b><small>{entry.source ?? 'Источник нужно запросить'} · {entry.detail}</small></span></label>)}<small role="status">{notice}</small>{facts.missing.length > 0 && <ul className="tech-gap-list">{facts.missing.map(text => <li key={text}>{text}</li>)}</ul>}<Note>Отметка фиксирует вашу проверку источника и сама по себе не устанавливает причину.</Note></div>;
}
