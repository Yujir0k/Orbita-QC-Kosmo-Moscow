const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');

const memory = new Map();
global.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
global.crypto = require('node:crypto').webcrypto;

function load(entry) {
  const filename = path.join(__dirname, '../src', entry);
  const input = fs.readFileSync(filename, 'utf8').replaceAll('import.meta.env.BASE_URL', "'/'");
  const code = ts.transpileModule(input, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename }).outputText;
  const instance = new Module(filename.replace(/\.ts$/, '.cjs'), module);
  instance.filename = filename.replace(/\.ts$/, '.cjs');
  instance.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = instance.require.bind(instance);
  instance.require = request => request === './domain' ? domain : ['controller-evidence', 'controller-case', 'investigation-services'].includes(request.slice(2)) ? load(request.slice(2) + '.ts') : originalRequire(request);
  instance._compile(code, instance.filename);
  return instance.exports;
}
const domain = load('domain.ts');
const nav = load('navigation.ts');
const controllerCase = load('controller-case.ts');
const controllerEvidence = load('controller-evidence.ts');
const readiness = load('controller-readiness.ts');

test('Decision guidance uses the actual defect, unknown result and restricted observation', () => {
  domain.resetDemo();
  const critical = domain.cases.find(row => row.item === 'ITEM-049');
  const advice = readiness.decisionReadiness(critical, domain.eventsFor(critical.item), false);
  assert.match(advice.title, /очный осмотр мастера/);
  assert.match(advice.request, /Кромка B.*COMP-049-BODY.*вмятина/);
  assert.ok(advice.reasons.some(reason => /критическую/.test(reason)));
  assert.equal(advice.confirmed, false);
  const unknown = domain.cases.find(row => row.item === 'ITEM-015');
  const unknownAdvice = readiness.decisionReadiness(unknown, domain.eventsFor(unknown.item), false);
  assert.match(unknownAdvice.request, /определить тип, компонент и зону/);
  assert.ok(!unknownAdvice.request.includes('вмятина'));
  const glare = domain.cases.find(row => row.item === 'ITEM-016');
  assert.match(readiness.decisionReadiness(glare, domain.eventsFor(glare.item), false).request, /другом освещении/);
  const good = domain.cases.find(row => row.item === 'ITEM-013');
  assert.match(readiness.decisionReadiness(good, domain.eventsFor(good.item), true).title, /оцените признак/);
});

test('Evidence excludes other items, unknown runs, future telemetry and stale measurements', () => {
  domain.resetDemo();
  const selected = domain.cases.find(row => row.item === 'ITEM-049');
  const history = domain.eventsFor(selected.item);
  const observation = selected.observations.at(-1);
  const later = new Date(Date.parse(observation.occurred_at) + 60000).toISOString();
  const injected = [
    {...history.find(row => row.event_type === 'machine_state'), event_id: 'FUTURE', occurred_at: later, data: {state: 'warning', alarm_code: 'FUTURE'}},
    {...observation, item_id: 'ITEM-OTHER', event_id: 'FOREIGN', event_type: 'manual_measurement', occurred_at: later, data: {case_id: selected.id, measured_value: 99}},
    {...observation, event_id: 'UNLINKED', event_type: 'manual_measurement', occurred_at: later, data: {measured_value: 98}},
    {...history[0], event_id: 'STALE', event_type: 'manual_measurement', data: {case_id: selected.id, measured_value: 97}},
  ];
  const evidence = controllerEvidence.controllerEvidenceFrom(selected, [...history, ...injected].reverse(), false);
  assert.notEqual(evidence.machine.event_id, 'FUTURE');
  assert.equal(evidence.measurement, undefined);
  assert.ok(!evidence.runEvents.some(row => row.event_id === 'FUTURE'));
  const unknown = {...selected, observations: [{...observation, operation_run_id: undefined}]};
  const unrelated = {...history[0], event_type: 'machine_state', operation_run_id: undefined};
  assert.equal(controllerEvidence.controllerEvidenceFrom(unknown, [...history, unrelated], false).machine, undefined);
  assert.deepEqual(controllerEvidence.controllerEvidenceFrom(unknown, [...history, unrelated], false).runEvents, []);
});

test('Image integrity separates HTTP/network errors, missing hash and a real mismatch', async () => {
  const originalFetch = global.fetch;
  const bytes = Buffer.from('test image bytes');
  const hash = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  try {
    global.fetch = async () => new Response(bytes, {headers: {'content-type': 'image/png'}});
    assert.equal(await readiness.verifyImage('/media/test.png', hash), 'valid');
    assert.equal(await readiness.verifyImage('/media/test.png', '0'.repeat(64)), 'invalid');
    assert.equal(await readiness.verifyImage('/media/test.png'), 'unavailable');
    global.fetch = async () => new Response('not found', {status: 404});
    assert.equal(await readiness.verifyImage('/media/test.png', hash), 'load_failed');
    global.fetch = async () => new Response('<html>fallback</html>', {headers: {'content-type': 'text/html'}});
    assert.equal(await readiness.verifyImage('/media/test.png', hash), 'load_failed');
    global.fetch = async () => { throw new Error('offline'); };
    assert.equal(await readiness.verifyImage('/media/test.png', hash), 'load_failed');
  } finally { global.fetch = originalFetch; }
});

