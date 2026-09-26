import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSecurity } from '../../security.mjs'
import { createContractRegistry } from '../../contract-validator.mjs'

const temp = await mkdtemp(path.join(tmpdir(), 'orbita-security-'))
after(() => rm(temp, { recursive: true, force: true }))
const rootKey = randomBytes(32)
const contracts = await createContractRegistry(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'))
const security = await createSecurity({ directory: temp, rootKey, items: [{ id: 'ITEM-1', item_type_id: 'TYPE-1' }], itemLineMap: { 'ITEM-1': 'LINE-1' },
  contracts,
  users: [{ id: 'qc', role: 'controller', lineIds: ['LINE-1'], password: 'correct-controller-password' },
    { id: 'master', role: 'master', lineIds: ['LINE-2'], password: 'correct-master-password' },
    { id: 'master-line1', role: 'master', lineIds: ['LINE-1'], password: 'correct-master-line1-password' },
    { id: 'tech', role: 'technologist', lineIds: ['LINE-1'], password: 'correct-technologist-password' },
    { id: 'admin', role: 'administrator', lineIds: ['LINE-1'], password: 'correct-admin-password' }] })
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname
  if (await security.handle(request, response, pathname)) return
  if (!await security.guard(request, response, pathname)) return
  response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"reached"}')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
after(() => new Promise(resolve => server.close(resolve)))
const base = `http://127.0.0.1:${server.address().port}`
const request = async (route, { cookie, csrf, method = 'GET', body, origin } = {}) => {
  const response = await fetch(base + route, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(origin ? { Origin: origin } : {}) }, body: body && JSON.stringify(body) })
  return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], body: await response.json() }
}
const login = async (id, password) => {
  const result = await request('/api/security/login', { method: 'POST', body: { id, password } })
  return { ...result, csrf: result.body.csrfToken }
}

test('security bus authenticates, checks CSRF, role and item scope before mutations', async () => {
  assert.equal((await request('/api/integrations/state')).status, 401)
  assert.equal((await request('/api/security/demo-session', { method: 'POST', body: { role: 'administrator' } })).status, 404)
  assert.equal((await request('/api/security/login', { method: 'POST', body: { id: 'qc', password: 'correct-controller-password', role: 'administrator' } })).status, 422)
  assert.equal((await login('qc', 'wrong')).status, 401)
  const qc = await login('qc', 'correct-controller-password')
  assert.equal(qc.status, 200)
  assert.match(qc.cookie, /^orbita_session=/)
  assert.equal((await request('/api/integrations/state', { cookie: qc.cookie })).status, 403)
  assert.equal((await request('/api/mobile/state', { cookie: qc.cookie })).status, 403)
  assert.equal((await request('/api/mobile/events', { cookie: qc.cookie })).status, 200)
  assert.equal((await request('/api/plant/mes/decisions', { method: 'POST', cookie: qc.cookie, body: {} })).status, 403)
  assert.equal((await request('/api/plant/mes/decisions', { method: 'POST', cookie: qc.cookie, csrf: qc.csrf, origin: 'http://evil.example', body: {} })).status, 403)
  const denied = await request('/api/security/actions', { method: 'POST', cookie: qc.cookie, csrf: qc.csrf, body: { itemId: 'ITEM-1', action: 'master_complete', reason: 'Нужна проверка исполнителя' } })
  assert.equal(denied.status, 403)
  const master = await login('master', 'correct-master-password')
  assert.equal((await request('/api/security/actions', { method: 'POST', cookie: master.cookie, csrf: master.csrf, body: { itemId: 'ITEM-1', action: 'master_complete', reason: 'Работа на линии завершена' } })).status, 403)
  const admin = await login('admin', 'correct-admin-password')
  assert.equal((await request('/api/integrations/state', { cookie: admin.cookie })).status, 200)
  assert.equal((await request('/api/contracts', { cookie: admin.cookie })).status, 200)
  assert.equal((await request('/api/contracts', { cookie: qc.cookie })).status, 403)
  assert.equal((await request('/api/security/audit', { cookie: qc.cookie })).status, 403)
})

