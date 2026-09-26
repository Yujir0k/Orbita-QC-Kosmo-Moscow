import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { createOperations } from '../../operations.mjs'
import { createSecurity } from '../../security.mjs'
import { createAuditLog, createCrypto } from '../../security-crypto.mjs'
import { rotateKey } from '../scripts/rotate-key.mjs'

const temp = await mkdtemp(path.join(tmpdir(), 'orbita-operations-'))
after(() => rm(temp, { recursive: true, force: true }))
const security = await createSecurity({ directory: temp, items: [], users: [{ id: 'admin', role: 'administrator', lineIds: [], password: 'test-password' }] })
await security.store.writeJson(path.join(temp, 'data', 'integration-state.json'), { secret: 'encrypted-state', outbox: [] })
await security.audit.append({ type: 'test.event', at: new Date().toISOString(), actor: 'test' })
const integration = { status: () => ({ configured: true, mode: 'ERP-EMU', orders: [], outbox: [], assemblies: [] }) }
const plant = { status: () => ({ mes: { configured: false, deliveries: [], outbox: [], last_error: null }, cad: { configured: false, imports: [] } }) }
const contracts = { describe: () => ({ status: 'loaded', count: 5 }) }
const operations = await createOperations({ directory: temp, security, integration, plant, contracts })

test('backup is created with a manifest and passes isolated restore verification', async () => {
  const result = await operations.createBackup('admin')
  assert.equal(result.files >= 4, true)
  assert.equal(result.sha256.length, 64)
  assert.equal((await operations.verifyBackup(path.join(temp, 'data', 'backups', result.filename))).valid, true)
  const health = await operations.health()
  assert.equal(health.status, 'ok')
  assert.equal(health.backup.backupId, result.backupId)
  assert.equal(health.queues.erp.pending, 0)
})

test('offline key rotation re-encrypts state and audit and preserves a recovery set', async () => {
  const oldKey = await readFile(path.join(temp, 'data', 'security', 'root.key'))
  const result = await rotateKey(temp)
  const newKey = await readFile(path.join(temp, 'data', 'security', 'root.key'))
  assert.notDeepEqual(newKey, oldKey)
  assert.notEqual(result.fingerprint, result.previousFingerprint)
  const crypto = createCrypto(newKey)
  const state = JSON.parse(await readFile(path.join(temp, 'data', 'integration-state.json'), 'utf8'))
  assert.deepEqual(crypto.openData(state, 'integration-state.json'), { secret: 'encrypted-state', outbox: [] })
  assert.equal((await (await createAuditLog(path.join(temp, 'data', 'security', 'audit.jsonl'), crypto)).verify()).valid, true)
  assert.ok(result.stateFiles >= 1)
})
