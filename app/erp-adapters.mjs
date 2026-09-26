import { createHash } from 'node:crypto'

const nonempty = value => typeof value === 'string' && value.trim().length > 0
const issue = (status, message, retryable = false) => Object.assign(new Error(message), { status, retryable })
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)

const profiles = {
  '1c': {
    source: 'ERP-1C', orderPath: key => `/orbita/orders/${encodeURIComponent(key)}`, resultPath: '/orbita/quality-results',
    read: raw => ({ orderKey: raw.order_ref, orderNumber: raw.number, itemTypeKey: raw.product_code,
      revision: raw.assembly_revision, itemKeys: raw.serial_numbers, changedAt: raw.modified_at }),
    write: (message, keys) => ({ message_id: message.message_id, idempotency_key: message.correlation_key,
      order_ref: keys.order, serial_number: keys.item,
      verdict_code: { accepted: 'ACCEPT', quarantined: 'HOLD', released_after_rework: 'RELEASE_AFTER_REWORK', rework_required: 'REWORK', scrapped: 'SCRAP' }[message.payload.quality_status],
      evidence_event_ids: message.payload.basis_event_ids }),
    receipt: raw => ({ key: raw.idempotency_key, status: raw.status, id: raw.receipt_id, error: raw.error_code }),
    accepted: 'ACCEPTED', temporary: 'RETRY', rejected: 'REJECTED',
  },
  galaktika: {
    source: 'ERP-GALAKTIKA', orderPath: key => `/integration/work-orders/${encodeURIComponent(key)}`, resultPath: '/integration/quality-results',
    read: raw => ({ orderKey: raw.documentId, orderNumber: raw.documentNo, itemTypeKey: raw.sku,
      revision: raw.specRevision, itemKeys: raw.units?.map(unit => unit.serialId), changedAt: raw.changedAt }),
    write: (message, keys) => ({ requestId: message.correlation_key, documentId: keys.order,
      unitId: keys.item,
      decision: { accepted: 'GOOD', quarantined: 'ISOLATE', released_after_rework: 'REWORKED_GOOD', rework_required: 'REWORK', scrapped: 'SCRAP' }[message.payload.quality_status],
      sourceEvents: message.payload.basis_event_ids }),
    receipt: raw => ({ key: raw.requestId, status: raw.result, id: raw.receiptId, error: raw.errorCode }),
    accepted: 'OK', temporary: 'RETRY', rejected: 'REJECT',
  },
}

function validateBaseUrl(value) {
  let url
  try { url = new URL(value) } catch { throw issue(400, 'Некорректный адрес ERP') }
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw issue(400, 'Адрес ERP должен содержать только схему, хост и базовый путь')
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw issue(400, 'Для удалённой ERP требуется HTTPS')
  return url.href.replace(/\/$/, '')
}

function validateMapping(mapping) {
  for (const section of ['orders', 'items', 'itemTypes']) {
    const entries = Object.entries(mapping?.[section] ?? {})
    if (!entries.length || entries.some(([internal, external]) => !nonempty(internal) || !nonempty(external))) throw issue(400, `Нет сопоставления ${section}`)
    if (new Set(entries.map(([, external]) => external)).size !== entries.length) throw issue(400, `Повтор внешнего ID в ${section}`)
  }
  return mapping
}