test('a controller action is attributed by the server and its original is encrypted and append-only', async () => {
  const qc = await login('qc', 'correct-controller-password')
  const approval = await request('/api/security/actions', { method: 'POST', cookie: qc.cookie, csrf: qc.csrf,
    body: { itemId: 'ITEM-1', action: 'confirm', reason: 'Вмятина подтверждена по измерению' } })
  assert.equal(approval.status, 200)
  assert.equal(approval.body.actorId, 'qc')
  const actionId = approval.body.actionId
  const event = { event_id: `UI-${actionId}-1`, event_type: 'quality_decision', schema_version: '2.0', occurred_at: new Date().toISOString(), source_id: 'ORBITA-UI', actor_id: 'qc', item_id: 'ITEM-1', item_type_id: 'TYPE-1', line_id: 'LINE-1', station_id: 'ST-1', shift_id: 'SHIFT-1', item_state: { physical_location: 'ST-1: зона удержания ОТК', line_lock_status: 'HELD_AT_STATION' }, data: { decision: 'confirmed', disposition: 'rework', finding_refs: [], reason: 'Вмятина подтверждена по измерению', security_action_id: actionId } }
  const delivery = message => ({ delivery_id: 'UI-DLV-1', deliver_at: new Date().toISOString(), message })
  const forged = await request('/api/security/actions/complete', { method: 'POST', cookie: qc.cookie, csrf: qc.csrf,
    body: { actionId, deliveries: [delivery({ ...event, actor_id: 'someone-else' })] } })
  assert.equal(forged.status, 422)
  assert.equal((await request('/api/security/actions/complete', { method: 'POST', cookie: qc.cookie, csrf: qc.csrf,
    body: { actionId, deliveries: [delivery({ ...event, data: { ...event.data, disposition: 'release' } })] } })).status, 422)
  assert.equal((await request('/api/security/actions/complete', { method: 'POST', cookie: qc.cookie, csrf: qc.csrf,
    body: { actionId, deliveries: [delivery({ ...event, data: { ...event.data, reason: 'Подменённое основание' } })] } })).status, 422)
  assert.equal((await request('/api/security/actions/complete', { method: 'POST', cookie: qc.cookie, csrf: qc.csrf,
    body: { actionId, deliveries: [delivery(event), delivery({ ...event, event_id: `UI-${actionId}-2` })] } })).status, 409)
  const complete = await request('/api/security/actions/complete', { method: 'POST', cookie: qc.cookie, csrf: qc.csrf,
    body: { actionId, deliveries: [delivery(event)] } })
  assert.equal(complete.status, 200)
  assert.equal((await request('/api/security/actions/complete', { method: 'POST', cookie: qc.cookie, csrf: qc.csrf,
    body: { actionId, deliveries: [delivery(event)] } })).status, 409)
  const history = await request('/api/security/events', { cookie: qc.cookie })
  assert.equal(history.body.deliveries.length, 1)
  const auditFile = path.join(temp, 'data', 'security', 'audit.jsonl')
  const raw = await readFile(auditFile, 'utf8')
  assert.ok(!raw.includes('Вмятина подтверждена'))
  const admin = await login('admin', 'correct-admin-password')
  assert.equal((await request('/api/security/verify', { cookie: admin.cookie })).body.valid, true)
  assert.equal(security.validateMesDecision(event), true)
  assert.equal(security.validateMesDecision({ ...event, line_id: 'OTHER-LINE' }), false)
})

test('quarantine decision is approved and audited with its exact disposition', async () => {
  const qc = await login('qc', 'correct-controller-password')
  const reason = 'Дефект подтверждён; изделие направлено в карантин'
  const approval = await request('/api/security/actions', { method: 'POST', cookie: qc.cookie, csrf: qc.csrf,
    body: { itemId: 'ITEM-1', action: 'quarantine', reason } })
  assert.equal(approval.status, 200)
  const event = { event_id: `UI-${approval.body.actionId}-1`, event_type: 'quality_decision', schema_version: '2.0',
    occurred_at: new Date().toISOString(), source_id: 'ORBITA-UI', actor_id: 'qc', item_id: 'ITEM-1',
    item_type_id: 'TYPE-1', line_id: 'LINE-1', station_id: 'ST-1', shift_id: 'SHIFT-1',
    item_state: { physical_location: 'ST-1: зона удержания ОТК', line_lock_status: 'HELD_AT_STATION' },
    data: { decision: 'confirmed', disposition: 'quarantine', finding_refs: [], reason, security_action_id: approval.body.actionId } }
  const completed = await request('/api/security/actions/complete', { method: 'POST', cookie: qc.cookie, csrf: qc.csrf,
    body: { actionId: approval.body.actionId, deliveries: [{ delivery_id: `UI-DLV-${randomUUID()}`, deliver_at: new Date().toISOString(), message: event }] } })
  assert.equal(completed.status, 200)
  assert.equal(security.validateMesDecision(event), true)
})