test('Manual acceptance limits require a document and remain separate from source data', () => {
  domain.resetDemo();
  const selected = domain.cases.find(row => row.item === 'ITEM-049');
  const args = [selected.item, selected.id, 'Глубина вмятины', 0.2, 'GAGE-TEST', 'QC-TEST', true];
  assert.throws(() => domain.recordManualMeasurement(...args, {upper: 0.1, document: ''}), /документ/);
  assert.throws(() => domain.recordManualMeasurement(...args, {lower: 1, upper: 0.1, document: 'TEST КД'}), /границы/);
  const id = domain.recordManualMeasurement(...args, {upper: 0.1, document: 'TEST КД, редакция 1, пункт 2'});
  const evidence = controllerEvidence.controllerEvidenceFrom(selected, domain.eventsFor(selected.item), false);
  assert.equal(evidence.measurement.event_id, id);
  assert.equal(evidence.measurement.data.criteria_source, 'controller_entered');
  assert.equal(evidence.measurement.data.upper_limit, 0.1);
  assert.ok(evidence.measurement.data.measured_value > evidence.measurement.data.upper_limit);
  assert.ok(!evidence.missing.includes('Допуск по КД для контролируемого размера'));
  assert.equal(evidence.observation.data.upper_limit, undefined);
  domain.resetDemo();
});

test('The no-photo desk uses linked source facts without inventing dimensions or future work', () => {
  domain.resetDemo();
  const case49 = domain.cases.find(row => row.item === 'ITEM-049' && row.type === 'DENT');
  const evidence = controllerEvidence.controllerEvidenceFrom(case49, domain.eventsFor('ITEM-049'), false);
  assert.equal(evidence.observation.data.confidence, 0.93);
  assert.equal(evidence.previousInspection.data.inspection_result, 'no_signs_detected');
  assert.equal(evidence.operation.data.program_id, 'PRG-BRACKET-A');
  assert.equal(evidence.machine.data.spindle_load_peak_pct, 59);
  assert.equal(evidence.machine.data.tool_life_used_min, 134);
  assert.equal(evidence.measurement, undefined);
  assert.ok(evidence.missing.includes('Исходный кадр наблюдения'));
  assert.equal(evidence.runEvents.filter(row => row.event_type === 'operation_started').length, 1);
  const case7 = domain.cases.find(row => row.item === 'ITEM-007' && row.type === 'BURR');
  const warning = controllerEvidence.controllerEvidenceFrom(case7, domain.eventsFor('ITEM-007'), false);
  assert.equal(warning.machine.data.value, 7.1);
  assert.equal(warning.machine.data.configured_limit, 5);
  assert.match(controllerEvidence.machineAlertText(warning.machine), /Индекс вибрации 7.1.*пороге 5/);
});

test('A physical check without a photo is linked to one case and kept separate from the decision', () => {
  domain.resetDemo();
  const selected = domain.cases.find(row => row.item === 'ITEM-049' && row.type === 'DENT');
  const signalId = selected.observations.at(-1).event_id;
  const checkId = domain.recordControllerCheck('ITEM-049', selected.id, 'signs_detected', 'Осмотрена кромка B: вмятина видна при боковом освещении', 'QC-01');
  const check = controllerEvidence.latestControllerCheck(selected, domain.eventsFor('ITEM-049'));
  assert.equal(check.event_id, checkId);
  assert.equal(check.data.case_id, selected.id);
  assert.deepEqual(check.data.basis_event_ids, [signalId]);
  assert.equal(check.data.inspection_result, 'signs_detected');
  assert.equal(domain.cases.find(row => row.id === selected.id).observations.at(-1).event_id, signalId);
  assert.ok(!domain.eventsFor('ITEM-049').some(row => row.event_type === 'quality_decision'));
  domain.performAction('ITEM-049', 'controller', 'confirm_hold', 'СТП QC-01. Вмятина подтверждена при очной проверке', 'QC-01', false, selected.id, undefined, { observationEventId: selected.observations.at(-1).event_id, acknowledged: true });
  assert.equal(domain.eventsFor('ITEM-049').filter(row => row.event_type === 'quality_decision').at(-1).data.decision, 'confirmed');
  domain.performAction('ITEM-049', 'master', 'master_complete', 'Изделие передано на повторный осмотр', 'MASTER-01', false);
  assert.equal(controllerEvidence.latestControllerCheck(selected, domain.eventsFor('ITEM-049')), undefined);
});

