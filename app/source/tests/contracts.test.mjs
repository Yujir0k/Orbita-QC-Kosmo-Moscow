import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createContractRegistry } from '../../contract-validator.mjs'
import { checkContracts } from '../scripts/check-contracts.mjs'

test('versioned JSON Schemas validate fixtures and reject unsafe contract drift', async () => {
  const result = await checkContracts()
  assert.equal(result.schemas, 5)
  assert.ok(result.deliveries > 1000)
  assert.ok(result.erpInbound > 0)
  assert.ok(result.erpOutbound > 0)
})

test('contract registry exposes safe operational metadata without remote references', async () => {
  const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const registry = await createContractRegistry(directory)
  const metadata = registry.describe()
  assert.equal(metadata.status, 'loaded')
  assert.equal(metadata.count, 5)
  assert.equal(metadata.policies.remoteReferences, false)
  assert.equal(metadata.policies.rejectUnknownFields, true)
  assert.deepEqual(metadata.schemas.map(row => row.name), ['event', 'delivery', 'decision', 'integration', 'mobileops'])
  assert.ok(metadata.schemas.every(row => /^[a-f0-9]{64}$/.test(row.fingerprint)))
})