test('technologist requests and conclusions and a master report persist in the audited history', async () => {
  const tech = await login('tech', 'correct-technologist-password')
  const master = await login('master-line1', 'correct-master-line1-password')
  const caseId = 'NC-ITEM-1-BURR-EDGE'
  const sendAction = async (session, action, reason, data, extra = {}) => {
    const approval = await request('/api/security/actions', { method: 'POST', cookie: session.cookie, csrf: session.csrf,
      body: { itemId: 'ITEM-1', action, caseId, reason, ...extra } })
    assert.equal(approval.status, 200)
    const actionId = approval.body.actionId
    const event = { event_id: `UI-${actionId}-1`, event_type: action === 'cause_review_detailed' ? 'cause_review' : action,
      schema_version: '2.0', occurred_at: new Date().toISOString(), source_id: 'ORBITA-UI', actor_id: approval.body.actorId,
      item_id: 'ITEM-1', item_type_id: 'TYPE-1', line_id: 'LINE-1', station_id: 'ST-1', shift_id: 'SHIFT-1',
      data: { ...data, case_id: caseId, reason, security_action_id: actionId } }
    const completedAction = await request('/api/security/actions/complete', { method: 'POST', cookie: session.cookie, csrf: session.csrf,
      body: { actionId, deliveries: [{ delivery_id: `UI-DLV-${randomUUID()}`, deliver_at: new Date().toISOString(), message: event }] } })
    assert.equal(completedAction.status, 200, JSON.stringify(completedAction.body))
    return event
  }
  assert.equal((await request('/api/security/actions', { method: 'POST', cookie: master.cookie, csrf: master.csrf,
    body: { itemId: 'ITEM-1', action: 'evidence_request', caseId, reason: 'Проверьте состояние оснастки', recipient: 'master' } })).status, 403)
  const inquiry = await sendAction(tech, 'evidence_request', 'Проверьте состояние оснастки',
    { recipient_role: 'master', status: 'open', finding_refs: ['FIND-1'] }, { recipient: 'master' })
  await sendAction(master, 'master_process_report', 'Оснастка проверена, отклонений не выявлено',
    { request_id: inquiry.event_id, fixture_condition: 'checked', tool_condition: 'unknown', setup_changed: 'no',
      comment: 'Оснастка проверена, отклонений не выявлено', basis_event_ids: ['EVENT-1'] })
  await sendAction(tech, 'cause_review_detailed', 'Причина требует повторной проверки данных',
    { status: 'hypothesis', cause_type: 'undetermined', finding_refs: ['FIND-1'], basis_event_ids: ['EVENT-1'],
      alternatives: 'Вероятен входной дефект', missing_data: 'Нужна проверка инструмента', reviewed_event_ids: ['EVENT-1'] })
  const history = await request('/api/security/events', { cookie: tech.cookie })
  assert.equal(history.status, 200)
  assert.ok(history.body.deliveries.some(row => row.message.event_id === inquiry.event_id))
})

test('local demonstration switches roles without account credentials', async () => {
  const demoDirectory = await mkdtemp(path.join(tmpdir(), 'orbita-demo-role-'))
  const demoSecurity = await createSecurity({ directory: demoDirectory, rootKey: randomBytes(32), items: [{ id: 'ITEM-1', item_type_id: 'TYPE-1' }], itemLineMap: { 'ITEM-1': 'LINE-1' }, contracts })
  const demoServer = createServer((incoming, outgoing) => {
    void demoSecurity.handle(incoming, outgoing, new URL(incoming.url, 'http://127.0.0.1').pathname)
  })
  await new Promise(resolve => demoServer.listen(0, '127.0.0.1', resolve))
  try {
    const demoBase = `http://127.0.0.1:${demoServer.address().port}`
    const select = async (role, cookie, origin) => {
      const response = await fetch(`${demoBase}/api/security/demo-session`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ role }) })
      return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
    }
    assert.equal((await select('master', null, 'http://evil.example')).status, 403)
    assert.equal((await select('unknown')).status, 422)
    const controller = await select('controller')
    assert.equal(controller.status, 200)
    assert.equal(controller.body.user.id, 'controller-01')
    const master = await select('master', controller.cookie)
    assert.equal(master.status, 200)
    assert.equal(master.body.user.id, 'master-01')
    const oldSession = await fetch(`${demoBase}/api/security/session`, { headers: { Cookie: controller.cookie } }).then(response => response.json())
    assert.equal(oldSession.authenticated, false)
  } finally {
    await new Promise(resolve => demoServer.close(resolve))
    await rm(demoDirectory, { recursive: true, force: true })
  }
})

