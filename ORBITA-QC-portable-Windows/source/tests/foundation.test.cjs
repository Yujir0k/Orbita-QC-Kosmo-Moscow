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
  instance._compile(code, instance.filename);
  return instance.exports;
}
const domain = load('domain.ts');
const nav = load('navigation.ts');
const controllerCase = load('controller-case.ts');

test('Routes remain role-specific and all modules belong to a role', () => {
  for (const workspace of nav.workspaces) assert.ok(nav.roles.some(role => nav.canAccess(role.id, workspace.id)), workspace.id);
  assert.equal(nav.parseRoute('#/controller/security/crypto').module, 'quality');
  assert.equal(nav.parseRoute('').module, 'quality');
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

test('The expanded demo starts before human decisions and future work', () => {
  domain.resetDemo();
  assert.equal(domain.items.length, 180);
  assert.ok(domain.events.some(e => e.item_id === 'ITEM-013' && e.data.inspection_result === 'signs_detected'));
  assert.ok(!domain.events.some(e => e.item_id === 'ITEM-013' && e.event_type === 'operation_started' && e.data.operation_id === 'OP-REWORK'));
  assert.ok(!domain.events.some(e => ['quality_decision', 'master_action', 'technical_disposition'].includes(e.event_type)));
  assert.equal(domain.mediaFor('ITEM-015').length, 0);
  assert.ok(domain.tasks.some(t => t.item === 'ITEM-015' && t.role === 'controller'));
  assert.equal(domain.metrics('all').defects, 0);
});

test('ITEM-013 moves across roles and release requires controller action', () => {
  domain.resetDemo();
  domain.performAction('ITEM-013', 'controller', 'confirm', 'Риска подтверждена, удержать изделие', 'QC-01');
  assert.ok(domain.tasks.some(t => t.item === 'ITEM-013' && t.role === 'technologist'));
  assert.ok(!domain.eventsFor('ITEM-013').some(e => e.data.operation_id === 'OP-REWORK'));
  domain.performAction('ITEM-013', 'technologist', 'tech_allow', 'Ограниченная доработка допустима при замере толщины', 'TECH-01');
  assert.ok(domain.eventsFor('ITEM-013').some(e => e.data.operation_id === 'OP-REWORK'));
  domain.performAction('ITEM-013', 'master', 'master_complete', 'Доработку выполнил оператор OP-03', 'MASTER-01');
  assert.equal(domain.mediaFor('ITEM-013').length, 2);
  assert.notEqual(domain.productStatus('ITEM-013').tone, 'green');
  assert.throws(() => domain.performAction('ITEM-013', 'controller', 'release', 'Кадр после доработки проверен', 'QC-01'), /ручной замер/);
  domain.performAction('ITEM-013', 'controller', 'release', 'Ручной замер 5,12 мм; поверхность чистая', 'QC-01', true, undefined, { value: 5.12, instrumentId: 'GAGE-01', calibrationConfirmed: true });
  assert.equal(domain.productStatus('ITEM-013').tone, 'green');
  assert.ok(domain.eventsFor('ITEM-013').some(e => e.event_type === 'manual_measurement'));
  assert.equal(domain.metrics('all').defects, 1);
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
  assert.deepEqual(domain.mediaFor('ITEM-014').map(({ asset }) => asset.asset_id), ['M014-CV-BURR', 'M014-MASTER-STILL', 'M014-MASTER-CLEAR']);
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
  domain.performAction('ITEM-015', 'technologist', 'tech_deny', 'Маршрут не допускает восстановление', 'TECH-01');
  domain.performAction('ITEM-015', 'controller', 'scrap', 'Списание после заключения технолога', 'QC-01');
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
