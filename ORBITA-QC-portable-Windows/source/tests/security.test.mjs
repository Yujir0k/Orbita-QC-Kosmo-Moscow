import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { createSecurity } from '../../security.mjs'

const temp = await mkdtemp(path.join(tmpdir(), 'orbita-security-'))
after(() => rm(temp, { recursive: true, force: true }))
const rootKey = randomBytes(32)
const security = await createSecurity({ directory: temp, rootKey, items: [{ id: 'ITEM-1', item_type_id: 'TYPE-1' }], itemLineMap: { 'ITEM-1': 'LINE-1' },
  users: [{ id: 'qc', role: 'controller', lineIds: ['LINE-1'], password: 'correct-controller-password' },
    { id: 'master', role: 'master', lineIds: ['LINE-2'], password: 'correct-master-password' },
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
  assert.equal((await login('qc', 'wrong')).status, 401)
  const qc = await login('qc', 'correct-controller-password')
  assert.equal(qc.status, 200)
  assert.match(qc.cookie, /^orbita_session=/)
  assert.equal((await request('/api/integrations/state', { cookie: qc.cookie })).status, 403)
  assert.equal((await request('/api/plant/mes/decisions', { method: 'POST', cookie: qc.cookie, body: {} })).status, 403)
  assert.equal((await request('/api/plant/mes/decisions', { method: 'POST', cookie: qc.cookie, csrf: qc.csrf, origin: 'http://evil.example', body: {} })).status, 403)
  const denied = await request('/api/security/actions', { method: 'POST', cookie: qc.cookie, csrf: qc.csrf, body: { itemId: 'ITEM-1', action: 'master_complete', reason: 'Нужна проверка исполнителя' } })
  assert.equal(denied.status, 403)
  const master = await login('master', 'correct-master-password')
  assert.equal((await request('/api/security/actions', { method: 'POST', cookie: master.cookie, csrf: master.csrf, body: { itemId: 'ITEM-1', action: 'master_complete', reason: 'Работа на линии завершена' } })).status, 403)
  const admin = await login('admin', 'correct-admin-password')
  assert.equal((await request('/api/integrations/state', { cookie: admin.cookie })).status, 200)
  assert.equal((await request('/api/security/audit', { cookie: qc.cookie })).status, 403)
})

test('a controller action is attributed by the server and its original is encrypted and append-only', async () => {
  const qc = await login('qc', 'correct-controller-password')
  const approval = await request('/api/security/actions', { method: 'POST', cookie: qc.cookie, csrf: qc.csrf,
    body: { itemId: 'ITEM-1', action: 'confirm', reason: 'Вмятина подтверждена по измерению' } })
  assert.equal(approval.status, 200)
  assert.equal(approval.body.actorId, 'qc')
  const actionId = approval.body.actionId
  const event = { event_id: `UI-${actionId}-1`, event_type: 'quality_decision', schema_version: '2.0', occurred_at: new Date().toISOString(), source_id: 'ORBITA-UI', actor_id: 'qc', item_id: 'ITEM-1', item_type_id: 'TYPE-1', line_id: 'LINE-1', station_id: 'ST-1', shift_id: 'SHIFT-1', data: { decision: 'confirmed', disposition: 'rework', finding_refs: [], reason: 'Вмятина подтверждена по измерению', security_action_id: actionId } }
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