test('workcenter rework and independent measurements require exact server approval', async () => {
  const master = await login('master-line1', 'correct-master-line1-password')
  const details = { method: 'Локальная зачистка', operator: 'OP-03', durationMinutes: 18, actualSizeMm: 0.04, paperInspection: false }
  const reason = 'Локальная зачистка; исполнитель OP-03; 18 мин; фактический размер 0.04 мм.'
  const approved = await request('/api/security/actions', { method: 'POST', cookie: master.cookie, csrf: master.csrf,
    body: { itemId: 'ITEM-1', action: 'master_complete', reason, includePhoto: true, masterDetails: details } })
  assert.equal(approved.status, 200)
  const actionId = approved.body.actionId
  const event = { event_id: `UI-${actionId}-1`, event_type: 'master_action', schema_version: '2.0', occurred_at: new Date().toISOString(),
    source_id: 'ORBITA-UI', actor_id: 'master-line1', item_id: 'ITEM-1', item_type_id: 'TYPE-1', line_id: 'LINE-1', station_id: 'ST-1', shift_id: 'SHIFT-1',
    item_state: { physical_location: 'ST-1: межоперационный буфер', line_lock_status: 'IN_BUFFER' },
    data: { security_action_id: actionId, action_type: 'rework_completed', workflow_status: 'REVISION_READY', evidence_refs: ['M013-MASTER-CLEAR'],
      observation_quality: 'good', executor_id: 'OP-03', rework_method: details.method, duration_minutes: 18, actual_size_mm: 0.04,
      paper_inspection: false, comment: reason, reason } }
  const delivery = message => ({ delivery_id: `UI-DLV-${randomUUID()}`, deliver_at: new Date().toISOString(), message })
  const wrong = await request('/api/security/actions/complete', { method: 'POST', cookie: master.cookie, csrf: master.csrf,
    body: { actionId, deliveries: [delivery({ ...event, data: { ...event.data, rework_method: 'Подменённая операция' } })] } })
  assert.equal(wrong.status, 422)
  const complete = await request('/api/security/actions/complete', { method: 'POST', cookie: master.cookie, csrf: master.csrf,
    body: { actionId, deliveries: [delivery(event)] } })
  assert.equal(complete.status, 200)

  const inspectionDetails = { ...details, method: 'Очный осмотр', actualSizeMm: 0, inspectionResult: 'signs_detected', inspectionNote: 'На кромке виден заусенец' }
  const inspectionReason = 'Очный осмотр: на кромке виден заусенец; исполнитель OP-03.'
  const inspectionApproval = await request('/api/security/actions', { method: 'POST', cookie: master.cookie, csrf: master.csrf,
    body: { itemId: 'ITEM-1', action: 'master_complete', reason: inspectionReason, includePhoto: true, masterDetails: inspectionDetails } })
  assert.equal(inspectionApproval.status, 200)
  const inspectionEvent = { ...event, event_id: `UI-${inspectionApproval.body.actionId}-1`,
    data: { ...event.data, security_action_id: inspectionApproval.body.actionId, action_type: 'inspection_support',
      rework_method: inspectionDetails.method, actual_size_mm: 0, inspection_result: 'signs_detected',
      inspection_note: inspectionDetails.inspectionNote, comment: inspectionReason, reason: inspectionReason } }
  assert.equal((await request('/api/security/actions/complete', { method: 'POST', cookie: master.cookie, csrf: master.csrf,
    body: { actionId: inspectionApproval.body.actionId, deliveries: [delivery(inspectionEvent)] } })).status, 200)

  const qc = await login('qc', 'correct-controller-password')
  const checkReason = 'Очный осмотр подтвердил царапину'
  const check = await request('/api/security/actions', { method: 'POST', cookie: qc.cookie, csrf: qc.csrf,
    body: { itemId: 'ITEM-1', action: 'controller_check', caseId: 'CASE-1', checkResult: 'signs_detected', reason: checkReason } })
  assert.equal(check.status, 422)

  const reading = { parameter: 'Толщина стенки', value: 5.12, instrumentId: 'GAGE-01', calibrated: true }
  const measurement = await request('/api/security/actions', { method: 'POST', cookie: qc.cookie, csrf: qc.csrf,
    body: { itemId: 'ITEM-1', action: 'manual_measurement', caseId: 'CASE-1', reason: 'Замер толщины стенки прибором', measurement: reading } })
  assert.equal(measurement.status, 200)
  const measurementEvent = { ...event, item_state: undefined, event_id: `UI-${measurement.body.actionId}-1`, event_type: 'manual_measurement', actor_id: 'qc',
    operation_run_id: 'RUN-1', data: { security_action_id: measurement.body.actionId, case_id: 'CASE-1', basis_event_ids: ['OBS-1'],
      feature_id: reading.parameter, measured_value: reading.value, unit: 'mm', instrument_id: reading.instrumentId,
      calibration_status: 'operator_confirmed', is_camera_measurement: false } }
  assert.equal((await request('/api/security/actions/complete', { method: 'POST', cookie: qc.cookie, csrf: qc.csrf,
    body: { actionId: measurement.body.actionId, deliveries: [delivery(measurementEvent)] } })).status, 200)
})

