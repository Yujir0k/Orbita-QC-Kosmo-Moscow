import { managerSnapshot } from './managerMockData';
import { signExecutivePayload, type ExecutiveSignature } from './executive-signature';

export type ReportPeriod = 'shift' | 'decade' | 'month';
export type ReportOrder = 'all' | 'WO-A' | 'WO-B';
export type ReportTemplate = 'quality' | 'claim' | 'time';
export const reportPeriods: { id: ReportPeriod; label: string; dates: string }[] = [
  { id: 'shift', label: 'Смена', dates: 'Смена А · 26.02.2026, 08:00–16:00' },
  { id: 'decade', label: 'Декада', dates: '17–26.02.2026' },
  { id: 'month', label: 'Месяц', dates: '01–26.02.2026 · месяц на дату среза' },
];
export const reportTemplates: { id: ReportTemplate; title: string; icon: string; description: string; recipient: string }[] = [
  { id: 'quality', title: 'Справка о качестве для ГК Роскосмос / Военная приемка', icon: 'quality', description: 'Годные изделия, подтверждённый брак, незавершённый контроль и выводы по производственной программе.', recipient: 'ГК Роскосмос / Военная приемка' },
  { id: 'claim', title: 'Претензионный рекламационный акт поставщику поковок (Сплав 1201-Т1)', icon: 'file', description: 'Входной контроль поковок, отклонённые заготовки и требование замены партии поставщиком.', recipient: 'Условный поставщик №12 · поковки 1201-Т1' },
  { id: 'time', title: 'Ведомость использования фонда времени и простоев оборудования', icon: 'clock', description: 'Плановый фонд, ожидание ОТК, переналадка и аварийный ремонт по выбранному заказу.', recipient: 'Дирекция производства / ОГМ' },
];
export interface ReportRow {
  order: Exclude<ReportOrder, 'all'>; checked: number; good: number; scrap: number; pending: number;
  plannedHours: number; qcHours: number; setupHours: number; repairHours: number;
  forgingChecked: number; forgingRejected: number;
}
const periodRows: Record<ReportPeriod, ReportRow[]> = {
  shift: [
    { order: 'WO-A', checked: 27, good: 25, scrap: 0, pending: 2, plannedHours: 8, qcHours: 0.2, setupHours: 0.4, repairHours: 0, forgingChecked: 8, forgingRejected: 1 },
    { order: 'WO-B', checked: 25, good: 23, scrap: 1, pending: 1, plannedHours: 16, qcHours: 0.4, setupHours: 0.6, repairHours: 1.5, forgingChecked: 12, forgingRejected: 2 },
  ],
  decade: [
    { order: 'WO-A', checked: 160, good: 156, scrap: 1, pending: 3, plannedHours: 120, qcHours: 2, setupHours: 3, repairHours: 1, forgingChecked: 40, forgingRejected: 2 },
    { order: 'WO-B', checked: 200, good: 186, scrap: 3, pending: 11, plannedHours: 200, qcHours: 4, setupHours: 5, repairHours: 16, forgingChecked: 60, forgingRejected: 5 },
  ],
  month: [
    { order: 'WO-A', checked: 500, good: 489, scrap: 3, pending: 8, plannedHours: 320, qcHours: 6, setupHours: 4, repairHours: 6.4, forgingChecked: 100, forgingRejected: 4 },
    { order: 'WO-B', checked: 500, good: 459, scrap: 8, pending: 33, plannedHours: 640, qcHours: 12, setupHours: 8, repairHours: 41.6, forgingChecked: 180, forgingRejected: 12 },
  ],
};
export interface ExecutiveReport {
  number: string; template: ReportTemplate; title: string; recipient: string; period: ReportPeriod;
  periodLabel: string; order: ReportOrder; createdAt: string; actor: string; snapshotId: string;
  rows: ReportRow[]; conclusion: string; synthetic: true;
}
export function buildExecutiveReport(template: ReportTemplate, period: ReportPeriod, order: ReportOrder, createdAt = new Date().toISOString()): ExecutiveReport {
  const definition = reportTemplates.find(row => row.id === template);
  const dates = reportPeriods.find(row => row.id === period);
  if (!definition || !dates || !['all', 'WO-A', 'WO-B'].includes(order)) throw new Error('Неизвестный шаблон или срез отчёта.');
  const rows = periodRows[period].filter(row => order === 'all' || row.order === order).map(row => ({ ...row }));
  const conclusions = {
    quality: `В выбранном срезе принято ${rows.reduce((sum, row) => sum + row.good, 0)} изделий; окончательный брак — ${rows.reduce((sum, row) => sum + row.scrap, 0)}. Изделия с незавершённым контролем к отгрузке не допускать.${order !== 'WO-A' ? ' По WO-B проверить резерв маршрута и риски, связанные с ITEM-007.' : ''}`,
    claim: `Входным контролем отклонено ${rows.reduce((sum, row) => sum + row.forgingRejected, 0)} поковок сплава 1201-Т1. Поставщику предложено заменить отклонённые заготовки и предоставить протокол контроля партии. Учебный акт по поковкам не относится к заготовке ITEM-004 из сплава АЛ9.`,
    time: `Учтено ${rows.reduce((sum, row) => sum + row.plannedHours, 0)} часов планового фонда. Ожидание, переналадка и ремонт приведены раздельно; интервалы не пересекаются. Согласовать сокращение ожидания ОТК и внеплановый осмотр шпинделя.`,
  };
  return { number: '104-QC/2026', template, title: definition.title, recipient: definition.recipient, period, periodLabel: dates.dates, order, createdAt, actor: 'DIRECTOR-DEMO', snapshotId: managerSnapshot.id, rows, conclusion: conclusions[template], synthetic: true };
}
export async function createSignedExecutiveReport(template: ReportTemplate, period: ReportPeriod, order: ReportOrder): Promise<{ document: ExecutiveReport; signature: ExecutiveSignature }> {
  const document = buildExecutiveReport(template, period, order);
  return { document, signature: await signExecutivePayload(document) };
}