test('An unassessable signal becomes a classified case after a positive physical check', () => {
  domain.resetDemo();
  const uncertain = domain.cases.find(row => row.item === 'ITEM-003' && row.type === 'UNASSESSABLE');
  const body = domain.items.find(row => row.id === 'ITEM-003').components.find(row => row.component_type_id === 'BODY');
  assert.ok(uncertain && body);
  const checkId = domain.recordControllerCheck('ITEM-003', uncertain.id, 'signs_detected', 'При осмотре левой кромки обнаружена вмятина', 'QC-01', { defectTypeId: 'DENT', region: 'outer_left_edge', componentId: body.id });
  const classified = domain.cases.find(row => row.item === 'ITEM-003' && row.type === 'DENT' && row.observations.some(event => event.data.basis_event_ids?.includes(checkId)));
  assert.ok(classified);
  assert.equal(classified.observations.at(-1).data.method, 'manual_verification');
  assert.equal(domain.cases.find(row => row.id === uncertain.id).status, 'Доппроверка выполнена');
  assert.ok(!domain.eventsFor('ITEM-003').some(row => row.event_type === 'quality_decision'));
  domain.performAction('ITEM-003', 'controller', 'confirm_hold', 'Акт QC-01. Вмятина подтверждена очной проверкой', 'QC-01', false, classified.id);
  assert.equal(domain.cases.find(row => row.id === classified.id).confirmed, true);
});

test('browser projection discards local human actions without a matching server receipt', () => {
  domain.resetDemo();
  const approval = { actionId: '00000000-0000-4000-8000-000000000001', actorId: 'controller-01' };
  domain.performAction('ITEM-013', 'controller', 'confirm', 'Риска подтверждена очным осмотром', 'ignored-form-author', true, undefined, undefined, undefined, undefined, approval);
  const originals = domain.actionDeliveries(approval.actionId);
  assert.equal(originals.length, 1);
  assert.equal(originals[0].message.actor_id, 'controller-01');
  domain.reconcileSecureEvents([]);
  assert.equal(domain.events.some(event => event.data.security_action_id === approval.actionId), false);
  domain.reconcileSecureEvents(originals);
  assert.equal(domain.events.filter(event => event.data.security_action_id === approval.actionId).length, 1);
  domain.resetDemo();
});

test('ITEM-013 returns to the fresh controller queue while other workshop tasks survive reconciliation', () => {
  domain.resetDemo();
  domain.performAction('ITEM-013', 'controller', 'confirm', 'Прежнее учебное направление на доработку', 'QC-02');
  const previous = domain.snapshotDemoState();
  previous.other.filter(row => row.message.item_id === 'ITEM-013').forEach(row => { row.message.source_id = 'ORBITA-DEMO'; });
  domain.restoreDemoState(previous);
  domain.prepareMasterShift();
  assert.equal(domain.eventsFor('ITEM-013').some(event => event.event_type === 'quality_decision'), false);
  assert.equal(domain.eventsFor('ITEM-014').some(event => event.source_id === 'ORBITA-DEMO' && event.data.disposition === 'rework'), true);
  domain.reconcileSecureEvents([]);
  assert.equal(domain.eventsFor('ITEM-013').some(event => event.event_type === 'quality_decision'), false);
  assert.equal(domain.eventsFor('ITEM-014').some(event => event.source_id === 'ORBITA-DEMO' && event.data.disposition === 'rework'), true);
  domain.resetDemo();
});

test('mobile observations appear from server receipts and disappear when their receipt is absent', () => {
  domain.resetDemo();
  const source = domain.eventsFor('ITEM-013').find(event => event.event_type === 'inspection_result');
  const event = structuredClone(source);
  event.event_id = 'MOBILE-TEST-1';
  event.source_id = 'MOBILE-EMU';
  event.data.capture_context = { source: 'mobile_robot_simulator', mission_id: 'TEST-1', synthetic: true };
  const row = { delivery_id: 'MOBILE-DLV-TEST-1', deliver_at: new Date().toISOString(), message: event };
  domain.reconcileMobileEvents([row]);
  assert.equal(domain.eventsFor('ITEM-013').some(value => value.event_id === event.event_id), true);
  domain.reconcileMobileEvents([]);
  assert.equal(domain.eventsFor('ITEM-013').some(value => value.event_id === event.event_id), false);
  domain.resetDemo();
});

