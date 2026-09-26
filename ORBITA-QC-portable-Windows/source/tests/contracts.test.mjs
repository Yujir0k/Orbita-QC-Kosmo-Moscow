import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkContracts } from '../scripts/check-contracts.mjs'

test('versioned JSON Schemas validate fixtures and reject unsafe contract drift', async () => {
  const result = await checkContracts()
  assert.equal(result.schemas, 5)
  assert.ok(result.deliveries > 1000)
  assert.ok(result.erpInbound > 0)
  assert.ok(result.erpOutbound > 0)
})
