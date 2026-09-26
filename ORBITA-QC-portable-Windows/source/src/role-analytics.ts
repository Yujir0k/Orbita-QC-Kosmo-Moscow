import type { Case, QualityEvent, Scope, Task } from './domain';
import { dayKey, median } from './technologist-analytics';

export type AnalyticsRole = 'controller' | 'master' | 'leader';
export interface RoleFilter { from: string; to: string; line: string; station: string; scope: Scope }
export interface AnalyticsRow { id: string; cells: (string | number)[]; item?: string; caseId?: string }
export interface AnalyticsSection { id: string; tab: string; title: string; note: string; headers: string[]; rows: AnalyticsRow[]; chart?: { label: string; value: number; target?: string }[] }
export interface AnalyticsMetric { label: string; value: string | number; note: string; tab: string }
export interface RoleDashboard { role: AnalyticsRole; title: string; filter: RoleFilter; dataAt: string; eventCount: number; metrics: AnalyticsMetric[]; sections: AnalyticsSection[]; insights: string[]; definitions: string[] }
export interface RoleAnalyticsInput { events: QualityEvent[]; cases: Case[]; tasks: Task[]; defectNames: Record<string, string>; stationNames: Record<string, string> }
export const numeric = (n: number | undefined) => n == null ? 'Нет данных' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(n);
const minutes = (end: string, start: string) => { const n = (Date.parse(end) - Date.parse(start)) / 60000; return Number.isFinite(n) && n >= 0 ? n : undefined; };
const stamp = (iso: string) => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
const share = (n: number, d: number) => d ? `${numeric(n / d * 100)}%` : 'Нет данных';
const distinct = <T,>(rows: T[], key: (row: T) => string) => [...new Map(rows.map(row => [key(row), row])).values()];
const order = (a: QualityEvent, b: QualityEvent) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.event_id.localeCompare(b.event_id);
const finalDecisions = new Set(['confirmed', 'rejected', 'accepted_within_spec', 'release_after_rework', 'scrap_approved']);
const decisionLabels: Record<string, string> = { confirmed: 'Дефект подтверждён', rejected: 'Признак отклонён', accepted_within_spec: 'В пределах КД', release_after_rework: 'Выпуск после доработки', scrap_approved: 'Списание', additional_check: 'Доппроверка', recheck: 'Повторная проверка' };
const dispositionLabels: Record<string, string> = { rework: 'Доработка', hold: 'Очный досмотр', quarantine: 'Карантин', release: 'Выпуск', scrap: 'Списание' };
const causeLabels: Record<string, string> = { equipment: 'Оборудование', equipment_issue: 'Оборудование', procedural_error: 'Ошибка процедуры', incoming: 'Входной дефект', incoming_defect: 'Входной дефект', material: 'Материал', unknown: 'Причина неизвестна' };
export const roleTitles: Record<AnalyticsRole, string> = { controller: 'Контроль и решения ОТК', master: 'Исполнение и передача смены', leader: 'Качество и результаты производства' };

/** Cohort metrics use observation/start dates; decision and action registers use their own dates.
 * Outcomes always describe the latest accepted snapshot, even if a decision arrived after the cohort period. */