test('Routes remain role-specific and visible modules are accessible to their role', () => {
  for (const role of nav.roles) for (const module of [...role.primary, ...role.secondary]) assert.ok(nav.canAccess(role.id, module), `${role.id}/${module}`);
  assert.deepEqual(nav.roleById.master.primary, ['home', 'operations', 'products']);
  assert.deepEqual(nav.roleById.master.secondary, ['analytics']);
  assert.equal(nav.canAccess('master', 'quality'), false);
  assert.equal(nav.canAccess('master', 'mobile'), false);
  assert.equal(nav.routeHash({ role: 'master', module: 'operations', section: 'terminal' }), '#/master/operations');
  assert.equal(nav.parseRoute('#/master/production/line').module, 'home');
  assert.equal(nav.parseRoute('#/controller/security/crypto').module, 'home');
  assert.equal(nav.parseRoute('').module, 'home');
  assert.equal(nav.canAccess('controller', 'tasks'), false);
  assert.equal(nav.parseRoute('#/controller/products/registry?item=ITEM-013').item, 'ITEM-013');
  assert.equal(nav.parseRoute('#/controller/quality/signals?item=ITEM-013&case=NC-123').caseId, 'NC-123');
  assert.equal(nav.sectionsFor('controller', 'quality').length, 1);
});

test('Controller dossier uses each CV finding and flags absent original frames', () => {
  domain.resetDemo();
  const case49 = domain.cases.find(row => row.item === 'ITEM-049' && row.type === 'DENT');
  const case13 = domain.cases.find(row => row.item === 'ITEM-013' && row.type === 'SCRATCH');
  assert.ok(case49 && case13);
  const item49 = domain.items.find(row => row.id === 'ITEM-049');
  const item13 = domain.items.find(row => row.id === 'ITEM-013');
  const dossier49 = controllerCase.controllerCaseData(case49, item49, domain.mediaIndex);
  const dossier13 = controllerCase.controllerCaseData(case13, item13, domain.mediaIndex);
  assert.equal(dossier49.regionName, 'Кромка B');
  assert.equal(dossier49.confidence, '93%');
  assert.equal(dossier49.image, undefined);
  assert.ok(dossier49.missing.includes('Исходный кадр CV не передан'));
  assert.equal(dossier13.image.asset_id, 'M013-CV-DEFECT');
  domain.performAction('ITEM-049', 'controller', 'additional', 'Нужен исходный кадр для проверки кромки', 'QC-01', true, case49.id);
  const recorded = domain.eventsFor('ITEM-049').filter(row => row.event_type === 'quality_decision').at(-1);
  assert.deepEqual(recorded.data.finding_refs, case49.refs);
  domain.resetDemo();
  const first15 = domain.cases.find(row => row.item === 'ITEM-015' && row.region === 'CP-IN');
  domain.performAction('ITEM-015', 'controller', 'additional', 'Нет исходного кадра; требуется очная проверка', 'QC-01', true, first15.id);
  const cases15 = domain.cases.filter(row => row.item === 'ITEM-015');
  assert.equal(cases15.find(row => row.region === 'CP-IN').decisions.length, 1);
  assert.equal(cases15.find(row => row.region === 'CP-POST-MILL').decisions.length, 0);
  const bodyObservation = domain.eventsFor('ITEM-049').find(row => row.event_type === 'inspection_result' && row.data.inspection_result === 'signs_detected');
  const insertObservation = structuredClone(bodyObservation);
  insertObservation.event_id = 'E-INSERT-049';
  insertObservation.data.defects[0].component_id = 'COMP-049-INSERT';
  const distinct = domain.projectCases([bodyObservation, insertObservation]);
  assert.equal(new Set(distinct.map(row => row.id)).size, 2);
});

test('The expanded demo preserves seeded technologist cases and ITEM-013 before its first decision', () => {
  domain.resetDemo();
  assert.equal(domain.items.length, 180);
  assert.ok(domain.events.some(e => e.item_id === 'ITEM-013' && e.data.inspection_result === 'signs_detected'));
  assert.ok(!domain.events.some(e => e.item_id === 'ITEM-013' && e.event_type === 'operation_started' && e.data.operation_id === 'OP-REWORK'));
  assert.ok(domain.events.some(e => e.item_id === 'ITEM-007' && e.event_type === 'quality_decision'));
  assert.ok(!domain.eventsFor('ITEM-013').some(e => ['quality_decision', 'master_action', 'technical_disposition'].includes(e.event_type)));
  assert.equal(domain.mediaFor('ITEM-015').length, 0);
  assert.ok(domain.tasks.some(t => t.item === 'ITEM-015' && t.role === 'controller'));
  assert.ok(domain.metrics('all').defects >= 3);
});

