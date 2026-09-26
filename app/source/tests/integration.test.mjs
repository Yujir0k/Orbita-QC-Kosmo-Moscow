import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createIntegration } from '../../integration.mjs'
import { createContractRegistry } from '../../contract-validator.mjs'

test('ERP exchange persists work orders, retries a temporary error, and imports a CAD assembly', async t => {
  const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const contracts = await createContractRegistry(directory)
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'orbita-integration-'))
  const stateFile = path.join(temporary, 'state.json')
  let baseUrl = ''
  const integration = await createIntegration({ directory, stateFile, getBaseUrl: () => baseUrl, contracts })
  const server = http.createServer((request, response) => integration.handle(request, response, new URL(request.url, 'http://localhost').pathname))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    integration.close()
    await new Promise(resolve => server.close(resolve))
    await rm(stateFile)
    await rmdir(temporary)
  })
  const send = async (url, body) => {
    const response = await fetch(`${baseUrl}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const before = await send('/api/integrations/results', { item_id: 'ITEM-007', quality_status: 'quarantined', basis_event_ids: ['EVT-0048'] })
  assert.equal(before.status, 409)
  const received = await send('/api/integrations/pull', { work_order_id: 'WO-B' })
  assert.equal(received.body.status, 'accepted')
  assert.equal((await send('/api/integrations/pull', { work_order_id: 'WO-B' })).body.status, 'duplicate')
  const result = { item_id: 'ITEM-007', quality_status: 'quarantined', basis_event_ids: ['EVT-0048'] }
  const sent = await send('/api/integrations/results', result)
  assert.equal(sent.body.status, 'retry_wait')
  assert.equal(sent.body.receipts[0].status, 'temporary_unavailable')
  const retried = await send(`/api/integrations/retry/${sent.body.message.correlation_key}`, {})
  assert.equal(retried.body.status, 'accepted')
  assert.equal(retried.body.receipts[1].status, 'accepted')
  const repeated = await send('/api/integrations/results', result)
  assert.equal(repeated.body.message.correlation_key, sent.body.message.correlation_key)
  const current = await (await fetch(`${baseUrl}/api/integrations/state`)).json()
  assert.equal(current.outbox.length, 1)
  assert.equal(current.emulator_received, 1)
  const cad = await send('/api/integrations/cad', current.sample_assembly)
  assert.equal(cad.body.status, 'accepted')
  assert.equal((await send('/api/integrations/cad', current.sample_assembly)).body.status, 'duplicate')
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).assemblies.length, 1)
  const reloaded = await createIntegration({ directory, stateFile, getBaseUrl: () => baseUrl, contracts })
  const replayResponse = { writeHead(status) { this.status = status; return this }, end(body) { this.body = JSON.parse(body) } }
  await reloaded.handle({ method: 'GET' }, replayResponse, '/api/integrations/state')
  assert.equal(replayResponse.status, 200)
  assert.equal(replayResponse.body.orders.length, 1)
  assert.equal(replayResponse.body.outbox[0].status, 'accepted')
  reloaded.close()
  const mixed = await send('/api/integrations/pull', { work_order_id: 'WO-C01' })
  assert.equal(mixed.status, 200)
  assert.equal(mixed.body.order.message.payload.item_details.length, 20)
  const mixedResult = await send('/api/integrations/results', { item_id: 'ITEM-013', quality_status: 'rework_required', basis_event_ids: ['EVT-MIXED-TEST'] })
  assert.equal(mixedResult.status, 200)
  assert.equal(mixedResult.body.status, 'accepted')
})
