import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { workOrderPayload, validWorkOrderItems } from '../../work-order.mjs';

test('every seeded ERP order preserves product type and revision, including mixed WO-C01', async () => {
  const dataset = JSON.parse(await readFile(new URL('../src/demo-data.json', import.meta.url), 'utf8'));
  const catalogue = new Map(dataset.items.map(item => [item.id, item]));
  for (const [id, items] of Map.groupBy(dataset.items, item => item.work_order_id)) {
    const payload = workOrderPayload(id, items);
    assert.equal(validWorkOrderItems(payload, catalogue), true, id);
    if (id === 'WO-C01') {
      assert.equal(payload.item_details.length, items.length);
      const forged = structuredClone(payload);
      forged.item_details.at(-1).assembly_revision = 'UNKNOWN';
      assert.equal(validWorkOrderItems(forged, catalogue), false);
      const duplicate = structuredClone(payload);
      duplicate.item_details[1] = duplicate.item_details[0];
      assert.equal(validWorkOrderItems(duplicate, catalogue), false);
      delete payload.item_details;
      assert.equal(validWorkOrderItems(payload, catalogue), false);
    }
  }
});