export function buildRoleAnalytics(input: RoleAnalyticsInput, role: AnalyticsRole, filter: RoleFilter): RoleDashboard {
  const events = distinct(input.events, e => e.event_id).sort(order);
  const area = (e: QualityEvent) => (filter.line === 'all' || e.line_id === filter.line) && (filter.station === 'all' || e.station_id === filter.station) && (filter.scope === 'all' || e.shift_id === filter.scope);
  const match = (e: QualityEvent) => area(e) && (!filter.from || dayKey(e.occurred_at) >= filter.from) && (!filter.to || dayKey(e.occurred_at) <= filter.to);
  const byItem = new Map<string, QualityEvent[]>();
  for (const e of events) byItem.set(e.item_id, [...(byItem.get(e.item_id) ?? []), e]);
  const dataAt = events.at(-1)?.occurred_at ?? '';
  const cohort = distinct(input.cases, c => c.id).filter(c => c.observations.length && match([...c.observations].sort(order)[0]));
  const caseRows = cohort.map(c => {
    const first = [...c.observations].sort(order)[0];
    const decisions = distinct(c.decisions, e => e.event_id).sort(order);
    const last = decisions.at(-1);
    const substantive = decisions.find(e => finalDecisions.has(e.data.decision ?? ''));
    const historical = decisions.some(e => e.data.decision === 'confirmed') && c.type !== 'UNASSESSABLE';
    const reviewedIds = c.review?.data.reviewed_event_ids;
    const stale = Array.isArray(reviewedIds) && (byItem.get(c.item) ?? []).some(e => !['cause_review', 'evidence_request'].includes(e.event_type) && !reviewedIds.includes(e.event_id));
    const cause = !historical ? 'Не применяется' : stale ? 'Пересмотр: новые факты' : c.review?.data.status === 'confirmed' ? 'Причина установлена' : c.review?.data.status === 'unknown' ? 'Причина неизвестна' : c.review?.data.status === 'hypothesis' ? 'Гипотеза' : 'Без заключения';
    return { c, first, last, historical, cause, response: substantive ? minutes(substantive.occurred_at, first.occurred_at) : undefined, state: last ? decisionLabels[last.data.decision ?? ''] ?? last.data.decision ?? 'Решение' : 'Ожидает решения' };
  });
  const confirmed = caseRows.filter(r => r.historical);
  const inspections = events.filter(e => e.event_type === 'inspection_result' && match(e));
  const evaluated = inspections.filter(e => e.data.observation_quality === 'good' && ['signs_detected', 'no_signs_detected'].includes(e.data.inspection_result ?? ''));
  const inspectedIds = new Set(evaluated.map(e => e.item_id));
  const defectiveIds = new Set(confirmed.map(r => r.c.item));
  const rateNumerator = [...defectiveIds].filter(id => inspectedIds.has(id)).length;
  const starts = events.filter(e => e.event_type === 'operation_started' && match(e));
  const runs = starts.map(start => {
    const own = byItem.get(start.item_id) ?? [];
    const finish = own.find(e => e.event_type === 'operation_finished' && e.operation_run_id === start.operation_run_id && order(e, start) >= 0);
    const duration = finish ? minutes(finish.occurred_at, start.occurred_at) : undefined;
    const paused = !finish && own.some(e => e.event_type === 'operation_paused' && e.operation_run_id === start.operation_run_id && order(e, start) >= 0);
    return { start, finish, duration, paused, rework: !!start.data.previous_operation_run_id };
  });
  const completed = runs.filter(r => r.duration != null);
  const repeated = runs.filter(r => r.rework);
  const decisions = events.filter(e => e.event_type === 'quality_decision' && match(e));
  const actions = events.filter(e => e.event_type === 'master_action' && match(e));
  const reworkActions = actions.filter(e => e.data.action_type === 'rework_completed');
  // A later cycle must not inherit the release of a previous cycle (and vice versa).
  const reworkResults = reworkActions.map(action => {
    const own = byItem.get(action.item_id) ?? [];
    const linked = (e: QualityEvent) => typeof action.data.case_id === 'string'
      ? e.data.case_id === action.data.case_id || !!e.data.finding_refs?.some(ref => action.data.finding_refs?.includes(ref))
      : action.data.finding_refs?.length ? !!e.data.finding_refs?.some(ref => action.data.finding_refs?.includes(ref)) : true;
    const nextAction = own.find(e => e.event_type === 'master_action' && e.data.action_type === 'rework_completed' && order(e, action) > 0 &&
      (linked(e) || (!e.data.case_id && !e.data.finding_refs?.length)));
    const decision = own.find(e => e.event_type === 'quality_decision' && finalDecisions.has(e.data.decision ?? '') && order(e, action) > 0 && (!nextAction || order(e, nextAction) < 0) && linked(e));
    const duration = typeof action.data.duration_minutes === 'number' && Number.isFinite(action.data.duration_minutes) && action.data.duration_minutes > 0 ? action.data.duration_minutes : undefined;
    return { action, decision, duration };
  });
  const reviewedReworks = reworkResults.filter(r => r.decision);
  const releasedReworks = reviewedReworks.filter(r => r.decision?.data.decision === 'release_after_rework');
  // Open queue is a current snapshot, including tasks created before the selected interval.
  const queue = distinct(input.tasks, t => t.id).filter(t => !t.done && area(t.event) && (role === 'leader' || t.role === role));
  const definitions = [
    'Период — календарные дни Москвы. Изделия считаются по оценённым наблюдениям, дела — по первому наблюдению, операции — по началу, решения и действия — по собственному времени.',
    'Статус дела и результат доработки учитывают все уже принятые последующие события. Это текущий результат выбранной группы, а не восстановление состояния на конец периода.',
    'Одно изделие может иметь несколько дефектов. Повторные доставки event_id не увеличивают счётчики. Исправление сохраняет исторический дефект.',
    'Результат доработки связывается по делу или признаку до следующей доработки того же контекста. Для старых событий без ссылок используется последовательность по изделию; при параллельных делах связь требует ручной проверки.',
    'Очередь передачи смены показывает все текущие открытые задачи выбранной линии, участка и смены, включая возникшие до выбранного периода.',
    'Время операции — интервал между началом и завершением, включая паузы. Сумма интервалов не является простоем или трудозатратами. Незавершённые операции исключены из длительностей.',
    'Без согласованных нормативов, сроков заданий и полной истории пауз не рассчитываются просрочки, экономический ущерб, простой и выполнение плана. FPY пока не рассчитывается: не определены обязательные точки и полный цикл приёмки.',
  ];
  const sections: AnalyticsSection[] = [];
  const add = (s: AnalyticsSection) => sections.push(s);
  const countGroups = (labels: string[]) => [...new Set(labels)].map(label => ({ label, value: labels.filter(v => v === label).length })).sort((a, b) => b.value - a.value);
  add({ id: 'defects', tab: 'quality', title: 'Подтверждённые дефекты по типам', note: 'Исторические подтверждения ОТК в группе дел по дате первого наблюдения; исправленные дефекты сохраняются.', headers: ['Тип', 'Дефекты', 'Уникальные изделия'], rows: countGroups(confirmed.map(r => input.defectNames[r.c.type] ?? r.c.type)).map(r => ({ id: r.label, cells: [r.label, r.value, new Set(confirmed.filter(c => (input.defectNames[c.c.type] ?? c.c.type) === r.label).map(c => c.c.item)).size] })), chart: countGroups(confirmed.map(r => input.defectNames[r.c.type] ?? r.c.type)) });
  const days = [...new Set([...inspections.map(e => dayKey(e.occurred_at)), ...confirmed.map(r => dayKey(r.first.occurred_at))])].sort();
  add({ id: 'trend', tab: 'quality', title: 'Динамика контроля', note: 'Дневные количества уникальных изделий нельзя складывать в итог периода: одно изделие может проверяться в разные дни.', headers: ['Дата', 'Оценено изделий', 'Изделия с подтверждёнными дефектами', 'Дефекты'], rows: days.map(day => ({ id: day, cells: [day, new Set(evaluated.filter(e => dayKey(e.occurred_at) === day).map(e => e.item_id)).size, new Set(confirmed.filter(r => dayKey(r.first.occurred_at) === day).map(r => r.c.item)).size, confirmed.filter(r => dayKey(r.first.occurred_at) === day).length] })), chart: days.map(day => ({ label: day, value: confirmed.filter(r => dayKey(r.first.occurred_at) === day).length })) });
  add({ id: 'cases', tab: 'quality', title: 'Реестр случаев и решений', note: 'Каждая строка открывает соответствующее дело или паспорт. Время до первого содержательного решения считается только при наличии решения.', headers: ['Изделие / дело', 'Дефект', 'Участок', 'Текущий итог ОТК', 'До решения, мин', 'Основание'], rows: caseRows.map(r => ({ id: r.c.id, item: r.c.item, caseId: r.c.id, cells: [`${r.c.item} / ${r.c.id}`, input.defectNames[r.c.type] ?? r.c.type, input.stationNames[r.first.station_id] ?? r.first.station_id, r.state, numeric(r.response), `${r.first.event_id} → ${r.last?.event_id ?? 'решения нет'}`] })) });
  add({ id: 'queue', tab: role === 'master' ? 'handover' : 'overview', title: role === 'master' ? 'Передать следующей смене' : 'Открытые задачи', note: `Текущее состояние на ${dataAt ? stamp(dataAt) : 'момент снимка данных'}. Возраст — от события-основания до последнего принятого события. Это не просрочка.`, headers: ['Изделие', 'Задача', 'Кому', 'Возраст, мин', 'Что проверить', 'Основание'], rows: queue.sort((a,b) => b.priority - a.priority).map(t => ({ id: t.id, item: t.item, caseId: t.caseId, cells: [t.item, t.title, ({ controller: 'ОТК', master: 'Мастер', technologist: 'Технолог', leader: 'Руководитель', administrator: 'Администратор' })[t.role], numeric(dataAt ? minutes(dataAt, t.event.occurred_at) : undefined), t.description, t.event.event_id] })) });

  if (role === 'controller') {
    add({ id: 'decisions', tab: 'decisions', title: 'Журнал решений за период', note: 'Считаются действия ОТК по дате решения. Несколько решений по одному изделию — разные действия, а не дополнительные изделия.', headers: ['Изделие', 'Время решения', 'Решение', 'Направление', 'Контролёр', 'Обоснование', 'ID'], rows: decisions.map(e => ({ id: e.event_id, item: e.item_id, caseId: typeof e.data.case_id === 'string' ? e.data.case_id : undefined, cells: [e.item_id, stamp(e.occurred_at), decisionLabels[e.data.decision ?? ''] ?? e.data.decision ?? 'Не указано', dispositionLabels[e.data.disposition ?? ''] ?? e.data.disposition ?? 'Не указано', e.actor_id ?? 'Не указан', e.data.reason ?? 'Основание не передано', e.event_id] })), chart: countGroups(decisions.map(e => decisionLabels[e.data.decision ?? ''] ?? e.data.decision ?? 'Не указано')) });
    const sourceGroups = [...new Set(inspections.map(e => `${e.source_id} / ${e.analyzer_version ?? 'версия не указана'}`))];
    add({ id: 'sources', tab: 'sources', title: 'Качество наблюдений по источникам', note: 'Это качество поступивших наблюдений, не оценка точности модели. Неоценённые наблюдения не считаются годными.', headers: ['Источник / версия', 'Наблюдения', 'Оценено', 'С признаками', 'Не оценено / плохой обзор', 'Доля неоценённых'], rows: sourceGroups.map(id => {
      const own = inspections.filter(e => `${e.source_id} / ${e.analyzer_version ?? 'версия не указана'}` === id); const good = own.filter(e => evaluated.includes(e));
      return { id, cells: [id, own.length, good.length, own.filter(e => e.data.inspection_result === 'signs_detected').length, own.length - good.length, share(own.length-good.length, own.length)] };
    }) });
  } else {
    const lineGroups = [...new Set([...evaluated.map(e => `${e.line_id} / ${e.station_id}`), ...confirmed.map(r => `${r.first.line_id} / ${r.first.station_id}`)])].sort();
    add({ id: 'lines', tab: 'quality', title: 'Качество по линиям и участкам', note: 'Доля = изделия с подтверждённым дефектом, входящие в оценённую выборку / оценённые изделия той же линии и участка. Место обнаружения не доказывает причину.', headers: ['Линия / участок', 'Оценено изделий', 'С подтверждением из оценённых', 'Доля', 'Все подтверждённые дефекты'], rows: lineGroups.map(id => {
      const checked = new Set(evaluated.filter(e => `${e.line_id} / ${e.station_id}` === id).map(e => e.item_id)); const defects = confirmed.filter(r => `${r.first.line_id} / ${r.first.station_id}` === id); const bad = new Set(defects.filter(r => checked.has(r.c.item)).map(r => r.c.item)).size;
      return { id, cells: [id, checked.size, bad, share(bad, checked.size), defects.length] };
    }) });
    add({ id: 'runs', tab: 'time', title: 'Операции: фактическое время и незавершённые работы', note: 'Запуски отбираются по дате начала; завершение может поступить позже выбранного периода. Пауза без завершения не превращается в выдуманный простой.', headers: ['Изделие / запуск', 'Участок', 'Операция', 'Исполнитель / смена', 'Проход', 'Состояние', 'Полное время, мин'], rows: runs.map(r => ({ id: r.start.operation_run_id ?? r.start.event_id, item: r.start.item_id, cells: [`${r.start.item_id} / ${r.start.operation_run_id}`, input.stationNames[r.start.station_id] ?? r.start.station_id, String(r.start.data.operation_id ?? 'Не указана'), `${r.start.actor_id ?? 'Не указан'} / ${r.start.shift_id}`, r.rework ? 'Повторный' : 'Первичный', r.finish ? r.duration == null ? 'Некорректный интервал' : 'Завершён' : r.paused ? 'Пауза' : 'Не завершён', numeric(r.duration)] })) });
    const groupKey = (r: typeof runs[number]) => [r.start.item_type_id, r.start.data.operation_id, r.start.station_id, r.start.equipment_id ?? '?', r.start.data.program_id ?? '?', r.start.data.program_revision ?? '?', r.start.actor_id ?? '?', r.start.shift_id, r.rework ? 'Повторный' : 'Первичный'].join(' / ');
    add({ id: 'durations', tab: 'time', title: 'Сопоставимые группы операций', note: 'Группы разделены по типу изделия, операции, участку, оборудованию, программе и ревизии, исполнителю, смене и проходу. «?» — поле отсутствует; такие группы не подтверждают сопоставимость. Норматив не задан.', headers: ['Условия группы', 'Завершено / запуски', 'Медиана, мин', 'Мин–макс, мин'], rows: [...new Set(runs.map(groupKey))].map(id => { const group = runs.filter(r => groupKey(r) === id); const values = group.flatMap(r => r.duration == null ? [] : [r.duration]); return { id, cells: [id, `${values.length} / ${group.length}`, numeric(median(values)), values.length ? `${numeric(Math.min(...values))}–${numeric(Math.max(...values))}` : 'Нет данных'] }; }) });
    add({ id: 'reworks', tab: 'rework', title: 'Результаты доработок', note: 'Циклы по действиям мастера в периоде. Результат — первое связанное решение ОТК до следующей доработки того же контекста. Без ссылок на дело связь по изделию требует проверки. Длительность введена мастером и не суммируется с интервалами MES.', headers: ['Изделие', 'Выполнено', 'Способ', 'Исполнитель', 'Заявлено, мин', 'Результат ОТК', 'События'], rows: reworkResults.map(r => ({ id: r.action.event_id, item: r.action.item_id, cells: [r.action.item_id, stamp(r.action.occurred_at), String(r.action.data.rework_method ?? r.action.data.reason ?? 'Не передан'), String(r.action.data.executor_id ?? r.action.actor_id ?? 'Не указан'), numeric(r.duration), r.decision ? decisionLabels[r.decision.data.decision ?? ''] ?? 'Решение записано' : 'Ждёт повторного контроля', `${r.action.event_id} → ${r.decision?.event_id ?? 'нет квитанции ОТК'}`] })), chart: [{ label: 'Выпуск после доработки', value: releasedReworks.length }, { label: 'Повторное решение без выпуска', value: reviewedReworks.length - releasedReworks.length }, { label: 'Ожидают ОТК', value: reworkResults.length - reviewedReworks.length }] });
    if (role === 'master') add({ id: 'actions', tab: 'handover', title: 'Выполненные действия мастера', note: 'Журнал по собственному времени действия, включая очные досмотры и передачу в изолятор. Завершение мастером не означает выпуск ОТК.', headers: ['Изделие', 'Время', 'Действие', 'Автор', 'Комментарий', 'ID'], rows: actions.map(e => ({ id: e.event_id, item: e.item_id, cells: [e.item_id, stamp(e.occurred_at), ({ rework_completed: 'Доработка завершена', inspection_support: 'Очный досмотр', scrap_to_isolator: 'Передано в изолятор' } as Record<string,string>)[e.data.action_type ?? ''] ?? String(e.data.action_type ?? 'Не указано'), e.actor_id ?? 'Не указан', String(e.data.comment ?? e.data.reason ?? ''), e.event_id] })) });
    if (role === 'leader') {
      const states = countGroups(confirmed.map(r => r.cause));
      add({ id: 'causes', tab: 'causes', title: 'Причины и неопределённость', note: 'Единица — подтверждённое дело. Гипотезы и заключения, требующие пересмотра, не входят в установленные причины.', headers: ['Статус', 'Дела'], rows: states.map(r => ({ id: r.label, cells: [r.label, r.value] })), chart: states });
      add({ id: 'cause-register', tab: 'causes', title: 'Установленные причины и основания', note: 'Только актуальные подтверждённые заключения технолога. Входное обнаружение и связь со станком сами по себе не определяют причину.', headers: ['Изделие / дело', 'Причина', 'Заключение', 'Автор', 'ID и основания'], rows: confirmed.filter(r => r.cause === 'Причина установлена').map(r => ({ id: r.c.id, item: r.c.item, caseId: r.c.id, cells: [`${r.c.item} / ${r.c.id}`, causeLabels[r.c.review?.data.cause_type ?? ''] ?? r.c.review?.data.cause_type ?? 'Не указана', r.c.review?.data.reason ?? '', r.c.review?.actor_id ?? 'Не указан', `${r.c.review?.event_id} / ${r.c.review?.data.basis_event_ids?.join(', ') ?? ''}`] })) });
    }
  }
  const responses = caseRows.flatMap(r => r.response == null ? [] : [r.response]);
  const metric = (label: string, value: string | number, note: string, tab: string): AnalyticsMetric => ({ label, value, note, tab });
  const qualityMetrics = [metric('Оценено изделий', inspectedIds.size, 'Уникальные изделия с пригодным наблюдением', 'quality'), metric('Изделия с дефектами', defectiveIds.size, `${confirmed.length} подтверждённых дел в группе`, 'quality')];
  const metrics = role === 'controller' ? [...qualityMetrics, metric('Открытые задачи ОТК', queue.length, 'Текущая очередь выбранной области', 'overview'), metric('До первого решения', numeric(median(responses)), `Медиана, мин · ${responses.length} дел с решением`, 'decisions'), metric('Неоценённые наблюдения', inspections.length - evaluated.length, `Из ${inspections.length} наблюдений за период`, 'sources'), metric('Решений за период', decisions.length, 'По времени действия контролёра', 'decisions')]
    : role === 'master' ? [metric('Открытые задачи участка', queue.length, 'Включая задачи прошлых периодов', 'handover'), metric('Незавершённые запуски', runs.filter(r => !r.finish).length, `${runs.filter(r => r.paused).length} на паузе`, 'time'), metric('Доработки выполнены', reworkActions.length, 'Действия мастера в выбранном периоде', 'rework'), metric('Выпуск после доработки', share(releasedReworks.length, reviewedReworks.length), `${releasedReworks.length} / ${reviewedReworks.length} циклов с итогом ОТК`, 'rework'), metric('Длительность доработки', numeric(median(reworkResults.flatMap(r => r.duration == null ? [] : [r.duration]))), 'Медиана заявленных мастером минут', 'rework'), metric('Повторные запуски MES', repeated.length, `Из ${runs.length} начатых операций`, 'time')]
    : [...qualityMetrics, metric('Доля с несоответствием', share(rateNumerator, inspectedIds.size), `${rateNumerator} / ${inspectedIds.size} оценённых изделий`, 'quality'), metric('Открытые задачи команды', queue.length, 'Текущая очередь выбранной области', 'overview'), metric('Повторные запуски', repeated.length, `${share(repeated.length, runs.length)} из ${runs.length} запусков`, 'rework'), metric('Причина установлена', confirmed.filter(r => r.cause === 'Причина установлена').length, `Актуальные выводы из ${confirmed.length} дел`, 'causes')];
  const insights = role === 'controller' ? [`${queue.length} задач ОТК остаются открытыми: откройте очередь и проверьте основания.`, `${inspections.length - evaluated.length} наблюдений не дают достаточной оценки; они исключены из числа оценённых изделий.`, `Первое содержательное решение имеется для ${responses.length} из ${caseRows.length} дел выбранной группы.`]
    : role === 'master' ? [`Передайте следующей смене ${queue.length} открытых задач с основанием и текущим состоянием.`, `${reworkResults.length-reviewedReworks.length} выполненных доработок ожидают итогового решения ОТК.`, `${completed.length} из ${runs.length} запусков имеют корректные границы времени; суммарно ${numeric(completed.reduce((n,r) => n+r.duration!,0))} мин интервалов операций.`]
    : [`${confirmed.filter(r => r.first.data.inspection_point_id === 'CP-IN').length} подтверждённых дефектов обнаружено на входе: рассматривайте их отдельно от результатов обработки.`, `${confirmed.filter(r => r.cause !== 'Причина установлена').length} дел не имеют актуальной установленной причины.`, `${queue.filter(t => t.priority >= 120).length} открытых задач имеют высокий расчётный приоритет (≥120); проверьте основания в паспорте.`];
  return { role, title: roleTitles[role], filter, dataAt, eventCount: events.length, metrics, sections, insights, definitions };
}
