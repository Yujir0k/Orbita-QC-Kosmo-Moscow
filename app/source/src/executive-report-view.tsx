import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from './dialogs';
import { Badge, Button, Icon, Note } from './ui';
import { createSignedExecutiveReport, reportPeriods, reportTemplates, type ExecutiveReport, type ReportOrder, type ReportPeriod, type ReportTemplate } from './executive-reports';
import { verifyExecutivePayload, type ExecutiveSignature } from './executive-signature';

const number = (value: number) => value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
type SignedReport = { document: ExecutiveReport; signature: ExecutiveSignature };
function EnterpriseEmblem() {
  return <svg viewBox="0 0 120 90" className="ph-emblem" role="img" aria-label="Условный герб предприятия"><g fill="none" stroke="currentColor" strokeWidth="2"><path d="M60 26C43 12 28 14 12 29l17 2-16 12 22-1-14 16 27-10M60 26C77 12 92 14 108 29l-17 2 16 12-22-1 14 16-27-10"/><path d="M43 23l-7-11 14 3 10 11 10-11 14-3-7 11M50 31h20v25L60 68 50 56zM60 68l-12 9h24zM60 8v12M53 12h14"/><circle cx="60" cy="43" r="6"/><ellipse cx="60" cy="43" rx="11" ry="4" transform="rotate(-30 60 43)"/></g></svg>;
}
export function ReportForm({ report }: { report: SignedReport }) {
  const doc = report.document;
  const totals = doc.rows.reduce((sum, row) => ({ checked: sum.checked + row.checked, good: sum.good + row.good, scrap: sum.scrap + row.scrap, pending: sum.pending + row.pending, planned: sum.planned + row.plannedHours, qc: sum.qc + row.qcHours, setup: sum.setup + row.setupHours, repair: sum.repair + row.repairHours, forging: sum.forging + row.forgingChecked, rejected: sum.rejected + row.forgingRejected }), { checked: 0, good: 0, scrap: 0, pending: 0, planned: 0, qc: 0, setup: 0, repair: 0, forging: 0, rejected: 0 });
  return <article className="ph-official-sheet" aria-label="Официальный бланк отчёта">
    <div className="ph-document-topline"><span>ОРБИТА.QC · Дирекция производства</span><strong>УЧЕБНЫЙ БЛАНК</strong></div><EnterpriseEmblem/>
    <header><p>Предприятие космического приборостроения</p><h2>Акт №{doc.number}</h2><h3>{doc.title}</h3></header>
    <div className="ph-document-meta"><p><strong>Адресат:</strong> {doc.recipient}</p><p><strong>Период:</strong> {doc.periodLabel}</p><p><strong>Производственный заказ:</strong> {doc.order === 'all' ? 'Все · WO-A / WO-B' : doc.order}</p><p><strong>Сформировано:</strong> {new Date(doc.createdAt).toLocaleString('ru-RU')}</p></div>
    {doc.template === 'quality' && <><h4>1. Сводные результаты контроля качества</h4><div className="ph-document-table-wrap"><table><thead><tr><th>Заказ</th><th>Проверено</th><th>Годные</th><th>Брак</th><th>В работе / карантин</th></tr></thead><tbody>{doc.rows.map(row => <tr key={row.order}><td>{row.order}</td><td>{row.checked}</td><td>{row.good}</td><td>{row.scrap}</td><td>{row.pending}</td></tr>)}<tr className="ph-document-total"><td>Итого</td><td>{totals.checked}</td><td>{totals.good}</td><td>{totals.scrap}</td><td>{totals.pending}</td></tr></tbody></table></div></>}
    {doc.template === 'claim' && <><h4>1. Рекламация по входному контролю поковок</h4><p>Материал: сплав 1201-Т1. Учебные партии PK-1201-A / PK-1201-B. Основание: протокол входного контроля поковок, поверхностные несплошности.</p><div className="ph-document-table-wrap"><table><thead><tr><th>Заказ</th><th>Осмотрено поковок</th><th>Принято</th><th>Отклонено</th></tr></thead><tbody>{doc.rows.map(row => <tr key={row.order}><td>{row.order}</td><td>{row.forgingChecked}</td><td>{row.forgingChecked - row.forgingRejected}</td><td>{row.forgingRejected}</td></tr>)}<tr className="ph-document-total"><td>Итого</td><td>{totals.forging}</td><td>{totals.forging - totals.rejected}</td><td>{totals.rejected}</td></tr></tbody></table></div></>}
    {doc.template === 'time' && <><h4>1. Использование фонда времени, ч</h4><div className="ph-document-table-wrap"><table><thead><tr><th>Заказ</th><th>Фонд</th><th>ОТК</th><th>Наладка</th><th>Ремонт</th><th>Доступный фонд</th></tr></thead><tbody>{doc.rows.map(row => <tr key={row.order}><td>{row.order}</td><td>{number(row.plannedHours)}</td><td>{number(row.qcHours)}</td><td>{number(row.setupHours)}</td><td>{number(row.repairHours)}</td><td>{number(row.plannedHours - row.qcHours - row.setupHours - row.repairHours)}</td></tr>)}<tr className="ph-document-total"><td>Итого</td><td>{number(totals.planned)}</td><td>{number(totals.qc)}</td><td>{number(totals.setup)}</td><td>{number(totals.repair)}</td><td>{number(totals.planned - totals.qc - totals.setup - totals.repair)}</td></tr></tbody></table></div></>}
    <h4>2. Заключение комиссии</h4><p>{doc.conclusion}</p><div className="ph-document-signature-line"><span>Директор производства</span><strong>{doc.actor}</strong><span>Электронная подпись</span></div>
    <div className="ph-signature-stamp"><Icon name="security" size={24}/><div><strong>ЭЦП Валидна: SHA-256 Verified</strong><span>ECDSA P-256 · криптографическая проверка пройдена</span><small>Подписано {new Date(report.signature.signedAt).toLocaleString('ru-RU')}</small></div></div>
    <p className="ph-document-hash">SHA-256: {report.signature.digest}</p><footer className="ph-document-footer">Синтетические данные · {doc.snapshotId}. Макет делового бланка; соответствие конкретному ГОСТ не заявляется. Демонстрационная ЭЦП без доверенного сертификата, не является квалифицированной подписью. Документ не отправлен адресату.</footer>
  </article>;
}

