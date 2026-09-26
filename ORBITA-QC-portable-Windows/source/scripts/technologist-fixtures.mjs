// Reproducible, explicitly synthetic production context. No inference of cause.
export function technologistFixtures(source, decisions) {
  const unique = [...new Map(source.map(row => [row.message.event_id, row.message])).values()];
  const rows = [];
  const catalog = {
    synthetic: true, revision: 'TECH-DEMO-1',
    note: 'Учебные режимы и пределы заданы для демонстрации; для производства нужны утверждённые техкарты и измерения.',
    equipment: ['EQ-CNC-01', 'EQ-CNC-02'].map((id, i) => ({ id, name: `Фрезерный центр ${i + 1}`, telemetrySource: `MACHINE-TECH-${i + 1}`, profile: 'MILL-BRACKET-A', calibration: 'Учебная проверка датчиков 16.02.2026' })),
    profiles: [{ id: 'MILL-BRACKET-A', operationId: 'OP-MILL', program: 'PRG-BRACKET-A', revision: '3', routeRevision: 'R2', tool: 'TOOL-FACE-01', fixture: 'FIX-01', parameters: [
      { key: 'spindle_speed_rpm', label: 'Частота шпинделя', unit: 'об/мин', nominal: 6000, lower: 5700, upper: 6300 },
      { key: 'feed_rate_mm_min', label: 'Подача', unit: 'мм/мин', nominal: 480, lower: 450, upper: 510 },
      { key: 'coolant_pressure_bar', label: 'Давление СОЖ', unit: 'бар', nominal: 4, lower: 3.5, upper: 4.5 },
      { key: 'vibration_index', label: 'Индекс вибронагрузки', unit: 'безразмерный', nominal: 2.4, lower: 0, upper: 5 },
      { key: 'vibration_velocity_rms_mm_s', label: 'Виброскорость (СКЗ)', unit: 'мм/с', nominal: 2.4, lower: 0, upper: 4.8 },
    ] }],
    provenance: [
      { owner: 'MES', supplies: 'Изделие, запуск операции, время, станок, оператор, программа, маршрут' },
      { owner: 'Станок / адаптер', supplies: 'Образцы параметров, единицы, окно измерения, предупреждения' },
      { owner: 'Контролёр', supplies: 'Очный осмотр, область дефекта, подтверждение и основания' },
      { owner: 'Мастер', supplies: 'Проверка оснастки и инструмента, изменения наладки, наблюдаемые обстоятельства' },
      { owner: 'Технолог', supplies: 'Гипотеза или вывод, альтернативы, недостающие сведения, ссылки на события' },
    ],
  };
  const add = (anchor, suffix, type, at, data, actor) => {
    const eventId = `TECH-DEMO-${anchor.item_id}-${suffix}`;
    rows.push({ delivery_id: `DLV-${eventId}`, deliver_at: new Date(at + 30000).toISOString(), message: {
      ...anchor, event_id: eventId, event_type: type, schema_version: '2.0', occurred_at: new Date(at).toISOString(),
      source_id: type === 'operation_context' ? 'MES-TECH-CARDS' : type === 'master_process_report' ? 'MASTER-UI-DEMO' : type === 'manual_inspection' ? 'QC-UI-DEMO' : 'MACHINE-TECH-DEMO',
      actor_id: actor, analyzer_version: undefined, data: { ...data, synthetic: true, fixture_revision: catalog.revision },
    } });
  };
  for (const start of unique.filter(event => event.event_type === 'operation_started' && event.data.operation_id === 'OP-MILL' && !event.data.previous_operation_run_id)) {
    const finish = unique.find(event => event.event_type === 'operation_finished' && event.operation_run_id === start.operation_run_id);
    if (!finish) continue;
    const oldSample = unique.find(event => event.event_type === 'machine_state' && event.operation_run_id === start.operation_run_id);
    const number = Number(start.item_id.split('-')[1]);
    for (const [index, fraction] of [0.2, 0.65, 0.9].entries()) {
      const at = Date.parse(start.occurred_at) + (Date.parse(finish.occurred_at) - Date.parse(start.occurred_at)) * fraction;
      const anomaly = start.item_id === 'ITEM-014' && index === 1;
      add(start, `SAMPLE-${index + 1}`, 'machine_state', at, {
        process_phase: ['rough_milling', 'contour_milling', 'finishing_pass'][index],
        state: anomaly ? 'warning' : 'running', alarm_code: anomaly ? 'VIB-WARN-TECH' : null,
        profile_id: 'MILL-BRACKET-A', spindle_speed_rpm: 6000 + ((number + index) % 5 - 2) * 25,
        feed_rate_mm_min: 480 + ((number + index) % 3 - 1) * 5,
        coolant_pressure_bar: Number((4 + ((number + index) % 3 - 1) * 0.1).toFixed(1)),
        vibration_velocity_rms_mm_s: anomaly ? 6.8 : Number((2 + ((number + index) % 5) * 0.2).toFixed(1)),
        vibration_index: anomaly ? 7.1 : Number((2.1 + ((number + index) % 5) * 0.2).toFixed(1)),
        spindle_load_peak_pct: oldSample?.data.spindle_load_peak_pct ?? 55 + number % 15,
        tool_life_used_min: oldSample?.data.tool_life_used_min ?? 110 + number % 24,
        coolant_state: 'on', sample_window_seconds: 30, measurement_kind: 'machine_telemetry_not_part_dimension',
      });
    }
  }
  for (const decision of decisions.map(row => row.message)) {
    const refs = decision.data.finding_refs;
    const signal = unique.find(event => event.event_id === refs[0].split('#')[0]);
    if (!signal) continue;
    const finding = signal.data.defects[0];
    const caseId = `NC-${signal.item_id}-${finding.defect_type_id}-${finding.region}`.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    add(signal, 'QC-INSPECTION', 'manual_inspection', Date.parse(decision.occurred_at) - 30000, {
      case_id: caseId, finding_refs: refs, basis_event_ids: [signal.event_id], inspection_result: 'signs_detected', method: 'physical_inspection',
      reason: signal.item_id === 'ITEM-004' ? 'Акт промежуточного контроля БТК на входе: вмятина на наружной поверхности корпуса подтверждена до начала обработки.' : signal.item_id === 'ITEM-007' ? 'Акт промежуточного контроля БТК: заусенец кромки B и поверхностная царапина подтверждены. Размеры признаков не измерялись.' : 'Акт промежуточного контроля БТК: риска на кромке B подтверждена, исходный кадр не сохранён. Осмотр не устанавливает причину.',
    }, decision.actor_id);
    // Each defect gets its own linked master report; the reports describe facts, not a causal verdict.
    for (const defect of signal.data.defects) {
      const id = `NC-${signal.item_id}-${defect.defect_type_id}-${defect.region}`.toUpperCase().replace(/[^A-Z0-9-]/g, '');
      add(signal, `MASTER-${defect.finding_id}`, 'master_process_report', Date.parse(decision.occurred_at) + 60000, {
        case_id: id, basis_event_ids: [decision.event_id], fixture_condition: signal.item_id === 'ITEM-004' ? 'not_applicable' : 'checked',
        tool_condition: signal.item_id === 'ITEM-004' ? 'not_applicable' : signal.item_id === 'ITEM-007' ? 'unknown' : 'checked',
        setup_changed: signal.item_id === 'ITEM-004' ? 'unknown' : 'no',
        comment: signal.item_id === 'ITEM-004' ? 'Приёмка заготовки: корпус поступил в упаковке поставщика, после получения обработки не выполнялись. Состояние при перевозке неизвестно.' : signal.item_id === 'ITEM-007' ? 'Проверка мастером участка после сигнала: деталь закреплена, видимых повреждений оснастки нет. Запись проверки инструмента перед запуском отсутствует. Состояние инструмента до операции восстановить нельзя.' : 'Проверка мастером участка после сигнала: инструмент и оснастка осмотрены, видимых повреждений нет; наладка не менялась. Контакт кромки с ложементом при перемещении не наблюдался.',
      }, 'MASTER-DEMO-01');
    }
  }
  for (const start of unique.filter(event => event.event_type === 'operation_started')) {
    const assembly = start.data.operation_id === 'OP-ASSEMBLY';
    const is7 = start.operation_run_id === 'RUN-007-MILLING-1';
    const data = {
      basis_event_ids: [start.event_id], operation_id: start.data.operation_id,
      program_id: assembly ? 'TC-ASSEMBLY-01' : start.data.program_id ?? 'PRG-BRACKET-A',
      program_revision: assembly ? 'R2' : start.data.program_revision ?? '3',
      program_name: is7 ? 'УП-ФРЕЗ-КР007-REV3.nc (контурная черновая/чистовая)' : assembly ? 'Карта финишной сборки ТК-СБ-01' : 'УП-ФРЕЗ-КР-REV3.nc',
      tool_name: is7 ? 'Фреза концевая монолитная Т15К6 Ø12 мм (Поз. Т-03, оправка HSK-A63)' : assembly ? 'Динамометрический инструмент' : 'Фреза концевая Ø12 мм · HSK-A63',
      fixture_name: is7 ? 'Пневмотиски Schunk KSC 125, усилие 25 кН' : assembly ? 'Сборочный стапель' : 'Пневмотиски · наладка по техкарте',
      equipment_id: start.equipment_id ?? (assembly ? 'EQ-ASSEMBLY-01' : 'EQ-CNC-01'),
      executor_id: assembly ? 'OP-04' : start.actor_id ?? 'OP-01',
      station_name: assembly ? 'Участок финишной сборки' : start.station_id === 'ST-MILL-02' ? 'Фрезерный участок №2' : 'Фрезерный участок №1',
      route_revision: 'R2',
    };
    add(start, `OP-CONTEXT-${start.operation_run_id}`, 'operation_context', Date.parse(start.occurred_at) + 1000, data, 'MES-PLANNER');
  }
  const start7 = unique.find(event => event.event_id === 'EVT-0044');
  const signal7 = unique.find(event => event.event_id === 'EVT-0047');
  if (start7 && signal7) {
    const begin = Date.parse(start7.occurred_at);
    for (const [index, [second, vibration]] of [[0, 2.5], [240, 2.6], [440, 2.9], [460, 7.1], [490, 2.8], [900, 2.6]].entries()) {
      add(start7, `TRACE-${index + 1}`, 'machine_state', begin + second * 1000, {
        state: vibration > 5 ? 'warning' : 'running', process_phase: second < 400 ? 'contour_milling' : 'finishing_pass',
        alarm_code: vibration > 5 ? 'VIB-WARN-TECH' : null, profile_id: 'MILL-BRACKET-A',
        spindle_speed_rpm: vibration > 5 ? 6050 : 6000, feed_rate_mm_min: vibration > 5 ? 485 : 475,
        coolant_pressure_bar: vibration > 5 ? 4.1 : 4, vibration_index: vibration, vibration_velocity_rms_mm_s: [2.2, 2.4, 2.6, 6.8, 2.5, 2.3][index],
        sample_window_seconds: 1, measurement_kind: 'machine_telemetry_not_part_dimension',
      });
    }
    const caseId = 'NC-ITEM-007-BURR-EDGEB';
    add(signal7, 'TOOL-JOURNAL', 'master_process_report', Date.parse(signal7.occurred_at) + 7 * 60000, {
      case_id: caseId, basis_event_ids: ['EVT-0047'], fixture_condition: 'checked', tool_condition: 'checked', setup_changed: 'no',
      tool_operating_hours: 14, tool_service_hours: 80, procedure_step_id: 'MILL-TOOL-CHECK',
      comment: 'Восстановленная запись журнала инструмента: 14 ч эксплуатации при ресурсе 80 ч. Режущие кромки осмотрены, сколов не обнаружено. Это время эксплуатации, а не минуты резания из ЧПУ.',
    }, 'MASTER-DEMO-01');
    add(signal7, 'DRIVE-DIAGNOSTIC', 'master_process_report', Date.parse(signal7.occurred_at) + 8 * 60000, {
      case_id: caseId, basis_event_ids: ['EVT-0046', 'EVT-0047'], fixture_condition: 'checked', tool_condition: 'checked', setup_changed: 'no',
      diagnostic_confirmed: true, cause_type: 'equipment_deviation', diagnostic_id: 'DIAG-CNC-007',
      comment: 'Протокол DIAG-CNC-007: ошибка обратной связи привода шпинделя воспроизведена на стенде на чистовом проходе при подаче 485 мм/мин. Вибрация 7.1 сопровождалась отжатием инструмента; после замены датчика дефект на контрольном образце не воспроизведён. Снижение скорости по предупреждению добавило 60 секунд. Протокол относится к заусенцу кромки B; причину царапины он не устанавливает.',
    }, 'MASTER-DEMO-01');
    add(signal7, 'INPUT-NDT', 'manual_inspection', Date.parse(signal7.occurred_at) + 6 * 60000, {
      case_id: caseId, basis_event_ids: ['EVT-0043', 'EVT-0047'], inspection_result: 'signs_detected', method: 'nondestructive_inspection',
      reason: 'Протокол входного неразрушающего контроля заготовки и повторной проверки зоны кромки B: скрытых раковин и входных повреждений в исследованной зоне не выявлено. EVT-0043 подтверждает только визуальный контроль поверхности.',
    }, 'QC-DEMO-01');
  }
  return { rows, catalog };
}
