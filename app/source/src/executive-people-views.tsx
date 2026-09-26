import { Badge, Button, Icon, Metric, Panel } from './ui';
import { personnelAudit, repairBalance, repeatedReworks, shiftAudit } from './managerMockData';
import type { ViewProps } from './views';

const number = (value: number) => value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
export function RepairBalanceView({ openItem, navigate }: ViewProps) {
  const data = repairBalance;
  const mttr = data.completedMinutes.reduce((sum, minutes) => sum + minutes, 0) / data.completedMinutes.length;
  const stages = [
    { label: 'Выявлено', count: data.found, amount: '1,42 млн ₽', tone: 'blue', note: 'Все проблемные детали' },
    { label: 'В ремонте', count: data.repairable, amount: '280 тыс ₽', tone: 'amber', note: 'Направлено на восстановление' },
    { label: 'Восстановлено', count: data.restored, amount: '110 тыс ₽', tone: 'green', note: 'Повторный контроль пройден' },
    { label: 'В процессе', count: data.inProgress, amount: '170 тыс ₽', tone: 'amber', note: 'Ожидает завершения ремонта' },
    { label: 'Изолятор брака', count: data.isolated, amount: '1,14 млн ₽', tone: 'red', note: 'Списание / рекламация' },
  ];
  return <>
    <div className="metric-grid ph-three-metrics">
      <Metric label="Трудозатраты на восстановление" value={`${number(data.labourHours)} н·ч`} note={`Лимит ${data.labourLimit} н·ч · использовано ${number(data.labourHours / data.labourLimit * 100)}%`} icon="clock" tone="amber"/>
      <Metric label="Коэффициент спасения брака" value={`${number(data.restored / data.repairable * 100)}%`} note={`${data.restored} из ${data.repairable} исправимых деталей возвращены в строй`} icon="done" tone="green"/>
      <Metric label="Среднее время устранения · MTTR" value={`${number(mttr)} мин`} note="По двум завершённым ремонтам · 36 и 48 мин" icon="production" tone="amber"/>
    </div>
    <Panel title="Баланс выявления и восстановления" eyebrow="5 ДЕТАЛЕЙ · 1,42 МЛН ₽ БАЛАНСОВОЙ СТОИМОСТИ">
      <div className="ph-repair-funnel">{stages.map((stage, index) => <div key={stage.label} className={`ph-funnel-stage ${stage.tone}`}><span className="ph-funnel-number">0{index + 1}</span><h3>{stage.label}</h3><strong>{stage.count} <small>шт.</small></strong><span className="ph-funnel-amount">{stage.amount}</span><p>{stage.note}</p>{index !== 4 && <Icon name="arrow" className="ph-funnel-arrow"/>}</div>)}</div>
    </Panel>
    <Panel title="Контроль повторных доработок" eyebrow="ГЕОМЕТРИЯ И РЕСУРС ДЕТАЛИ" action={<Button onClick={() => navigate('executive', 'actions')}>К управленческим решениям</Button>}>
      <div className="table-wrap"><table><thead><tr><th>Изделие</th><th>Дефект</th><th>Доработок</th><th>Риск и основание</th><th>История</th></tr></thead><tbody>{repeatedReworks.map(row => <tr key={row.item} className={row.count > 1 ? 'ph-warning-row' : ''}><td><strong>{row.item}</strong><small>{row.name}</small></td><td>{row.defect}</td><td><Badge tone={row.tone}>{row.count}{row.count > 1 ? ' · Внимание' : ''}</Badge></td><td><strong>{row.risk}</strong><small>{row.note}</small></td><td><Button onClick={() => openItem(row.item)}>Паспорт</Button></td></tr>)}</tbody></table></div>
    </Panel>
  </>;
}

export function PersonnelView() {
  return <>
    <Panel title="Сравнение смен · Смена А vs Смена Б" eyebrow="РИТМ ПРОИЗВОДСТВА И КАЧЕСТВО">
      <div className="ph-shift-grid">{shiftAudit.map(row => <article key={row.id} className={`ph-shift-card ${row.tone}`}><div className="ph-card-top"><span className="eyebrow">СМЕНА {row.id === 'A' ? 'А' : 'Б'}</span><Badge tone={row.tone}>{row.status}</Badge></div><h3>Мастер {row.master}</h3><div className="ph-shift-ftr"><strong>{number(row.ftr)}%</strong><span>FTR · с первого раза</span></div><div className="ph-progress"><span style={{width:`${row.ftr}%`}}/></div><div className="ph-shift-facts"><div><strong>{row.output}</strong><span>{row.id === 'A' ? 'узлов выпущено' : 'узел выпущен'}</span></div><div className={row.pauses > 5 ? 'text-amber' : ''}><strong>{number(row.pauses)}%</strong><span>техпаузы {row.pauses > 5 ? '· отклонение' : ''}</span></div><div><strong>{row.scrap} шт.</strong><span>брак</span></div></div></article>)}</div>
      <div className="ph-summary-strip ph-shift-summary"><span><strong>+5,6 п.п.</strong> преимущество смены А по FTR</span><span><strong>+7 узлов</strong> к выпуску смены Б</span><span><strong>+5,1 п.п.</strong> техпауз в смене Б</span></div>
      <p className="ph-caption">Сравнение относится к сопоставимой группе операций и изделий. FTR смен, выпуск узлов и количество случаев брака имеют разные знаменатели; не складываются в месячные KPI предприятия. ФИО и ID — учебные персонажи.</p>
    </Panel>
    <Panel title="Персональный аудит" eyebrow="ОТК / ТЕХНОЛОГИЯ / ПРОИЗВОДСТВО"><div className="ph-personnel-grid">{personnelAudit.map(row => <article key={row.id} className={`ph-person-card ${row.tone}`}><div className="ph-card-top"><span className="ph-person-icon"><Icon name={row.icon} size={23}/></span><Badge tone={row.tone}>{row.status}</Badge></div><span className="eyebrow">{row.role}</span><h3>{row.name}</h3><span className="mono text-sub">{row.id}</span><dl>{row.metrics.map(metric => <div key={metric.label}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}</dl><p>{row.context}</p></article>)}</div></Panel>
  </>;
}