test('Structured media, CV dimensions, KD and physical routing cover four evidence paths', () => {
  const inspection = (item, point) => domain.sourceDeliveries.map(row => row.message)
    .find(event => event.item_id === item && event.event_type === 'inspection_result' && event.data.inspection_point_id === point);
  const newDefect = inspection('ITEM-013', 'CP-POST-MILL');
  const incomingDefect = inspection('ITEM-019', 'CP-IN');
  const oldDefect = inspection('ITEM-019', 'CP-POST-MILL');
  const lost = inspection('ITEM-020', 'CP-POST-MILL');
  const restricted = inspection('ITEM-021', 'CP-POST-MILL');
  assert.deepEqual([newDefect.data.media_evidence.before_operation.status, newDefect.data.media_evidence.after_operation.status], ['AVAILABLE', 'AVAILABLE']);
  assert.equal(oldDefect.data.defects[0].length_mm, incomingDefect.data.defects[0].length_mm);
  assert.match(oldDefect.data.comparison.summary, /уже был/);
  assert.deepEqual([oldDefect.data.media_evidence.before_operation.status, oldDefect.data.media_evidence.after_operation.status], ['AVAILABLE', 'AVAILABLE']);
  assert.equal(lost.data.media_evidence.after_operation.absence_reason, 'LOST_IN_TRANSIT');
  assert.equal(lost.data.media_evidence.after_operation.url, null);
  assert.equal(lost.data.media_evidence.before_operation.status, 'AVAILABLE');
  assert.ok(Object.values(restricted.data.media_evidence).every(slot => slot.status === 'MISSING' && slot.absence_reason === 'CLASSIFIED_RESTRICTED'));
  assert.ok(restricted.data.defects[0].length_mm > 0);
  assert.equal(restricted.data.kd_spec.surface_zone_class, 'ZONE_A_CRITICAL');
  assert.equal(restricted.item_state.line_lock_status, 'HELD_AT_STATION');
  const mutated = structuredClone(domain.sourceDeliveries.find(row => row.message.event_id === lost.event_id));
  mutated.message.data.media_evidence.after_operation.status = 'AVAILABLE';
  assert.match(domain.validateDelivery(mutated), /слот изображения/);
});

test('A visible pre-existing mark is accepted twice without attributing it to the current machine', () => {
  domain.resetDemo();
  const incoming = domain.cases.find(row => row.item === 'ITEM-019');
  assert.equal(incoming.observations.length, 1);
  domain.performAction('ITEM-019', 'controller', 'accepted_within_spec', 'След виден до станка; учебный предел 3 мм соблюдён', 'QC-01', true, incoming.id);
  const after = domain.cases.find(row => row.item === 'ITEM-019');
  assert.equal(after.observations.length, 2);
  assert.equal(after.observations.at(-1).data.media_evidence.after_operation.status, 'AVAILABLE');
  assert.ok(!domain.eventsFor('ITEM-019').some(event => event.station_id === 'ST-ASSEMBLY'));
  domain.performAction('ITEM-019', 'controller', 'accepted_within_spec', 'Та же риска есть на входном кадре; нового повреждения после станка нет', 'QC-01', true, after.id);
  assert.equal(domain.eventsFor('ITEM-019').filter(event => event.event_type === 'quality_decision' && event.data.decision === 'accepted_within_spec').length, 2);
  assert.ok(domain.eventsFor('ITEM-019').some(event => event.station_id === 'ST-ASSEMBLY'));
  domain.resetDemo();
});

test('ITEM-013 moves across roles and release requires controller action', () => {
  domain.resetDemo();
  const initialDefects = domain.metrics('all').defects;
  domain.performAction('ITEM-013', 'controller', 'confirm', 'Риска подтверждена, удержать изделие', 'QC-01');
  assert.ok(domain.tasks.some(t => t.item === 'ITEM-013' && t.role === 'technologist'));
  assert.ok(domain.eventsFor('ITEM-013').some(e => e.data.operation_id === 'OP-REWORK'));
  domain.performAction('ITEM-013', 'master', 'master_complete', 'Доработку выполнил оператор OP-03', 'MASTER-01');
  assert.deepEqual(domain.mediaFor('ITEM-013').map(({ asset }) => asset.asset_id), ['M013-CV-BEFORE', 'M013-CV-DEFECT', 'M013-MASTER-CLEAR']);
  assert.notEqual(domain.productStatus('ITEM-013').tone, 'green');
  assert.throws(() => domain.performAction('ITEM-013', 'controller', 'release', 'Кадр после доработки проверен', 'QC-01'), /ручной замер/);
  domain.performAction('ITEM-013', 'controller', 'release', 'Ручной замер 5,12 мм; поверхность чистая', 'QC-01', true, undefined, { value: 5.12, instrumentId: 'GAGE-01', calibrationConfirmed: true });
  assert.equal(domain.productStatus('ITEM-013').tone, 'green');
  assert.ok(domain.eventsFor('ITEM-013').some(e => e.event_type === 'manual_measurement'));
  assert.equal(domain.metrics('all').defects, initialDefects + 1);
});

test('Missing CV frames never claim that a known camera was absent, and KD limits clear the missing list', () => {
  domain.resetDemo();
  const noCamera = domain.cases.find(row => row.item === 'ITEM-049');
  const observation = noCamera.observations.at(-1);
  assert.ok(observation.data.confidence > 0);
  assert.ok(observation.data.capture_context.camera_id);
  assert.match(controllerEvidence.missingFrameReason(observation), /Сбой передачи: медиа-пакет потерян/);
  const manual = structuredClone(observation);
  manual.data.method = 'manual_verification';
  manual.data.confidence = null;
  manual.data.capture_context = {};
  assert.match(controllerEvidence.missingFrameReason(manual), /На посту нет камеры/);
  const restricted = domain.cases.find(row => row.item === 'ITEM-021');
  assert.match(controllerEvidence.missingFrameReason(restricted.observations.at(-1)), /Кадр засекречен/);
  assert.ok(!controllerEvidence.controllerEvidenceFrom(noCamera, domain.eventsFor(noCamera.item), false).missing.includes('Допуск по КД для контролируемого размера'));
});