test('login throttling and administrator session revocation are enforced by the server', async () => {
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await login('unknown-user', 'wrong-password')).status, 401)
  assert.equal((await login('unknown-user', 'wrong-password')).status, 429)
  const current = await login('admin', 'correct-admin-password')
  const before = await request('/api/security/sessions', { cookie: current.cookie })
  const secondary = await login('admin', 'correct-admin-password')
  const list = await request('/api/security/sessions', { cookie: current.cookie })
  assert.equal(list.status, 200)
  const known = new Set(before.body.sessions.map(row => row.id))
  const target = list.body.sessions.find(row => !known.has(row.id))
  assert.ok(target)
  const revoked = await request('/api/security/sessions/revoke', { method: 'POST', cookie: current.cookie, csrf: current.csrf, body: { sessionId: target.id } })
  assert.equal(revoked.status, 200)
  assert.equal((await request('/api/security/session', { cookie: secondary.cookie })).body.authenticated, false)
})

test('legacy runtime state migrates to authenticated encryption; changed audit records and truncation are detected', async () => {
  const stateFile = path.join(temp, 'integration-state.json')
  await writeFile(stateFile, JSON.stringify({ secret: 'original production event' }))
  assert.deepEqual(await security.store.readJson(stateFile), { secret: 'original production event' })
  assert.ok(!(await readFile(stateFile, 'utf8')).includes('original production event'))
  await security.store.writeJson(stateFile, { secret: 'updated production event' })
  assert.deepEqual(await security.store.readJson(stateFile), { secret: 'updated production event' })
  const envelope = JSON.parse(await readFile(stateFile, 'utf8'))
  envelope.tag = envelope.tag.slice(0, -2) + 'AA'
  await writeFile(stateFile, JSON.stringify(envelope))
  await assert.rejects(security.store.readJson(stateFile))

  const adminSession = await login('admin', 'correct-admin-password')
  const auditFile = path.join(temp, 'data', 'security', 'audit.jsonl')
  const pristine = await readFile(auditFile, 'utf8')
  const lines = pristine.trimEnd().split('\n')
  await writeFile(auditFile, `${lines.slice(0, -1).join('\n')}\n`)
  await assert.rejects(security.audit.verify(), /checkpoint|integrity/i)
  const admin = await login('admin', 'correct-admin-password')
  assert.equal(admin.status, 503)
  assert.equal((await request('/api/security/audit', { cookie: adminSession.cookie })).status, 503)
  await writeFile(auditFile, pristine.replace('"seq":1', '"seq":9'))
  await assert.rejects(security.audit.verify(), /integrity/i)
  await writeFile(auditFile, pristine)
  assert.equal((await security.audit.verify()).valid, true)
})
