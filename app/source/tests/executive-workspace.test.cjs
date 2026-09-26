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
  const code = ts.transpileModule(input, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX }, fileName: filename }).outputText;
  const instance = new Module(filename.replace(/\.ts$/, '.cjs'), module);
  instance.filename = filename.replace(/\.ts$/, '.cjs');
  instance.paths = Module._nodeModulePaths(path.dirname(filename));
  instance._compile(code, instance.filename);
  return instance.exports;
}
Module._extensions['.ts'] = (instance, filename) => { const input = fs.readFileSync(filename, 'utf8').replaceAll('import.meta.env.BASE_URL', "'/'"); instance._compile(ts.transpileModule(input, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX }, fileName: filename }).outputText, filename); };
Module._extensions['.tsx'] = Module._extensions['.ts'];
const domain = load('domain.ts');
const nav = load('navigation.ts');
const controllerCase = load('controller-case.ts');
const controllerEvidence = load('controller-evidence.ts');
const manager = load('managerMockData.ts');
const managerDecisions = load('manager-decisions.ts');

test('Executive snapshot reconciles quantities, origins, Pareto, recurrence and fleet losses', () => {
  const snapshot = manager.managerSnapshot;
  assert.equal(snapshot.firstPass + snapshot.reworked + snapshot.finalScrap, snapshot.checked);
  assert.equal(snapshot.released + snapshot.quarantine + snapshot.inProgress + snapshot.finalScrap, snapshot.checked);
  assert.equal(manager.executiveKpis.ftr, 92.4);
  assert.ok(Math.abs(manager.executiveKpis.finalScrap - 1.1) < 1e-9);
  assert.ok(Math.abs(manager.executiveKpis.fleetAvailability - 89.2) < 1e-9);
  assert.equal(manager.executiveKpis.programCompletion, 94.8);
  const count = origin => manager.paretoFor(origin).reduce((sum, row) => sum + row.count, 0);
  assert.equal(count('all'), 100);
  assert.equal(count('incoming'), 38);
  assert.equal(count('production'), 62);
  for (const origin of ['all', 'incoming', 'production']) {
    const pareto = manager.paretoFor(origin);
    assert.equal(pareto.at(-1).cumulative, 100);
    assert.ok(pareto.every((row, index) => index === 0 || pareto[index - 1].count >= row.count));
  }
  const burrs = manager.paretoFor('all').find(row => row.id === 'burr').count;
  assert.equal(manager.recurrenceRows.find(row => row.equipment === 'EQ-CNC-01' && row.shift === '2-я').counts.burr / burrs, 0.75);
  assert.equal(manager.productionAreas.reduce((sum, row) => sum + row.lossHours, 0), snapshot.reworkHours);
  assert.equal(manager.operationDurations.reduce((sum, row) => sum + row.repeatedRuns, 0), snapshot.reworked);
  const repairs = manager.equipmentFleet.reduce((sum, row) => sum + row.repairHours, 0);
  assert.ok(Math.abs(repairs - manager.timeLosses.find(row => row.label === 'Аварийный ремонт').hours) < 1e-9);
  assert.equal(nav.parseRoute('#/leader/executive/equipment').section, 'analytics');
  assert.equal(nav.parseRoute('#/leader/home/actions').section, 'actions');
  assert.equal(nav.parseRoute('#/controller/executive/actions').module, 'home');
  assert.deepEqual(nav.roleById.leader.primary, ['executive', 'products']);
  assert.deepEqual(nav.roleById.leader.secondary, []);
  assert.deepEqual(nav.sectionsFor('leader', 'executive').map(row => row.id), ['analytics', 'balance', 'personnel', 'actions', 'reports']);
  for (const module of ['tasks', 'analytics', 'forecast']) {
    assert.equal(nav.canAccess('leader', module), false);
    assert.equal(nav.parseRoute(`#/leader/${module}`).module, 'executive');
  }
});

test('Director repair cohort conserves item counts and carrying values; MTTR excludes unfinished repair', () => {
  const balance = manager.repairBalance;
  assert.equal(balance.found, balance.repairable + balance.isolated);
  assert.equal(balance.repairable, balance.restored + balance.inProgress);
  assert.equal(balance.foundValue, balance.repairableValue + balance.isolatedValue);
  assert.equal(balance.repairableValue, balance.restoredValue + balance.inProgressValue);
  assert.equal(balance.completedMinutes.length, balance.restored);
  assert.equal(balance.completedMinutes.reduce((sum, row) => sum + row, 0) / balance.restored, 42);
});

test('Every report template uses the selected period and order; monthly quality reconciles with director KPIs', () => {
  const reports = load('executive-reports.ts');
  for (const template of ['quality', 'claim', 'time']) {
    for (const period of ['shift', 'decade', 'month']) {
      const all = reports.buildExecutiveReport(template, period, 'all');
      const a = reports.buildExecutiveReport(template, period, 'WO-A');
      const b = reports.buildExecutiveReport(template, period, 'WO-B');
      assert.equal(all.rows.length, 2);
      assert.equal(a.rows.length, 1);
      assert.equal(b.rows.length, 1);
      for (const key of ['checked', 'good', 'scrap', 'pending', 'plannedHours', 'forgingRejected']) {
        assert.equal(all.rows.reduce((sum, row) => sum + row[key], 0), a.rows[0][key] + b.rows[0][key]);
      }
      for (const row of all.rows) {
        assert.equal(row.checked, row.good + row.scrap + row.pending);
        assert.ok(row.plannedHours >= row.qcHours + row.setupHours + row.repairHours);
        assert.ok(row.forgingRejected <= row.forgingChecked);
      }
    }
  }
  const month = reports.buildExecutiveReport('quality', 'month', 'all');
  assert.equal(month.rows.reduce((sum, row) => sum + row.good, 0), manager.managerSnapshot.released);
  assert.equal(month.rows.reduce((sum, row) => sum + row.scrap, 0), manager.managerSnapshot.finalScrap);
  const shift = reports.buildExecutiveReport('quality', 'shift', 'all');
  assert.equal(shift.rows.reduce((sum, row) => sum + row.good, 0), manager.shiftAudit[0].output);
  assert.notDeepEqual(month.rows, shift.rows);
  assert.throws(() => reports.buildExecutiveReport('unknown', 'month', 'all'));
});

