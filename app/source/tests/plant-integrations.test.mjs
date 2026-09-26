import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createIntegration } from '../../integration.mjs'
import { createPlantIntegrations } from '../../plant-integrations.mjs'
import { createContractRegistry } from '../../contract-validator.mjs'

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const contracts = await createContractRegistry(directory)
const mesMapping = {
  items: { 'ITEM-007': 'MES-UNIT-007' }, itemTypes: { 'TYPE-BRACKET-01': 'MES-TYPE-01' },
  lines: { 'LINE-01': 'MES-LINE-01' }, stations: { 'ST-MILL': 'MES-ST-MILL' },
  shifts: { 'SHIFT-B': 'MES-SHIFT-B' }, runs: { 'RUN-007-MILLING-1': 'MES-RUN-007' },
  operations: { 'OP-MILL': 'MES-OP-MILL' }, actors: { 'OP-02': 'MES-ACTOR-02' },
  equipment: { 'EQ-CNC-01': 'MES-EQ-CNC-01' },
}
const cadMapping = {
  assemblies: { 'ASM-BRACKET-01': 'CAD-ASM-01' }, itemTypes: { 'TYPE-BRACKET-01': 'CAD-TYPE-01' },
  components: { BODY: 'CAD-BODY', INSERT: 'CAD-INSERT', FASTENER: 'CAD-FASTENER' },
}

async function listen(handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}
async function post(base, route, payload = {}) {
  const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  return { status: response.status, body: await response.json() }
}

