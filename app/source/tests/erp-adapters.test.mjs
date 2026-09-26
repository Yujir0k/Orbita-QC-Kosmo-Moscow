import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createIntegration } from '../../integration.mjs'
import { createErpAdapter } from '../../erp-adapters.mjs'
import { createContractRegistry } from '../../contract-validator.mjs'

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const contracts = await createContractRegistry(directory)
const mapping = {
  orders: { 'WO-B': 'EXT-WO-B' },
  items: { 'ITEM-007': 'EXT-ITEM-007' },
  itemTypes: { 'TYPE-BRACKET-01': 'EXT-TYPE-BRACKET' },
}

async function listen(handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}

async function post(url, route, payload) {
  const response = await fetch(`${url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  return { status: response.status, body: await response.json() }
}

for (const profile of ['1c', 'galaktika']) {
  test(`${profile} adapter maps orders and quality results through its explicit gateway contract`, async t => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), `orbita-${profile}-`))
    const stateFile = path.join(temporary, 'state.json')
    t.after(async () => { await rm(stateFile).catch(() => {}); await rmdir(temporary) })
    const calls = []
    let unknownSerial = false
    const changedAt = '2026-02-17T15:45:00+03:00'
    const external = await listen(async (request, response) => {
      const body = await new Promise(resolve => { let value = ''; request.on('data', chunk => { value += chunk }); request.on('end', () => resolve(value ? JSON.parse(value) : null)) })
      calls.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body })
      const write = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }
      if (request.method === 'GET' && request.url === (profile === '1c' ? '/orbita/orders/EXT-WO-B' : '/integration/work-orders/EXT-WO-B')) {
        return write(200, profile === '1c'
          ? { order_ref: 'EXT-WO-B', number: 'WO-B', product_code: 'EXT-TYPE-BRACKET', assembly_revision: 'A', serial_numbers: [unknownSerial ? 'UNMAPPED' : 'EXT-ITEM-007'], modified_at: changedAt }
          : { documentId: 'EXT-WO-B', documentNo: 'WO-B', sku: 'EXT-TYPE-BRACKET', specRevision: 'A', units: [{ serialId: unknownSerial ? 'UNMAPPED' : 'EXT-ITEM-007' }], changedAt })
      }
      if (request.method === 'POST' && request.url === (profile === '1c' ? '/orbita/quality-results' : '/integration/quality-results')) {
        const attempt = calls.filter(row => row.method === 'POST').length
        const rejected = profile === '1c' ? body.verdict_code === 'ACCEPT' : body.decision === 'GOOD'
        return write(200, profile === '1c'
          ? { idempotency_key: body.idempotency_key, status: rejected ? 'REJECTED' : attempt === 1 ? 'RETRY' : 'ACCEPTED', receipt_id: `1C-ACK-${attempt}`, error_code: rejected ? 'QUALITY_RULE' : attempt === 1 ? 'TEMP_BUSY' : null }
          : { requestId: body.requestId, result: rejected ? 'REJECT' : 'OK', receiptId: `GAL-ACK-${attempt}`, errorCode: rejected ? 'QUALITY_RULE' : null })
      }
      write(404, { error: 'not found' })
    })
    t.after(async () => new Promise(resolve => external.server.close(resolve)))
    let baseUrl = ''
    const auth = profile === '1c' ? { type: 'basic', username: 'exchange', password: 'local-test' } : { type: 'bearer', token: 'local-test-token' }
    const integration = await createIntegration({ directory, stateFile, profile, getBaseUrl: () => baseUrl, contracts,
      adapterOptions: { baseUrl: external.url, mapping, auth } })
    t.after(() => integration.close())
    const app = await listen((request, response) => integration.handle(request, response, new URL(request.url, 'http://localhost').pathname))
    baseUrl = app.url
    t.after(async () => new Promise(resolve => app.server.close(resolve)))

    const initial = await (await fetch(`${baseUrl}/api/integrations/state`)).json()
    assert.equal(initial.profile, profile)
    assert.equal(initial.configured, true)
    assert.deepEqual(initial.available_orders, ['WO-B'])
    assert.equal((await post(baseUrl, '/api/integrations/pull', { work_order_id: 'WO-MISSING' })).status, 422)
    unknownSerial = true
    assert.equal((await post(baseUrl, '/api/integrations/pull', { work_order_id: 'WO-B' })).status, 422)
    unknownSerial = false
    const pulled = await post(baseUrl, '/api/integrations/pull', { work_order_id: 'WO-B' })
    assert.equal(pulled.status, 200)
    assert.equal(pulled.body.status, 'accepted')
    assert.deepEqual(pulled.body.order.message.payload.item_ids, ['ITEM-007'])
    assert.equal(pulled.body.order.external_refs.item_keys['ITEM-007'], 'EXT-ITEM-007')
    assert.equal('source_snapshot' in pulled.body.order, false)
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).orders[0].source_snapshot[profile === '1c' ? 'order_ref' : 'documentId'], 'EXT-WO-B')
    assert.equal((await post(baseUrl, '/api/integrations/pull', { work_order_id: 'WO-B' })).body.status, 'duplicate')
    assert.equal((await post(baseUrl, '/api/emulator/results', {})).status, 404)

    const sent = await post(baseUrl, '/api/integrations/results', { item_id: 'ITEM-007', quality_status: 'quarantined', basis_event_ids: ['EVT-0048'] })
    assert.equal(sent.status, 200)
    assert.equal(sent.body.status, profile === '1c' ? 'retry_wait' : 'accepted')
    if (profile === '1c') {
      assert.equal(calls.at(-1).body.verdict_code, 'HOLD')
      assert.equal(calls.at(-1).body.serial_number, 'EXT-ITEM-007')
      const retried = await post(baseUrl, `/api/integrations/retry/${sent.body.message.correlation_key}`, {})
      assert.equal(retried.body.status, 'accepted')
      assert.equal(calls.at(-1).body.idempotency_key, calls.at(-2).body.idempotency_key)
    } else {
      assert.equal(calls.at(-1).body.decision, 'ISOLATE')
      assert.equal(calls.at(-1).body.unitId, 'EXT-ITEM-007')
    }
    assert.equal(calls[0].authorization, profile === '1c' ? `Basic ${Buffer.from('exchange:local-test').toString('base64')}` : 'Bearer local-test-token')
    const state = await (await fetch(`${baseUrl}/api/integrations/state`)).json()
    assert.equal(state.orders.length, 1)
    assert.equal('source_snapshot' in state.orders[0], false)
    assert.equal(state.outbox.length, 1)
    assert.equal(state.outbox[0].status, 'accepted')
    assert.equal(JSON.stringify(state).includes('local-test'), false)
    const rejected = await post(baseUrl, '/api/integrations/results', { item_id: 'ITEM-007', quality_status: 'accepted', basis_event_ids: ['EVT-0048'] })
    assert.equal(rejected.body.status, 'failed')
    assert.equal(rejected.body.last_error, 'QUALITY_RULE')
    assert.equal(rejected.body.next_retry_at, null)
    for (const [status, externalCode] of [['rework_required', 'REWORK'], ['scrapped', 'SCRAP']]) {
      const result = await post(baseUrl, '/api/integrations/results', { item_id: 'ITEM-007', quality_status: status, basis_event_ids: ['EVT-0048'] })
      assert.equal(result.body.status, 'accepted')
      assert.equal(calls.at(-1).body[profile === '1c' ? 'verdict_code' : 'decision'], externalCode)
    }
  })
}

test('an unconfigured ERP profile stays visibly inactive and remote plain HTTP is rejected', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'orbita-unconfigured-'))
  const integration = await createIntegration({ directory, stateFile: path.join(temporary, 'state.json'), profile: '1c', adapterOptions: {}, contracts })
  const app = await listen((request, response) => integration.handle(request, response, new URL(request.url, 'http://localhost').pathname))
  t.after(async () => { integration.close(); await new Promise(resolve => app.server.close(resolve)); await rmdir(temporary) })
  const state = await (await fetch(`${app.url}/api/integrations/state`)).json()
  assert.equal(state.configured, false)
  assert.equal((await post(app.url, '/api/integrations/pull', { work_order_id: 'WO-B' })).status, 503)
  assert.throws(() => createErpAdapter({ profile: '1c', baseUrl: 'http://erp.example.test', mapping }), /HTTPS/)
})