test('Registry projects 176 brackets and queue labels distinguish separate item operations', () => {
  domain.resetDemo();
  const registry = load('product-registry.ts');
  assert.equal(domain.items.filter(item => item.item_type_id === 'TYPE-BRACKET-01').length, 176);
  const item = domain.items.find(row => row.id === 'ITEM-013');
  const initial = registry.projectRegistryRow(item, domain.eventsFor(item.id));
  assert.equal(initial.lot, 'LOT-01');
  assert.equal(initial.traveler, 'TRAV-013');
  assert.equal(initial.group, 'needs');
  domain.performAction(item.id, 'controller', 'confirm', 'Подтверждённый дефект', 'QC-01');
  assert.equal(registry.projectRegistryRow(item, domain.eventsFor(item.id)).group, 'rework');
  domain.performAction(item.id, 'master', 'master_complete', 'Доработка завершена', 'MASTER-01');
  assert.equal(registry.projectRegistryRow(item, domain.eventsFor(item.id)).status, 'Доработка завершена');
  const first = domain.cases.find(row => row.item === 'ITEM-044');
  const second = { ...first, id: first.id + '-NEXT', observations: [{ ...first.observations[0], occurred_at: new Date(Date.parse(first.observations[0].occurred_at) + 60000).toISOString() }] };
  assert.deepEqual([first, second].map(row => controllerCase.queueItemLabel(row, [first, second])).sort(), ['ITEM-044-OP10', 'ITEM-044-OP20']);
  domain.resetDemo();
});

test('Workshop handoff removes a rework task and creates a repeat-inspection case', () => {
  domain.resetDemo();
  domain.prepareMasterShift();
  const inspection = load('inspection-case.ts');
  assert.ok(domain.tasks.filter(task => task.role === 'master' && task.event.data.disposition === 'rework').length >= 2);
  assert.equal(domain.tasks.filter(task => task.role === 'master' && task.event.data.disposition === 'hold').length, 2);
  assert.equal(inspection.inspectionCaseFrom(domain.cases.find(record => record.item === 'ITEM-013')).status, 'NEW_SIGNAL');
  const details = { method: 'Локальная зачистка заусенцев', operator: 'OP-03', durationMinutes: 18, actualSizeMm: 0.04, paperInspection: false };
  domain.performAction('ITEM-014', 'master', 'master_complete', 'Заусенец зачищен', 'MASTER-01', true, undefined, undefined, undefined, details);
  assert.ok(!domain.tasks.some(task => task.role === 'master' && task.item === 'ITEM-014'));
  const handoff = domain.eventsFor('ITEM-014').filter(event => event.event_type === 'master_action').at(-1);
  assert.equal(handoff.data.workflow_status, 'REVISION_READY');
  assert.equal(handoff.data.rework_method, details.method);
  assert.equal(handoff.data.duration_minutes, 18);
  assert.equal(handoff.data.actual_size_mm, 0.04);
  assert.equal(inspection.inspectionCaseFrom(domain.cases.find(record => record.item === 'ITEM-014')).status, 'REWORK_VERIFICATION');
  domain.resetDemo();
});

test('A controller can record a case-linked instrument reading without deciding the defect', () => {
  domain.resetDemo();
  const selected = domain.cases.find(row => row.item === 'ITEM-013' && row.type === 'SCRATCH');
  assert.ok(selected);
  assert.throws(() => domain.recordManualMeasurement('ITEM-013', selected.id, 'Толщина стенки', 5.12, 'GAGE-01', 'QC-01', false), /поверку/);
  const eventId = domain.recordManualMeasurement('ITEM-013', selected.id, 'Толщина стенки', 5.12, 'GAGE-01', 'QC-01', true);
  const recorded = domain.eventsFor('ITEM-013').find(row => row.event_id === eventId);
  assert.equal(recorded.event_type, 'manual_measurement');
  assert.equal(recorded.data.case_id, selected.id);
  assert.equal(recorded.data.measured_value, 5.12);
  assert.equal(recorded.data.instrument_id, 'GAGE-01');
  assert.ok(!domain.eventsFor('ITEM-013').some(row => row.event_type === 'quality_decision'));
  assert.ok(memory.get('orbita-qc-expanded-v2').includes(eventId));
  const incoming = domain.cases.find(row => row.item === 'ITEM-015' && row.region === 'CP-IN');
  const incomingId = domain.recordManualMeasurement('ITEM-015', incoming.id, 'Толщина стенки', 5.01, 'GAGE-02', 'QC-01', true);
  const incomingReading = domain.eventsFor('ITEM-015').find(row => row.event_id === incomingId);
  assert.equal(incomingReading.data.basis_event_ids[0], incoming.observations.at(-1).event_id);
  assert.equal(incomingReading.operation_run_id, undefined);
  domain.resetDemo();
});

