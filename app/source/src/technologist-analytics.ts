import { matchesEvidenceAnswer } from './investigation-services';
import type { Case, Operation, QualityEvent, Scope } from './domain';

export interface AnalyticsFilter { from: string; to: string; line: string; equipment: string; defect: string; scope: Scope }
export interface AnalyticsInput { events: QualityEvent[]; cases: Case[]; operations: Operation[]; mediaIds: string[]; defectNames: Record<string,string> }
export const dayKey = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
export function median(values: number[]) { const sorted = [...values].sort((a,b) => a-b); const n = sorted.length; return n ? (sorted[Math.floor((n-1)/2)] + sorted[Math.floor(n/2)]) / 2 : undefined; }
const percent = (n: number, d: number) => d ? Math.round(n / d * 1000) / 10 : undefined;
function latestState(record: Case, events: QualityEvent[]) {
  const reviewed = record.review?.data.reviewed_event_ids;
  const stale = Array.isArray(reviewed) && events.some(event => event.item_id === record.item && !['cause_review','evidence_request'].includes(event.event_type) && !reviewed.includes(event.event_id));
  return stale ? 'revision' : record.review?.data.status ?? 'needed';
}
/** Counts come from accepted records. Equipment association describes context, never cause. */
export function buildTechnologistAnalytics(input: AnalyticsInput, filter: AnalyticsFilter) {
  const starts = input.events.filter(event => event.event_type === 'operation_started');
  const match = (event: QualityEvent) => (!filter.from || dayKey(event.occurred_at) >= filter.from) && (!filter.to || dayKey(event.occurred_at) <= filter.to)
    && (filter.line === 'all' || event.line_id === filter.line) && (filter.scope === 'all' || event.shift_id === filter.scope);
  const caseRun = (record: Case) => {
    const signal = record.observations[0];
    if (signal.operation_run_id) return starts.find(event => event.operation_run_id === signal.operation_run_id && event.item_id === record.item);
    if (signal.data.inspection_point_id === 'CP-IN') return undefined;
    return starts.filter(event => event.item_id === record.item && Date.parse(event.occurred_at) < Date.parse(signal.occurred_at)).sort((a,b) => Date.parse(a.occurred_at)-Date.parse(b.occurred_at)).at(-1);
  };
  const confirmed = input.cases.filter(record => record.confirmed && record.type !== 'UNASSESSABLE' && match(record.observations[0])
    && (filter.defect === 'all' || record.type === filter.defect)
    && (filter.equipment === 'all' || caseRun(record)?.equipment_id === filter.equipment));
  const states = [ ['needed','Без заключения'], ['hypothesis','Гипотеза'], ['confirmed','Причина установлена'], ['unknown','Причина не установлена'], ['revision','Новые факты — пересмотреть'] ].map(([id,label]) => ({ id, label, count: confirmed.filter(record => latestState(record, input.events) === id).length }));
  const byDefect = Object.entries(input.defectNames).filter(([id]) => id !== 'UNASSESSABLE').map(([id,label]) => ({ id,label,count: confirmed.filter(record => record.type === id).length })).filter(row=>row.count).sort((a,b)=>b.count-a.count);
  const runRows = starts.filter(start => match(start) && (filter.equipment === 'all' || start.equipment_id === filter.equipment)).map(start => {
    const operation = input.operations.find(row => row.id === start.operation_run_id);
    const own = input.events.filter(event => event.item_id === start.item_id);
    const nextStart = own.filter(event => event.event_type === 'operation_started' && Date.parse(event.occurred_at)>Date.parse(start.occurred_at)).sort((a,b)=>Date.parse(a.occurred_at)-Date.parse(b.occurred_at))[0];
    const finish = own.find(event => event.event_type === 'operation_finished' && event.operation_run_id === start.operation_run_id);
    const checks = finish ? own.filter(event => event.event_type === 'inspection_result' && Date.parse(event.occurred_at) >= Date.parse(finish.occurred_at)
      && (event.operation_run_id === start.operation_run_id || (!event.operation_run_id && (!nextStart || Date.parse(event.occurred_at)<Date.parse(nextStart.occurred_at))))) : [];
    const check = checks.sort((a,b)=>Date.parse(a.occurred_at)-Date.parse(b.occurred_at))[0];
    const samples = own.filter(event => event.event_type === 'machine_state' && event.operation_run_id === start.operation_run_id);
    const loads = samples.map(event=>event.data.spindle_load_peak_pct).filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
    const related = confirmed.filter(record => caseRun(record)?.operation_run_id === start.operation_run_id);
    const duration = finish ? (Date.parse(finish.occurred_at)-Date.parse(start.occurred_at))/60000 : undefined;
    return { id: start.operation_run_id!, item: start.item_id, equipment: start.equipment_id ?? 'Не указан', start, finish, check,
      duration: duration != null && duration >= 0 ? duration : undefined, name: operation?.name ?? String(start.data.operation_id ?? 'Операция не указана'),
      rework: !!start.data.previous_operation_run_id, load: loads.length ? Math.max(...loads) : undefined, warnings: samples.filter(event=>event.data.state === 'warning').length,
      evaluated: !!check && check.data.observation_quality === 'good' && ['signs_detected','no_signs_detected'].includes(check.data.inspection_result ?? ''),
      signs: check?.data.inspection_result === 'signs_detected' && (filter.defect === 'all' || !!check.data.defects?.some(finding=>finding.defect_type_id===filter.defect)), cases: related, samples: samples.length };
  });
  const equipment = [...new Set(runRows.map(row=>row.equipment))].map(id => {
    const runs = runRows.filter(row=>row.equipment===id); const checked = runs.filter(row=>row.evaluated);
    const confirmedRuns = checked.filter(row=>row.cases.length>0);
    return { id,label:id,runs:runs.length,checked:checked.length,signs:checked.filter(row=>row.signs).length,confirmedRuns:confirmedRuns.length,
      defects:runs.reduce((n,row)=>n+row.cases.length,0), rate:percent(confirmedRuns.length,checked.length),warnings:runs.filter(row=>row.warnings>0).length,
      medianDuration:median(runs.map(row=>row.duration).filter((n): n is number => n != null)), telemetry:runs.filter(row=>row.samples>0).length };
  });
  const groups = new Map<string, typeof runRows>();
  for (const run of runRows) {
    const context = input.events.filter(event => event.event_type === 'operation_context' && event.item_id === run.item && event.operation_run_id === run.id).at(-1);
    const d = { ...run.start.data, ...context?.data };
    const station = String(d.station_name ?? (run.start.station_id.includes('ASSEMBLY') ? 'Участок финишной сборки' : run.start.station_id.endsWith('-02') ? 'Фрезерный участок №2' : 'Фрезерный участок №1'));
    const executor = String(d.executor_id ?? run.start.actor_id ?? 'Исполнитель не назначен');
    const key=[run.start.item_type_id,d.operation_id,run.equipment,d.program_id ?? '?',d.program_revision ?? '?',d.program_name ?? '?',run.rework?'rework':'primary',run.start.shift_id,station,executor].join('|');
    groups.set(key,[...(groups.get(key)??[]),run]);
  }
  const durationGroups = [...groups.entries()].map(([id,runs])=>{
    const context = input.events.filter(event => event.event_type === 'operation_context' && event.item_id === runs[0].item && event.operation_run_id === runs[0].id).at(-1);
    const details = { ...runs[0].start.data, ...context?.data };
    const assembly = details.operation_id === 'OP-ASSEMBLY';
    const shiftName = runs[0].start.shift_id === 'SHIFT-A' ? 'Смена А' : runs[0].start.shift_id === 'SHIFT-B' ? 'Смена Б' : runs[0].start.shift_id;
    const station = String(details.station_name ?? (assembly ? 'Участок финишной сборки' : runs[0].start.station_id.endsWith('-02') ? 'Фрезерный участок №2' : 'Фрезерный участок №1'));
    const executor = String(details.executor_id ?? runs[0].start.actor_id ?? 'Исполнитель не назначен');
    const finished=runs.filter(row=>row.duration != null); const values=finished.map(row=>row.duration!);
    return { id,label:runs[0].name,equipment:runs[0].equipment,program:String(details.program_id ?? (assembly ? 'Сборочная техкарта не связана' : 'УП не связана')),revision:String(details.program_revision ?? 'Ревизия не подтверждена'),programName:String(details.program_name ?? details.program_id ?? 'Документ не связан'),station,executor:`${assembly ? 'Слесарь-сборщик' : 'Оператор'} ${executor} (${shiftName})`,shiftName,type:runs[0].start.item_type_id,
      rework:runs[0].rework,shift:runs[0].start.shift_id,comparable:!!details.program_id && !!details.program_revision,runs:runs.length,finished:finished.length,median:median(values),min:values.length?Math.min(...values):undefined,max:values.length?Math.max(...values):undefined,
      total:values.reduce((n,v)=>n+v,0),items:runs.map(row=>row.item) };
  }).sort((a,b)=>b.runs-a.runs);
  const inspections=input.events.filter(event=>event.event_type==='inspection_result' && match(event) && (filter.equipment==='all' || runRows.some(run=>run.id===event.operation_run_id)));
  const dates=[...new Set([...inspections.map(event=>dayKey(event.occurred_at)),...confirmed.map(record=>dayKey(record.observations[0].occurred_at))])].sort();
  const daily=dates.map(date=>({ date,label:date.slice(5).split('-').reverse().join('.'),inspected:new Set(inspections.filter(event=>dayKey(event.occurred_at)===date && event.data.observation_quality==='good' && event.data.inspection_result!=='unable_to_assess').map(event=>event.item_id)).size,
    signals:new Set(inspections.filter(event=>dayKey(event.occurred_at)===date && event.data.inspection_result==='signs_detected' && (filter.defect==='all' || event.data.defects?.some(finding=>finding.defect_type_id===filter.defect))).map(event=>event.item_id)).size,
    defects:confirmed.filter(record=>dayKey(record.observations[0].occurred_at)===date).length }));
  const ownFor=(record:Case)=>input.events.filter(event=>event.item_id===record.item);
  const physical=(record:Case)=>ownFor(record).some(event=>event.event_type==='manual_inspection' && (event.data.case_id===record.id || event.data.finding_refs?.some(ref=>record.refs.includes(ref))));
  const master=(record:Case)=>ownFor(record).some(event=>event.event_type==='master_process_report' && event.data.case_id===record.id);
  const hasImage=(record:Case)=>record.observations[0].data.evidence_refs?.some(id=>input.mediaIds.includes(id))??false;
  const productionCases=confirmed.filter(record=>!!caseRun(record));
  const coverage=[
    {label:'Очный осмотр ОТК',count:confirmed.filter(physical).length,total:confirmed.length},
    {label:'Сведения мастера',count:confirmed.filter(master).length,total:confirmed.length},
    {label:'Исходное изображение',count:confirmed.filter(hasImage).length,total:confirmed.length},
    {label:'Журнал связанного запуска',count:productionCases.filter(record=>input.events.some(event=>event.event_type==='machine_state' && event.operation_run_id===caseRun(record)?.operation_run_id)).length,total:productionCases.length},
  ].map(row=>({...row,rate:percent(row.count,row.total)}));
  const requests=input.events.filter(event=>event.event_type==='evidence_request' && confirmed.some(record=>record.id===event.data.case_id)).map(request=>{
    const answer=input.events.find(event=>matchesEvidenceAnswer(request,event));
    return {request,answer,record:confirmed.find(record=>record.id===request.data.case_id)!};
  });
  const incoming=confirmed.filter(record=>record.observations[0].data.inspection_point_id==='CP-IN').length;
  const pending=requests.filter(row=>!row.answer);
  const insights:string[]=[];
  if(byDefect.length) insights.push(`${byDefect[0].label}: ${byDefect[0].count} из ${confirmed.length} подтверждённых дефектов в срезе. Откройте эти дела и проверьте повторяемость обстоятельств.`);
  if(incoming) insights.push(`${incoming} дефектов обнаружено на входе до связанной операции. Рассматривайте их отдельно от дефектов после обработки.`);
  const noInspection=confirmed.filter(record=>!physical(record)).length;
  if(noInspection) insights.push(`В ${noInspection} делах нет отдельной записи очного осмотра. Запросите у ОТК область, метод и результат проверки.`);
  if(pending.length) insights.push(`Ожидаются ${pending.length} ответов на запросы. Уточните сведения у назначенной службы перед окончательным выводом.`);
  const warns=runRows.filter(row=>row.warnings>0).length;
  if(warns) insights.push(`Предупреждения есть в ${warns} из ${runRows.length} запусков. Сопоставьте время и параметры с дефектом; совпадение не устанавливает причину.`);
  if(!confirmed.length) insights.push('Подтверждённых дефектов в выбранном срезе нет. Измените фильтры или продолжайте контроль; отсутствие подтверждений не равно отсутствию признаков.');
  return { filter,confirmed,caseStates:Object.fromEntries(confirmed.map(record=>[record.id,latestState(record,input.events)])),states,byDefect,runRows,equipment,durationGroups,daily,coverage,requests,pending,insights,incoming,
    inspected:new Set(inspections.filter(event=>event.data.observation_quality==='good' && event.data.inspection_result!=='unable_to_assess').map(event=>event.item_id)).size,
    defectiveItems:new Set(confirmed.map(record=>record.item)).size,
    established:states.find(row=>row.id==='confirmed')!.count,
    warnings:warns,
    missingImage:confirmed.filter(record=>!hasImage(record)).length };
}
export type TechnologistAnalytics = ReturnType<typeof buildTechnologistAnalytics>;