test('Demo electronic signatures verify reports and persistent visas and reject altered content', async () => {
  const signature = load('executive-signature.ts');
  const reports = load('executive-reports.ts');
  const signed = await reports.createSignedExecutiveReport('quality', 'month', 'WO-B');
  assert.equal(await signature.verifyExecutivePayload(signed.document, signed.signature), true);
  assert.equal(await signature.verifyExecutivePayload({ ...signed.document, order: 'WO-A' }, signed.signature), false);
  assert.equal(await signature.verifyExecutivePayload(signed.document, { ...signed.signature, value: '00'.repeat(64) }), false);
  const key = 'orbita-executive-approvals-v1';
  memory.delete(key);
  const before = JSON.stringify(domain.events);
  const rows = await managerDecisions.signExecutiveAction('claim-004', 'leader');
  assert.equal(await managerDecisions.verifyExecutiveApproval(rows[0]), true);
  const persisted = load('manager-decisions.ts').readExecutiveApprovals();
  assert.equal(await managerDecisions.verifyExecutiveApproval(persisted[0]), true);
  assert.deepEqual(await managerDecisions.signExecutiveAction('claim-004', 'leader'), rows);
  assert.equal(JSON.stringify(domain.events), before);
  assert.equal(await managerDecisions.verifyExecutiveApproval({ ...rows[0], basis: 'Altered basis' }), false);
  await assert.rejects(managerDecisions.signExecutiveAction('spindle-01', 'controller'));
  memory.delete(key);
  const legacy = managerDecisions.approveExecutiveAction('rework-007', 'leader')[0];
  const upgraded = (await managerDecisions.signExecutiveAction('rework-007', 'leader'))[0];
  assert.equal(upgraded.approvedAt, legacy.approvedAt);
  assert.equal(await managerDecisions.verifyExecutiveApproval(upgraded), true);
  memory.delete(key);
});

test('Executive visas persist idempotently with audit and queued delivery; never alter QC events', () => {
  const before = JSON.stringify(domain.events);
  assert.throws(() => managerDecisions.approveExecutiveAction('claim-004', 'controller'));
  assert.throws(() => managerDecisions.approveExecutiveAction('missing', 'leader'));
  const first = managerDecisions.approveExecutiveAction('claim-004', 'leader');
  const twice = managerDecisions.approveExecutiveAction('claim-004', 'leader');
  assert.deepEqual(twice, first);
  assert.equal(first.length, 1);
  assert.equal(first[0].delivery, 'queued');
  assert.equal(first[0].target, '1С:ERP');
  assert.equal(first[0].snapshotId, manager.managerSnapshot.id);
  assert.deepEqual(load('manager-decisions.ts').readExecutiveApprovals(), first);
  assert.equal(JSON.stringify(domain.events), before);
  const key = 'orbita-executive-approvals-v1';
  memory.set(key, '{broken');
  assert.throws(() => managerDecisions.approveExecutiveAction('spindle-01', 'leader'));
  assert.equal(memory.get(key), '{broken');
  memory.delete(key);
  const originalWrite = global.localStorage.setItem;
  global.localStorage.setItem = () => { throw new Error('Quota exceeded'); };
  try { assert.throws(() => managerDecisions.approveExecutiveAction('rework-007', 'leader'), /Quota/); }
  finally { global.localStorage.setItem = originalWrite; }
  assert.deepEqual(managerDecisions.readExecutiveApprovals(), []);
});


test('Each director report renders only its own table and preserves the selected order', async () => {
  const React = require('react');
  const {renderToStaticMarkup} = require('react-dom/server');
  const {ReportForm} = load('executive-report-view.tsx');
  const reports = load('executive-reports.ts');
  for (const template of ['quality', 'claim', 'time']) {
    for (const order of ['all', 'WO-A', 'WO-B']) {
      const signed = await reports.createSignedExecutiveReport(template, 'month', order);
      const html = renderToStaticMarkup(React.createElement(ReportForm, {report: signed}));
      assert.equal((html.match(/<table>/g) || []).length, 1);
      assert.equal(html.includes('Сводные результаты контроля качества'), template === 'quality');
      assert.equal(html.includes('Осмотрено поковок'), template === 'claim');
      assert.equal(html.includes('Доступный фонд'), template === 'time');
      assert.equal(html.includes('<td>WO-A</td>'), order !== 'WO-B');
      assert.equal(html.includes('<td>WO-B</td>'), order !== 'WO-A');
      if (template === 'time' && order === 'all') assert.ok(html.includes('<td>48</td>'));
    }
  }
});
