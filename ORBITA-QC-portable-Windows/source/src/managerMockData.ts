/** Independent monthly planning snapshot. Never mixed with the live 180-item demo. */
export const managerSnapshot = {
  id: 'EXEC-2026-02-v1', period: 'Февраль 2026 · на 26.02', synthetic: true,
  checked: 1000, firstPass: 924, reworked: 65, finalScrap: 11,
  released: 948, quarantine: 16, inProgress: 25, productionPlan: 1000,
  reworkHours: 46.5, previousFtr: 90.8, previousReleased: 910,
  fleetPlannedHours: 3200, fleetUnavailableHours: 345.6, fleetCount: 10,
};
export const executiveKpis = {
  ftr: managerSnapshot.firstPass / managerSnapshot.checked * 100,
  ftrTarget: 95, finalScrap: managerSnapshot.finalScrap / managerSnapshot.checked * 100,
  scrapLimit: 1.5, reworkHours: managerSnapshot.reworkHours,
  programCompletion: managerSnapshot.released / managerSnapshot.productionPlan * 100,
  fleetAvailability: (managerSnapshot.fleetPlannedHours - managerSnapshot.fleetUnavailableHours) / managerSnapshot.fleetPlannedHours * 100,
};
export const rootCauseDistribution = [
  { id: 'supplier', label: 'Входной брак поставщиков', count: 38, color: '#38bdf8', status: 'Установлена' },
  { id: 'equipment', label: 'Сбои и износ оборудования', count: 42, color: '#fbbf24', status: 'Установлена' },
  { id: 'personnel', label: 'Подтверждённые нарушения процедуры', count: 12, color: '#fbbf24', status: 'Установлена' },
  { id: 'unknown', label: 'Неустановленные / спорные причины', count: 8, color: '#94a3b8', status: 'Не установлена' },
];
export const orderRisks = [
  { id: 'WO-A', name: 'Корпуса оптико-электронных блоков', plan: 12, released: 12, inspected: 12, accepted: 12, due: '27.02.2026', status: 'В графике', tone: 'green', delayShifts: 0, reason: 'Партия принята ОТК. Готова к передаче заказчику.', item: undefined },
  { id: 'WO-B', name: 'Кронштейны гиростабилизаторов', plan: 100, released: 89, inspected: 100, accepted: 89, due: '28.02.2026', status: 'Под угрозой задержки', tone: 'amber', delayShifts: 1.5, reason: 'Карантин ITEM-007 и расследование резонанса шпинделя EQ-CNC-01. Резерв маршрута: EQ-CNC-02.', item: 'ITEM-007' },
];
export type DefectOrigin = 'all' | 'incoming' | 'production';
export type DefectId = 'burr' | 'dent' | 'scratch' | 'alignment';
export const defectTypes: { id: DefectId; label: string }[] = [
  { id: 'burr', label: 'Заусенцы' }, { id: 'dent', label: 'Вмятины заготовок' },
  { id: 'scratch', label: 'Царапины покрытия' }, { id: 'alignment', label: 'Отклонение соосности' },
];
// Counts are confirmed defects, not number of defective items. One item can have several.
export const recurrenceRows: { equipment: string; shift: string; origin: Exclude<DefectOrigin, 'all'>; counts: Record<DefectId, number> }[] = [
  { equipment: 'Входной контроль', shift: '1-я', origin: 'incoming', counts: { burr: 0, dent: 18, scratch: 5, alignment: 0 } },
  { equipment: 'Входной контроль', shift: '2-я', origin: 'incoming', counts: { burr: 0, dent: 12, scratch: 3, alignment: 0 } },
  { equipment: 'EQ-CNC-01', shift: '1-я', origin: 'production', counts: { burr: 5, dent: 0, scratch: 2, alignment: 1 } },
  { equipment: 'EQ-CNC-01', shift: '2-я', origin: 'production', counts: { burr: 30, dent: 0, scratch: 5, alignment: 5 } },
  { equipment: 'EQ-CNC-02', shift: '1-я', origin: 'production', counts: { burr: 3, dent: 0, scratch: 1, alignment: 2 } },
  { equipment: 'EQ-CNC-02', shift: '2-я', origin: 'production', counts: { burr: 2, dent: 0, scratch: 1, alignment: 1 } },
  { equipment: 'EQ-ASSEMBLY-01', shift: '1-я', origin: 'production', counts: { burr: 0, dent: 0, scratch: 2, alignment: 1 } },
  { equipment: 'EQ-ASSEMBLY-01', shift: '2-я', origin: 'production', counts: { burr: 0, dent: 0, scratch: 1, alignment: 0 } },
];
export function recurrenceFor(origin: DefectOrigin) { return recurrenceRows.filter(row => origin === 'all' || row.origin === origin); }
export function paretoFor(origin: DefectOrigin) {
  const rows = recurrenceFor(origin);
  const counts = defectTypes.map(type => ({ ...type, count: rows.reduce((sum, row) => sum + row.counts[type.id], 0) })).sort((a, b) => b.count - a.count);
  const total = counts.reduce((sum, row) => sum + row.count, 0);
  let cumulative = 0;
  return counts.map(row => { cumulative += row.count; return { ...row, cumulative: total ? cumulative / total * 100 : 0 }; });
}
export const productionAreas = [
  { id: 'incoming', label: 'Входной контроль сырья', tone: 'amber', state: 'Задержки при приёмке', ftr: 96.2, lossHours: 6, detail: '38 входных дефектов. По ITEM-004 требуется рекламация поставщику; заготовка изолирована.', item: 'ITEM-004', next: 'actions' },
  { id: 'mill', label: 'Фрезерование ЧПУ', tone: 'red', state: 'Серийный дефект', ftr: 88.1, lossHours: 28.5, detail: '30 из 40 заусенцев приходятся на EQ-CNC-01 во 2-ю смену. Нужны внеплановый осмотр и проверка контрольного образца.', item: 'ITEM-007', next: 'actions' },
  { id: 'fitting', label: 'Слесарный участок', tone: 'amber', state: 'Повторные доработки', ftr: 97.6, lossHours: 7.5, detail: 'ITEM-013 направлялся на восстановление дважды. Перед следующей обработкой нужно измерить остаточную толщину стенки.', item: 'ITEM-013', next: 'balance' },
  { id: 'cmm', label: 'КИМ · финальный контроль', tone: 'green', state: 'Норма', ftr: 98.4, lossHours: 4.5, detail: 'Приёмка после восстановления выполняется на КИМ. До подтверждения геометрии и решения ОТК выпуск блокируется.', item: 'ITEM-028', next: 'balance' },
];
export const equipmentFleet = [
  { id: 'EQ-CNC-01', name: 'Фрезерный центр №1', plannedHours: 320, repairHours: 38.4, failures: 4, availability: 88, mtbf: 70.4, vibration: 7.1, threshold: 5, performance: 90, quality: 92, maintenance: true },
  { id: 'EQ-CNC-02', name: 'Фрезерный центр №2', plannedHours: 320, repairHours: 6.4, failures: 1, availability: 98, mtbf: 313.6, vibration: 2.4, threshold: 5, performance: 96, quality: 98, maintenance: false },
  { id: 'EQ-ASSEMBLY-01', name: 'Сборочный стенд №1', plannedHours: 320, repairHours: 3.2, failures: 1, availability: 99, mtbf: 316.8, vibration: null, threshold: null, performance: 97, quality: 99, maintenance: false },
];
export const timeLosses = [
  { label: 'Ожидание решения ОТК', hours: 18, color: '#38bdf8' },
  { label: 'Переналадка', hours: 12, color: '#fbbf24' },
  { label: 'Аварийный ремонт', hours: 48, color: '#fbbf24' },
];
export const operationDurations = [
  { operation: 'Входной осмотр', group: 'Литьё АЛ9 · карта IN-01, rev. 2', normMinutes: 6, medianMinutes: 6.4, finishedRuns: 100, repeatedRuns: 5 },
  { operation: 'Фрезерование · EQ-CNC-01', group: 'Кронштейн · PRG-BRACKET-A, rev. 3', normMinutes: 14, medianMinutes: 15, finishedRuns: 120, repeatedRuns: 40 },
  { operation: 'Фрезерование · EQ-CNC-02', group: 'Кронштейн · PRG-BRACKET-A, rev. 3', normMinutes: 14, medianMinutes: 14.2, finishedRuns: 120, repeatedRuns: 12 },
  { operation: 'Финишная сборка', group: 'Оптический блок · карта AS-01, rev. A', normMinutes: 18, medianMinutes: 18.2, finishedRuns: 100, repeatedRuns: 8 },
];
export const qualityTrend = [
  { label: 'Январь', checked: 1000, firstPass: 908 },
  { label: 'Февраль', checked: 1000, firstPass: 924 },
];
export const executiveActions = [
  { id: 'claim-004', title: 'Списание заготовки ITEM-004 · входной брак', item: 'ITEM-004', equipment: undefined, target: '1С:ERP', button: 'Утвердить рекламацию в 1С:ERP', basis: 'Входное повреждение заготовки АЛ9. Рекламация относится к поставщику, отдельно от внутрицехового брака.', effect: 'Согласовать рекламацию и списание заготовки в учёте; исходное решение ОТК сохраняется.' },
  { id: 'spindle-01', title: 'Внеплановый ремонт шпинделя EQ-CNC-01', item: 'ITEM-007', equipment: 'EQ-CNC-01', target: 'ОГМ', button: 'Направить наряд Главному механику (ОГМ)', basis: 'Индекс вибронагрузки 7.1 при учебном пороге 5; повторяемость заусенцев во 2-ю смену.', effect: 'Выдать наряд на осмотр и юстировку. Возврат в работу — после проверки ОГМ.' },
  { id: 'rework-007', title: 'Допуск кронштейна ITEM-007 на доработку', item: 'ITEM-007', equipment: undefined, target: 'MES', button: 'Согласовать допуск на зачистку', basis: 'Демонстрационный маршрут устранения заусенца кромки B по заказу WO-B.', effect: 'Согласовать маршрут зачистки. Выпуск требует решения ОТК и повторного контроля.' },
];

