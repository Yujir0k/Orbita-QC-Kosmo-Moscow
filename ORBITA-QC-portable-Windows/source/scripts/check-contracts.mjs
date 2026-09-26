import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContractRegistry } from '../../contract-validator.mjs'

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const application = path.resolve(source, '..')
const lines = async file => (await readFile(file, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))

export async function checkContracts() {
  const contracts = await createContractRegistry(application)
  const demo = JSON.parse(await readFile(path.join(source, 'src', 'demo-data.json'), 'utf8'))
  for (const delivery of demo.source) assert.deepEqual(contracts.validate('delivery', delivery), [], `Invalid delivery ${delivery.delivery_id}`)

  const fixtures = path.join(source, 'integration-fixtures')
  const inbound = await lines(path.join(fixtures, 'inbound.jsonl'))
  const outbound = await lines(path.join(fixtures, 'expected_outbound.jsonl'))
  for (const delivery of inbound) assert.deepEqual(contracts.validate('integration', delivery, '#/$defs/workOrderDelivery'), [], `Invalid ERP delivery ${delivery.delivery_id}`)
  for (const message of outbound) assert.deepEqual(contracts.validate('integration', message, '#/$defs/qualityResult'), [], `Invalid ERP result ${message.message_id}`)

  const missionRequest = { itemId: 'ITEM-013', robotId: 'MOBILE-01', checkpoint: 'CP-POST-MILL' }
  assert.deepEqual(contracts.validate('mobileops', missionRequest, '#/$defs/createMissionRequest'), [])
  assert.ok(contracts.validate('mobileops', { ...missionRequest, unexpected: true }, '#/$defs/createMissionRequest').some(error => error.includes('additional property')))
  assert.ok(contracts.validate('integration', { ...outbound[0], payload: { ...outbound[0].payload, basis_event_ids: [] } }, '#/$defs/qualityResult').length)
  assert.ok(contracts.validate('mobileops', JSON.parse('{"itemId":"ITEM-013","robotId":"MOBILE-01","checkpoint":"CP-IN","__proto__":{"admin":true}}'), '#/$defs/createMissionRequest').some(error => error.includes('Forbidden JSON key')))

  return { schemas: Object.keys(contracts.files).length, deliveries: demo.source.length, erpInbound: inbound.length, erpOutbound: outbound.length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkContracts()
  process.stdout.write(`Contracts OK: ${result.schemas} schemas, ${result.deliveries} event deliveries, ${result.erpInbound} ERP orders, ${result.erpOutbound} ERP results.\n`)
}
