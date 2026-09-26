import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createAuditLog, createCrypto, createEncryptedStore } from '../../security-crypto.mjs'
import { createMobileOps } from '../../mobileops.mjs'

test('MobileOps buffers an observation offline, delivers it once, and restores encrypted state', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'orbita-mobile-'))
  try {
    const crypto = createCrypto(randomBytes(32))
    const storage = createEncryptedStore(crypto)
    const audit = await createAuditLog(path.join(directory, 'audit.jsonl'), crypto)
    const options = { directory, storage, audit, items: [{ id: 'ITEM-1', item_type_id: 'TYPE-1' }], itemLineMap: { 'ITEM-1': 'LINE-01' } }
    const mobile = await createMobileOps(options)
    const master = { user: { id: 'master-01', role: 'master', lineIds: ['LINE-01'] } }
    const controller = { user: { id: 'controller-01', role: 'controller', lineIds: ['LINE-01'] } }
    const otherLine = { user: { id: 'other-master', role: 'master', lineIds: ['LINE-02'] } }
    await assert.rejects(mobile.createMission({ itemId: 'ITEM-1', robotId: 'MOBILE-01', checkpoint: 'CP-IN' }, controller), { status: 403 })
    await assert.rejects(mobile.createMission({ itemId: 'ITEM-1', robotId: 'MOBILE-01', checkpoint: 'CP-IN' }, otherLine), { status: 403 })
    const mission = await mobile.createMission({ itemId: 'ITEM-1', robotId: 'MOBILE-01', checkpoint: 'CP-IN' }, master)
    await mobile.setLink('MOBILE-01', false, master)
    const captured = await mobile.simulateObservation(mission.id, { result: 'unable_to_assess' }, master)
    assert.equal(captured.deliveryStatus, 'buffered')
    assert.equal(mobile.view(master).buffered, 1)
    assert.equal(mobile.deliveredEvents(master).length, 0)
    assert.equal((await mobile.simulateObservation(mission.id, { result: 'unable_to_assess' }, master)).duplicate, true)
    await assert.rejects(mobile.simulateObservation(mission.id, { result: 'no_signs_detected' }, master), { status: 409 })
    const restored = await createMobileOps(options)
    assert.equal(restored.view(master).buffered, 1)
    const flushed = await restored.setLink('MOBILE-01', true, master)
    assert.equal(flushed.flushed, 1)
    assert.equal((await restored.setLink('MOBILE-01', true, master)).flushed, 0)
    const delivered = restored.deliveredEvents(controller)
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0].message.event_type, 'inspection_result')
    assert.equal(delivered[0].message.source_id, 'MOBILE-EMU')
    assert.equal(delivered[0].message.data.capture_context.mission_id, mission.id)
    assert.equal(restored.view(master).missions[0].status, 'delivered')
    assert.ok(!(await readFile(path.join(directory, 'data', 'mobileops-state.json'), 'utf8')).includes('ITEM-1'))
    assert.equal((await audit.verify()).valid, true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