/** Focus cohort: distinct from the enterprise monthly sample. Values are carrying costs. */
export const repairBalance = { found: 5, foundValue: 1420000, repairable: 3, repairableValue: 280000, restored: 2, restoredValue: 110000, inProgress: 1, inProgressValue: 170000, isolated: 2, isolatedValue: 1140000, labourHours: 14.5, labourLimit: 30, completedMinutes: [36, 48] };
export const repeatedReworks = [
  { item: 'ITEM-013', name: 'Панель ВТ6', defect: 'Царапина', count: 2, tone: 'amber', risk: 'Критическое утонение стенки ниже допуска 2,5±0,1 мм', note: 'Риск: остаточная толщина не подтверждена измерением; требуется КИМ перед новой доработкой.' },
  { item: 'ITEM-028', name: 'Крышка', defect: 'Заусенец', count: 1, tone: 'green', risk: 'В пределах допуска чертежа', note: 'Учебное заключение ОТК: одна доработка, повторный контроль пройден.' },
];
export const shiftAudit = [
  { id: 'A', master: 'Васильев С.И.', ftr: 94.2, output: 48, pauses: 3.8, scrap: 1, tone: 'green', status: 'Лидер' },
  { id: 'B', master: 'Григорьев М.А.', ftr: 88.6, output: 41, pauses: 8.9, scrap: 4, tone: 'amber', status: 'Отклонение' },
];
export const personnelAudit = [
  { id: 'QC-01', role: 'Контролёр ОТК', name: 'Кузнецов В.А.', icon: 'quality', status: 'Норма', tone: 'green', metrics: [{ label: 'Проверено деталей', value: '180' }, { label: 'Реакция на ИИ', value: '3,1 мин' }, { label: 'Подтверждаемость', value: '96,2%' }], context: 'Доля подтверждённых признаков из рассмотренных сигналов; неподтверждённые сигналы не становятся браком автоматически.' },
  { id: 'TECH-DEMO', role: 'Технолог цеха', name: 'Борисов И.О.', icon: 'investigation', status: 'Отлично', tone: 'green', metrics: [{ label: 'Закрыто дел', value: '4 из 5' }, { label: 'Среднее время разбора', value: '16 мин' }, { label: 'Раскрываемость причин', value: '80,0%' }], context: 'Четыре дела с установленной причиной из пяти рассмотренных; одно остаётся открытым.' },
  { id: 'MASTER-DEMO', role: 'Мастер участка', name: 'Смирнов К.Д.', icon: 'production', status: 'Требует внимания', tone: 'amber', metrics: [{ label: 'Фиксация фактов', value: '100%' }, { label: 'Простой при сбое', value: '18 мин' }, { label: 'Повторный брак', value: '2 инцидента' }], context: 'Повторные дефекты требуют разбора причин. Эти инциденты не приписываются мастеру как подтверждённая ошибка.' },
];