export function ExecutiveReportGenerator() {
  const [period, setPeriod] = useState<ReportPeriod>('month');
  const [order, setOrder] = useState<ReportOrder>('all');
  const [report, setReport] = useState<SignedReport | null>(null);
  const [busy, setBusy] = useState<ReportTemplate | null>(null);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const generate = async (template: ReportTemplate) => {
    setBusy(template); setError('');
    try {
      const result = await createSignedExecutiveReport(template, period, order);
      if (!await verifyExecutivePayload(result.document, result.signature)) throw new Error('Проверка подписи отчёта не пройдена.');
      if (mounted.current) setReport(result);
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'Не удалось сформировать отчёт.'); }
    finally { if (mounted.current) setBusy(null); }
  };
  return <>
    <div className="ph-report-filter"><label>Период<select aria-label="Период отчёта" value={period} onChange={event => setPeriod(event.target.value as ReportPeriod)} disabled={!!busy}>{reportPeriods.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label><label>Производственный заказ<select aria-label="Заказ отчёта" value={order} onChange={event => setOrder(event.target.value as ReportOrder)} disabled={!!busy}><option value="all">Все заказы</option><option>WO-A</option><option>WO-B</option></select></label><div><span className="eyebrow">СОСТАВ ОТЧЁТА</span><p>{reportPeriods.find(row => row.id === period)?.dates} · {order === 'all' ? 'WO-A и WO-B' : order}</p></div></div>
    <div className="ph-report-templates">{reportTemplates.map((template, index) => <article className="ph-report-template" key={template.id}><div className="ph-card-top"><span className="ph-person-icon"><Icon name={template.icon} size={25}/></span><span className="mono">ФОРМА 0{index + 1}</span></div><h3>{template.title}</h3><p>{template.description}</p><Badge tone="blue">Печатный бланк · A4</Badge><Button primary disabled={!!busy} icon="file" onClick={() => { void generate(template.id); }}>{busy === template.id ? 'Формирование и подпись…' : 'Сформировать и просмотреть'}</Button></article>)}</div>
    {error && <div role="alert"><Note tone="red">{error}</Note></div>}
    <Note icon="file">Отчёт фиксирует выбранный срез на момент формирования. В предпросмотре доступна печать и сохранение PDF средствами браузера. Подпись и SHA-256 проверяются для содержимого этого учебного документа.</Note>
    {report && createPortal(<Modal title={`Акт №${report.document.number}`} className="executive-report-dialog" onClose={() => setReport(null)}><div className="ph-report-toolbar"><div><span className="eyebrow">ОФИЦИАЛЬНЫЙ БЛАНК · ПРЕДПРОСМОТР</span><h2>Акт №{report.document.number}</h2></div><Button primary icon="file" onClick={() => window.print()}>Печать / Сохранить в PDF</Button><button className="icon-button" aria-label="Закрыть отчёт" onClick={() => setReport(null)}><Icon name="close"/></button></div><ReportForm report={report}/></Modal>, document.body)}
  </>;
}