test('Controller can confirm a defect while holding the item without scheduling rework', () => {
  domain.resetDemo();
  domain.performAction('ITEM-014', 'controller', 'confirm_hold', 'Заусенец подтверждён по кадру; требуется удержание', 'QC-01');
  const decision = domain.eventsFor('ITEM-014').filter(event => event.event_type === 'quality_decision').at(-1);
  assert.equal(decision.data.decision, 'confirmed');
  assert.equal(decision.data.disposition, 'hold');
  assert.ok(!domain.eventsFor('ITEM-014').some(event => event.data.operation_id === 'OP-REWORK'));
});

test('ITEM-014 retains one defect through unsuccessful and successful rework', () => {
  domain.resetDemo();
  domain.performAction('ITEM-014', 'controller', 'confirm', 'Заусенец подтверждён', 'QC-01');
  domain.performAction('ITEM-014', 'master', 'master_complete', 'Первый проход завершён', 'MASTER-01');
  assert.equal(domain.mediaFor('ITEM-014').at(-1).asset.asset_id, 'M014-MASTER-STILL');
  domain.performAction('ITEM-014', 'controller', 'recheck_fail', 'После первого прохода заусенец остался', 'QC-01');
  assert.notEqual(domain.productStatus('ITEM-014').tone, 'green');
  domain.performAction('ITEM-014', 'master', 'master_complete', 'Второй проход завершён', 'MASTER-01');
  domain.performAction('ITEM-014', 'controller', 'release', 'Кромка чистая после повторного контроля', 'QC-01');
  assert.equal(domain.productStatus('ITEM-014').tone, 'green');
  assert.equal(domain.cases.filter(c => c.item === 'ITEM-014').length, 1);
  assert.deepEqual(domain.mediaFor('ITEM-014').map(({ asset }) => asset.asset_id), ['M014-CV-BEFORE', 'M014-CV-BURR', 'M014-MASTER-STILL', 'M014-MASTER-CLEAR']);
});

test('ITEM-015 and ITEM-016 reveal photos only after checks; glare is not confirmed scrap', () => {
  domain.resetDemo();
  domain.performAction('ITEM-015', 'controller', 'additional', 'Нет кадра, нужна очная проверка', 'QC-01');
  assert.equal(domain.mediaFor('ITEM-015').length, 0);
  domain.performAction('ITEM-015', 'master', 'master_complete', 'Критическая кромка осмотрена и снята', 'MASTER-01');
  assert.equal(domain.mediaFor('ITEM-015').length, 1);
  assert.throws(() => domain.performAction('ITEM-015', 'controller', 'release', 'Осмотр завершён', 'QC-01'), /не является завершённой доработкой/);
  domain.performAction('ITEM-015', 'controller', 'confirm', 'Вмятина подтверждена по очному осмотру', 'QC-01');
  assert.equal(domain.cases.find(c => c.item === 'ITEM-015' && c.type === 'DENT').confirmed, true);
  domain.performAction('ITEM-015', 'controller', 'scrap', 'Контролёр подтверждает списание после проверки', 'QC-01');
  domain.performAction('ITEM-016', 'controller', 'additional', 'Блик требует проверки при другом свете', 'QC-01');
  domain.performAction('ITEM-016', 'master', 'master_complete', 'При рассеянном свете поверхность чистая', 'MASTER-01');
  assert.throws(() => domain.performAction('ITEM-016', 'controller', 'release', 'Поверхность чистая', 'QC-01'), /не является завершённой доработкой/);
  domain.performAction('ITEM-016', 'controller', 'reject', 'Признак не подтвердился', 'QC-01');
  assert.ok(domain.eventsFor('ITEM-016').some(e => e.data.method === 'manual_verification' && e.data.inspection_result === 'no_signs_detected'));
  assert.equal(domain.cases.find(c => c.item === 'ITEM-016').confirmed, false);
  assert.equal(domain.productStatus('ITEM-016').tone, 'green');
});

test('Browser storage survives role changes and reset removes human decisions', () => {
  domain.resetDemo();
  domain.performAction('ITEM-013', 'controller', 'confirm', 'Первичное подтверждение по кадру', 'QC-01');
  assert.ok(memory.get('orbita-qc-expanded-v2').includes('quality_decision'));
  assert.ok(domain.eventsFor('ITEM-013').some(e => e.event_type === 'quality_decision'));
  domain.resetDemo();
  assert.ok(!domain.eventsFor('ITEM-013').some(e => e.event_type === 'quality_decision'));
  assert.ok(!memory.get('orbita-qc-expanded-v2').includes('quality_decision'));
});