test('MES facts sync once, quality decisions travel without re-entry, and CAD structure is pulled through an adapter', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'orbita-plant-'))
  const erpFile = path.join(temporary, 'erp.json'), plantFile = path.join(temporary, 'plant.json')
  const mesEvent = { eventId: 'EXT-START-1', type: 'operation_started', occurredAt: '2026-02-17T16:05:00+03:00',
    itemKey: 'MES-UNIT-007', itemTypeKey: 'MES-TYPE-01', lineKey: 'MES-LINE-01', stationKey: 'MES-ST-MILL',
    shiftKey: 'MES-SHIFT-B', runKey: 'MES-RUN-007', operationKey: 'MES-OP-MILL', actorKey: 'MES-ACTOR-02',
    equipmentKey: 'MES-EQ-CNC-01', data: { previous_operation_run_id: null } }
  let wrongMesId = false, cadConflict = false, decisionAttempts = 0
  const gateway = await listen(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = raw ? JSON.parse(raw) : null
    const reply = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }
    if (request.url.startsWith('/events?after=')) return reply(200, { cursor: 'CURSOR-1', events: [{ ...mesEvent, itemKey: wrongMesId ? 'UNKNOWN' : mesEvent.itemKey }] })
    if (request.url === '/quality-status' && request.method === 'POST') {
      decisionAttempts += 1
      assert.equal(body.itemKey, 'MES-UNIT-007')
      assert.equal(body.eventId, 'UI-QC-1')
      return reply(200, { eventId: body.eventId, status: decisionAttempts === 1 ? 'retry' : 'accepted', receiptId: `MES-ACK-${decisionAttempts}`, errorCode: decisionAttempts === 1 ? 'BUSY' : null })
    }
    if (request.url === '/assemblies/CAD-ASM-01') return reply(200, { assemblyId: 'CAD-ASM-01', itemTypeId: 'CAD-TYPE-01', revision: 'B',
      geometryIncluded: true, components: [
        { instanceId: 'BODY-1', typeId: 'CAD-BODY', parentInstanceId: 'CAD-ASM-01', quantity: cadConflict ? 2 : 1 },
        { instanceId: 'INSERT-1', typeId: 'CAD-INSERT', parentInstanceId: 'BODY-1', quantity: 1 },
      ] })
    reply(404, { error: 'not found' })
  })
  let baseUrl = ''
  const integration = await createIntegration({ directory, stateFile: erpFile, getBaseUrl: () => baseUrl, contracts })
  const plant = await createPlantIntegrations({ directory, stateFile: plantFile, importAssembly: integration.importAssembly,
    contracts,
    mesOptions: { baseUrl: gateway.url, mapping: mesMapping, token: 'mes-test-token' },
    cadOptions: { baseUrl: gateway.url, mapping: cadMapping, token: 'cad-test-token' } })
  const app = await listen((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname
    return pathname.startsWith('/api/plant/') ? plant.handle(request, response, pathname) : integration.handle(request, response, pathname)
  })
  baseUrl = app.url
  t.after(async () => {
    plant.close(); integration.close()
    await new Promise(resolve => app.server.close(resolve)); await new Promise(resolve => gateway.server.close(resolve))
    await rm(erpFile).catch(() => {}); await rm(plantFile).catch(() => {}); await rmdir(temporary)
  })

  const initial = await (await fetch(`${baseUrl}/api/plant/state`)).json()
  assert.equal(initial.mes.configured, true)
  assert.equal(initial.cad.configured, true)
  const first = await post(baseUrl, '/api/plant/mes/sync')
  assert.equal(first.status, 200)
  assert.equal(first.body.deliveries[0].message.operation_run_id, 'RUN-007-MILLING-1')
  assert.equal(first.body.deliveries[0].message.data.operation_id, 'OP-MILL')
  await post(baseUrl, '/api/plant/mes/sync')
  assert.equal((await (await fetch(`${baseUrl}/api/plant/state`)).json()).mes.received, 1)
  wrongMesId = true
  assert.equal((await post(baseUrl, '/api/plant/mes/sync')).status, 422)
  assert.equal((await (await fetch(`${baseUrl}/api/plant/state`)).json()).mes.cursor, 'CURSOR-1')
  wrongMesId = false

  const decision = { event_id: 'UI-QC-1', event_type: 'quality_decision', schema_version: '2.0', source_id: 'ORBITA-UI', item_id: 'ITEM-007',
    item_type_id: 'TYPE-BRACKET-01', line_id: 'LINE-01', station_id: 'ST-MILL', shift_id: 'SHIFT-B',
    actor_id: 'CTRL-1', occurred_at: '2026-02-17T16:10:00+03:00', data: { security_action_id: 'ACTION-1', decision: 'confirmed',
      disposition: 'quarantine', finding_refs: ['F-1'], reason: 'Дефект подтверждён контролёром' } }
  const queued = await post(baseUrl, '/api/plant/mes/decisions', decision)
  assert.equal(queued.body.status, 'retry_wait')
  await post(baseUrl, '/api/plant/mes/decisions', decision)
  assert.equal(decisionAttempts, 1)
  assert.equal((await post(baseUrl, '/api/plant/mes/retry/UI-QC-1')).body.status, 'accepted')
  assert.equal(decisionAttempts, 2)
  assert.equal((await post(baseUrl, '/api/plant/mes/decisions', { ...decision, actor_id: 'OTHER' })).status, 409)

  const cad = await post(baseUrl, '/api/plant/cad/pull', { assembly_id: 'ASM-BRACKET-01' })
  assert.equal(cad.status, 200)
  assert.equal(cad.body.assembly.geometry_included, false)
  assert.equal(cad.body.assembly.components[1].parent, 'CAD-BODY-1')
  assert.equal((await post(baseUrl, '/api/plant/cad/pull', { assembly_id: 'ASM-BRACKET-01' })).body.status, 'duplicate')
  cadConflict = true
  assert.equal((await post(baseUrl, '/api/plant/cad/pull', { assembly_id: 'ASM-BRACKET-01' })).status, 409)
  const state = await (await fetch(`${baseUrl}/api/plant/state`)).json()
  assert.equal(state.cad.imports.length, 1)
  assert.equal('source_snapshot' in state.cad.imports[0], false)
  assert.equal(JSON.parse(await readFile(plantFile, 'utf8')).cad.imports[0].source_snapshot.assemblyId, 'CAD-ASM-01')
})
