import type { AnalyticsSection, RoleDashboard } from './role-analytics';
import { escapeHtml, barChartSvg } from './technologist-report';
import type { TechnologistAnalytics } from './technologist-analytics';
import type { ReportOptions } from './technologist-report';

export interface SnapshotMeta { id: string; createdAt: string; author: string; title: string; revision: number }
/** Quotes delimiters/newlines and neutralizes spreadsheet formulas in user-controlled values. */
export function csvCell(value: unknown) {
  let text = String(value ?? '');
  if (/^[\s\uFEFF]*[=+@-]/u.test(text) || /^[\t\r]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function rowsCsv(rows: unknown[][]) { return '\uFEFF' + rows.map(row => row.map(csvCell).join(';')).join('\r\n'); }
export const filterText = (model: RoleDashboard) => `${model.filter.from || 'Начало истории'} — ${model.filter.to || 'Конец истории'}; Москва; линия: ${model.filter.line === 'all' ? 'все доступные' : model.filter.line}; участок: ${model.filter.station === 'all' ? 'все' : model.filter.station}; смена: ${model.filter.scope === 'all' ? 'все' : model.filter.scope}`;
export function dashboardCsv(model: RoleDashboard, meta: SnapshotMeta, sections: AnalyticsSection[]) {
  return rowsCsv([
    ['Отчёт', meta.title], ['ID снимка', meta.id], ['Сформирован', meta.createdAt], ['Подготовил', meta.author], ['Роль', model.role], ['Версия проекции', meta.revision], ['Последнее принятое событие (время возникновения)', model.dataAt], ['Фильтры', filterText(model)],
    ['Происхождение', 'Учебный набор принятых событий; отчёт не является подписанным актом'], [], ['Показатель', 'Значение', 'Определение'],
    ...model.metrics.map(m => [m.label, m.value, m.note]),
    ...sections.flatMap(s => [[], [s.title], [s.note], s.headers, ...s.rows.map(r => r.cells)]), [], ['Методика'], ...model.definitions.map(d => [d]),
  ]);
}
export function dashboardHtml(model: RoleDashboard, meta: SnapshotMeta, sections: AnalyticsSection[]) {
  const e = escapeHtml;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(meta.title)}</title><style>
  *{box-sizing:border-box}body{font:14px/1.5 Arial,sans-serif;background:#eef2f5;color:#243746;margin:0}main{max-width:1180px;margin:24px auto;padding:36px;background:white}h1{font-size:28px}h2{font-size:20px;border-bottom:1px solid #bccbd5;padding-bottom:8px}small,.note{color:#536675}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.metric{background:#edf4f7;padding:14px}.metric strong{display:block;font-size:27px}.metric small{display:block}table{border-collapse:collapse;width:100%;font-size:11px;margin:16px 0;table-layout:fixed}td,th{padding:8px;border-bottom:1px solid #cbd7df;vertical-align:top;text-align:left;overflow-wrap:anywhere;white-space:pre-wrap}th{background:#edf4f7}svg{width:100%;max-width:800px;height:auto}.print{max-width:1180px;margin:18px auto}button{padding:10px 16px;cursor:pointer}section{margin:30px 0}footer{border-top:2px solid #36556a;margin-top:30px;padding-top:12px}@media(max-width:650px){main{padding:16px}.metrics{grid-template-columns:1fr 1fr}}@page{size:A4 landscape;margin:14mm}@media print{body{background:white}main{margin:0;padding:0;max-width:none}.print{display:none}tr,.metric{break-inside:avoid}h2{break-after:avoid}thead{display:table-header-group}*{print-color-adjust:exact;-webkit-print-color-adjust:exact}}
  </style></head><body><div class="print"><button onclick="window.print()">Печать / сохранить PDF</button></div><main><header><small>ОРБИТА.QC · ${e(model.title)}</small><h1>${e(meta.title)}</h1><p>${e(filterText(model))}</p><p>Подготовил: ${e(meta.author)} · сформирован ${e(meta.createdAt)}</p><small>ID ${e(meta.id)} · версия проекции ${meta.revision} · последнее событие ${e(model.dataAt || 'нет')} · ${model.eventCount} доступных событий</small></header>
  <div class="metrics">${model.metrics.map(m => `<div class="metric">${e(m.label)}<strong>${e(m.value)}</strong><small>${e(m.note)}</small></div>`).join('')}</div>
  <section><h2>Требует внимания</h2><ul>${model.insights.map(s => `<li>${e(s)}</li>`).join('')}</ul></section>
  ${sections.map(s => `<section><h2>${e(s.title)}</h2><p class="note">${e(s.note)}</p>${s.chart?.length ? barChartSvg(s.chart.slice(0,20).map(r => ({label:r.label,count:r.value}))) : ''}${s.chart && s.chart.length > 20 ? '<small>График: первые 20 групп; полная выборка в таблице.</small>' : ''}${s.rows.length ? `<table><thead><tr>${s.headers.map(h => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${s.rows.map(r => `<tr>${r.cells.map(c => `<td>${e(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<p>В выбранном срезе нет записей.</p>'}</section>`).join('')}
  <section><h2>Определения и границы расчёта</h2><ul>${model.definitions.map(s => `<li>${e(s)}</li>`).join('')}</ul></section><footer>Учебный набор, включая синтетические события. Зафиксированный снимок принятых данных. Поздние события могут изменить следующий отчёт. Документ не является подписанным актом или подтверждением подключения реального предприятия.</footer></main></body></html>`;
}
export function downloadAnalytics(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function technologistCsv(model: TechnologistAnalytics, options: ReportOptions, createdAt: string) {
  return rowsCsv([
    ['Отчёт технолога', options.title], ['Подготовил',options.author], ['Сформирован',createdAt], ['Фильтры',JSON.stringify(model.filter)],
    ['Происхождение','Учебный набор принятых событий; снимок текущих решений по выбранной группе'],
    ['Подтверждённые дефекты',model.confirmed.length], ['Изделия с дефектами',model.defectiveItems], ['Актуальные установленные причины',model.established], ['Запросы без ответа',model.pending.length],
    [], ['Требует внимания'], ...model.insights.map(text=>[text]),
    ...(options.defects ? [[], ['Динамика наблюдений'], ['Дата','Оценено изделий','Изделия с признаками','Подтверждённые дефекты'], ...model.daily.map(r=>[r.date,r.inspected,r.signals,r.defects])] : []),
    ...(options.defects ? [[], ['Дефекты'], ['Тип','Количество'], ...model.byDefect.map(r=>[r.label,r.count]), [], ['Полнота оснований'], ['Источник','Есть','Применимо','Процент'], ...model.coverage.map(r=>[r.label,r.count,r.total,r.rate??'Нет данных']), [], ['Ход разбора'], ...model.states.map(r=>[r.label,r.count])] : []),
    ...(options.equipment ? [[], ['Оборудование'], ['Станок','Запуски','Оценённый контроль','Запуски с подтверждением','Доля, %','С предупреждениями','С журналом'], ...model.equipment.map(r=>[r.id,r.runs,r.checked,r.confirmedRuns,r.rate??'Нет данных',r.warnings,r.telemetry])] : []),
    ...(options.operations ? [[], ['Операции'], ['Группа','Участок','Исполнитель','Станок','Программа','Версия','Смена','Повторный','Всего','Завершено','Медиана, мин','Минимум','Максимум'], ...model.durationGroups.map(r=>[r.label,r.station,r.executor,r.equipment,r.program,r.revision,r.shift,r.rework?'Да':'Нет',r.runs,r.finished,r.median??'Нет данных',r.min??'Нет данных',r.max??'Нет данных'])] : []),
    ...(options.cases ? [[], ['Прослеживаемость'], ['Дело','Первое наблюдение','Подтверждение ОТК','Заключение','Недостающие данные'], ...model.confirmed.map(r=>[r.id,r.observations[0]?.event_id,r.decisions.find(e=>e.data.decision==='confirmed')?.event_id??'Нет',r.review?.event_id??'Нет',r.review?.data.missing_data??''])] : []),
    ...(options.cases ? [[], ['Дела'], ['Дело','Изделие','Дефект','Статус','Заключение','Основания'], ...model.confirmed.map(r=>[r.id,r.item,r.type,model.states.find(s=>s.id===model.caseStates[r.id])?.label,r.review?.data.reason,r.review?.data.basis_event_ids?.join(', ')]), [], ['Открытые запросы'], ['Дело','Изделие','Получатель','Вопрос','ID запроса'], ...model.pending.map(r=>[r.record.id,r.record.item,r.request.data.recipient_role,r.request.data.reason,r.request.event_id])] : []),
  ]);
}