export function createErpAdapter({ profile, baseUrl, mapping, auth, fetchImpl = fetch }) {
  const format = profiles[profile]
  if (!format) throw issue(400, `Неизвестный профиль ERP: ${profile}`)
  const configured = !!(baseUrl && mapping)
  if (!configured) return {
    profile, source: format.source, configured: false,
    fetchOrder: async () => { throw issue(503, 'Укажите адрес ERP и файл сопоставления ID') },
    sendResult: async () => { throw issue(503, 'Укажите адрес ERP и файл сопоставления ID') },
  }
  const root = validateBaseUrl(baseUrl)
  const ids = validateMapping(mapping)
  const reverse = Object.fromEntries(['orders', 'items', 'itemTypes'].map(section => [section,
    new Map(Object.entries(ids[section]).map(([internal, external]) => [external, internal]))]))
  const headers = { Accept: 'application/json' }
  if (auth?.type === 'basic' && nonempty(auth.username) && nonempty(auth.password)) {
    headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
  } else if (auth?.type === 'bearer' && nonempty(auth.token)) headers.Authorization = `Bearer ${auth.token}`
  else if (auth) throw issue(400, 'Неполная настройка авторизации ERP')

  async function request(relative, options = {}) {
    let response
    try {
      response = await fetchImpl(`${root}${relative}`, { ...options, headers: { ...headers, ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, signal: AbortSignal.timeout(5000), redirect: 'error' })
    } catch { throw issue(503, 'ERP недоступна по сети', true) }
    if (response.status === 404) throw issue(404, 'Объект ERP не найден')
    if (response.status === 401 || response.status === 403) throw issue(502, 'ERP отклонила учётные данные')
    if (response.status === 429 || response.status >= 500) throw issue(503, `ERP временно недоступна: HTTP ${response.status}`, true)
    if (!response.ok) throw issue(502, `ERP отклонила запрос: HTTP ${response.status}`)
    try { return await response.json() } catch { throw issue(502, 'ERP вернула не JSON', true) }
  }

  return {
    profile, source: format.source, configured: true,
    async fetchOrder(internalOrderId) {
      const externalOrderId = ids.orders[internalOrderId]
      if (!nonempty(externalOrderId)) throw issue(422, 'Заказ не сопоставлен с ERP')
      const raw = await request(format.orderPath(externalOrderId))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw issue(422, 'ERP вернула заказ вне согласованного контракта')
      const value = format.read(raw)
      if (value.orderKey !== externalOrderId || !nonempty(value.orderNumber) || !nonempty(value.itemTypeKey) || !nonempty(value.revision)
        || !nonempty(value.changedAt) || Number.isNaN(Date.parse(value.changedAt))
        || !Array.isArray(value.itemKeys) || !value.itemKeys.length || value.itemKeys.some(key => !nonempty(key))) {
        throw issue(422, 'ERP вернула заказ вне согласованного контракта')
      }
      const itemTypeId = reverse.itemTypes.get(value.itemTypeKey)
      const itemIds = value.itemKeys.map(key => reverse.items.get(key))
      if (!itemTypeId || itemIds.some(id => !id) || new Set(itemIds).size !== itemIds.length) throw issue(422, 'В заказе ERP есть несопоставленные или повторные ID')
      const payload = { work_order_id: internalOrderId, item_type_id: itemTypeId, assembly_revision: value.revision,
        item_ids: itemIds, quantity: itemIds.length }
      const messageId = `${format.source}-${digest({ externalOrderId, value })}`
      return { delivery_id: `DEL-${messageId}`, deliver_at: value.changedAt,
        message: { message_id: messageId, message_type: 'work_order', schema_version: '1.0',
          source_system: format.source, sent_at: value.changedAt, payload },
        external_refs: { order_key: externalOrderId, order_number: value.orderNumber ?? null,
          item_keys: Object.fromEntries(itemIds.map((id, index) => [id, value.itemKeys[index]])) },
        source_snapshot: raw }
    },
    async sendResult(message, attempt, order) {
      const keys = { order: order.external_refs?.order_key, item: order.external_refs?.item_keys?.[message.payload.item_id] }
      if (!nonempty(keys.order) || !nonempty(keys.item)) throw issue(422, 'Нет внешнего ID заказа или изделия')
      const raw = await request(format.resultPath, { method: 'POST', body: JSON.stringify(format.write(message, keys)) })
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw issue(502, 'ERP вернула несогласованную квитанцию', true)
      const result = format.receipt(raw)
      if (result.key !== message.correlation_key || !nonempty(result.id) || ![format.accepted, format.temporary, format.rejected].includes(result.status)) throw issue(502, 'ERP вернула несогласованную квитанцию', true)
      const status = result.status === format.accepted ? 'accepted' : result.status === format.temporary ? 'temporary_unavailable' : 'rejected'
      return { message_id: result.id,
        message_type: 'quality_result_ack', schema_version: '1.0', source_system: format.source,
        correlation_key: message.correlation_key, attempt, status, error_code: result.error ?? null }
    },
  }
}
