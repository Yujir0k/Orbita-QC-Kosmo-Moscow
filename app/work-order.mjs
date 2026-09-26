/** Build an ERP order, preserving per-item identity for mixed nomenclature. */
export function workOrderPayload(workOrderId, items) {
  if (!items.length) throw new Error('Empty work order');
  const first = items[0];
  const mixed = items.some(item => item.item_type_id !== first.item_type_id || item.assembly_revision !== first.assembly_revision);
  return {
    work_order_id: workOrderId,
    item_type_id: first.item_type_id,
    assembly_revision: first.assembly_revision,
    item_ids: items.map(item => item.id),
    quantity: items.length,
    ...(mixed ? { item_details: items.map(item => ({ item_id: item.id, item_type_id: item.item_type_id, assembly_revision: item.assembly_revision })) } : {}),
  };
}

/** Validate all order lines against the authoritative product catalogue. */
export function validWorkOrderItems(payload, catalogue) {
  if (!Array.isArray(payload.item_ids) || !payload.item_ids.length || payload.quantity !== payload.item_ids.length || new Set(payload.item_ids).size !== payload.item_ids.length) return false;
  const details = payload.item_details;
  if (details && (!Array.isArray(details) || details.length !== payload.item_ids.length || new Set(details.map(item => item.item_id)).size !== details.length)) return false;
  const lines = details ? new Map(details.map(item => [item.item_id, item])) : null;
  if (lines) {
    const first = lines.get(payload.item_ids[0]);
    if (!first || first.item_type_id !== payload.item_type_id || first.assembly_revision !== payload.assembly_revision) return false;
  }
  return payload.item_ids.every(id => {
    const item = catalogue.get(id);
    const line = lines ? lines.get(id) : payload;
    return item && line && item.work_order_id === payload.work_order_id && item.item_type_id === line.item_type_id && item.assembly_revision === line.assembly_revision;
  });
}