test('Late events, exact duplicates and invalid messages stay separate', () => {
  domain.resetDemo();
  const before = domain.events.length;
  const first = domain.nextStep();
  const second = domain.nextStep();
  assert.deepEqual([first.kind, second.kind], ['duplicate', 'late']);
  assert.equal(domain.events.length, before + 1);
  const own = domain.eventsFor('ITEM-018');
  assert.ok(own.findIndex(e => e.event_id === 'E2-000080') < own.findIndex(e => e.event_id === 'E2-000083'));
  const changed = JSON.parse(JSON.stringify(domain.deliveryFor('E2-000083')));
  changed.delivery_id = 'CONFLICT-TEST'; changed.message.data.inspection_result = 'no_signs_detected';
  const outcomes = domain.importText(JSON.stringify(changed));
  assert.equal(outcomes[0].kind, 'error');
  assert.equal(domain.events.length, before + 1);
  const source = fs.readFileSync(path.join(__dirname, '../src/domain.ts'), 'utf8');
  assert.ok(!source.includes('/expected/'));
});


test('Missing classified and lost frames require case-bound acknowledgement for confirmation and quarantine', () => {
  for (const item of ['ITEM-020', 'ITEM-021']) {
    for (const action of ['confirm_hold', 'confirm', 'quarantine']) {
      domain.resetDemo();
      const record = domain.cases.find(row => row.item === item);
      const observation = record.observations.at(-1);
      const args = [item, 'controller', action, 'Телеметрия и КД, документ QC-TEST', 'QC-TEST', false, record.id, undefined];
      assert.throws(() => domain.performAction(...args), /личную ответственность/);
      assert.throws(() => domain.performAction(...args, {observationEventId: 'stale-event', acknowledged: true}), /личную ответственность/);
      assert.equal(domain.eventsFor(item).filter(event => event.event_type === 'quality_decision').length, 0);
      domain.performAction(...args, {observationEventId: observation.event_id, acknowledged: true});
      const decision = domain.eventsFor(item).filter(event => event.event_type === 'quality_decision').at(-1);
      assert.equal(decision.data.disposition, action === 'confirm_hold' ? 'hold' : action === 'quarantine' ? 'quarantine' : 'rework');
      assert.equal(decision.data.missing_photo_acknowledgement.actor_id, 'QC-TEST');
      assert.equal(decision.data.missing_photo_acknowledgement.observation_event_id, observation.event_id);
      assert.equal(decision.data.missing_photo_acknowledgement.absence_reason, observation.data.media_evidence.after_operation.absence_reason);
      assert.equal(domain.eventsFor(item).filter(event => event.event_type === 'controller_check').length, 0);
    }
  }
});

test('Operation frame projection preserves absent slots, individual hashes and checkpoint metadata', () => {
  domain.resetDemo();
  const inspection = load('inspection-case.ts');
  const beforeAndAfter = inspection.inspectionCaseFrom(domain.cases.find(row => row.item === 'ITEM-013'));
  assert.ok(beforeAndAfter.visualEvidence.before.url);
  assert.ok(beforeAndAfter.visualEvidence.after.url);
  assert.notEqual(beforeAndAfter.visualEvidence.before.hash, beforeAndAfter.visualEvidence.after.hash);
  assert.equal(beforeAndAfter.visualEvidence.before.checkpoint, 'CP-IN');
  assert.ok(Date.parse(beforeAndAfter.visualEvidence.before.capturedAt) < Date.parse(beforeAndAfter.visualEvidence.after.capturedAt));
  const lost = inspection.inspectionCaseFrom(domain.cases.find(row => row.item === 'ITEM-020'));
  assert.ok(lost.visualEvidence.before.url);
  assert.equal(lost.visualEvidence.after.url, undefined);
  assert.equal(lost.visualEvidence.after.absenceReason, 'LOST_IN_TRANSIT');
  const restricted = inspection.inspectionCaseFrom(domain.cases.find(row => row.item === 'ITEM-021'));
  assert.equal(restricted.visualEvidence.before.url, undefined);
  assert.equal(restricted.visualEvidence.after.url, undefined);
  assert.equal(restricted.visualEvidence.before.absenceReason, 'CLASSIFIED_RESTRICTED');
  assert.equal(restricted.visualEvidence.after.absenceReason, 'CLASSIFIED_RESTRICTED');
  const conflicting = structuredClone(domain.cases.find(row => row.item === 'ITEM-013'));
  conflicting.observations.at(-1).data.media_evidence.after_operation.status = 'MISSING';
  const projected = inspection.inspectionCaseFrom(conflicting);
  assert.equal(projected.visualEvidence.hasImage, false);
  assert.equal(projected.visualEvidence.currentImageUrl, undefined);
});
