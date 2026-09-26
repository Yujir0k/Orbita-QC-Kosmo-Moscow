import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { workOrderPayload, validWorkOrderItems } from './work-order.mjs'
import { createErpAdapter } from './erp-adapters.mjs'
import { readJsonObject } from './contract-validator.mjs'

const canonical = value => JSON.stringify(value, (_key, part) => part && typeof part === 'object' && !Array.isArray(part) ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part)
const text = value => typeof value === 'string' && value.trim().length > 0
const fail = (status, message) => Object.assign(new Error(message), { status })
const resultStatuses = new Set(['accepted', 'quarantined', 'released_after_rework', 'rework_required', 'scrapped'])
const json = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(JSON.stringify(body))
}

export async function createIntegration({ directory, getBaseUrl, stateFile, storage, internalToken, contracts, profile = process.env.ORBITA_ERP_PROFILE || 'emulator', adapterOptions }) {
  const bodyOf = request => readJsonObject(request, { maxBytes: 1_000_000 })
  if (!['emulator', '1c', 'galaktika'].includes(profile)) throw new Error(`Неизвестный профиль ERP: ${profile}`)
  let external = null
  let externalMapping = null
  if (profile !== 'emulator') {
    let mapping = adapterOptions?.mapping
    const mappingFile = adapterOptions?.mappingFile ?? process.env.ORBITA_ERP_MAPPING_FILE
    if (!mapping && mappingFile) mapping = JSON.parse(await readFile(path.isAbsolute(mappingFile) ? mappingFile : path.resolve(directory, mappingFile), 'utf8'))
    externalMapping = mapping
    const prefix = profile === '1c' ? 'ORBITA_1C_' : 'ORBITA_GALAKTIKA_'
    const auth = adapterOptions?.auth ?? (process.env[`${prefix}TOKEN`] ? { type: 'bearer', token: process.env[`${prefix}TOKEN`] }
      : process.env[`${prefix}USER`] || process.env[`${prefix}PASSWORD`] ? { type: 'basic', username: process.env[`${prefix}USER`], password: process.env[`${prefix}PASSWORD`] } : undefined)
    external = createErpAdapter({ profile, baseUrl: adapterOptions?.baseUrl ?? process.env[`${prefix}BASE_URL`],
      mapping, auth, fetchImpl: adapterOptions?.fetchImpl })
  }
  const fixtureRoot = path.join(directory, 'source', 'integration-fixtures')
  const fixturePath = path.join(fixtureRoot, 'inbound.jsonl')
  const demoPath = path.join(directory, 'source', 'src', 'demo-data.json')
  const statePath = stateFile ?? path.join(directory, 'data', profile === 'emulator' ? 'integration-state.json' : `integration-state-${profile}.json`)
  const fixture = (await readFile(fixturePath, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line))
  const sampleResults = (await readFile(path.join(fixtureRoot, 'expected_outbound.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line))
  const sampleAssembly = JSON.parse(await readFile(path.join(fixtureRoot, 'assemblies.json'), 'utf8'))[0]
  const demo = JSON.parse(await readFile(demoPath, 'utf8'))
  const items = new Map(demo.items.map(item => [item.id, item]))
  const sourceOrders = new Map(fixture.map(row => [row.message.payload.work_order_id, row]))
  const grouped = Map.groupBy(demo.items, item => item.work_order_id)
  for (const [workOrderId, group] of grouped) {
    if (sourceOrders.has(workOrderId)) continue
    sourceOrders.set(workOrderId, {
      delivery_id: `ERP-IN-${workOrderId}`, deliver_at: '2026-02-17T07:45:00+03:00',
      message: { message_id: `MSG-${workOrderId}`, message_type: 'work_order', schema_version: '1.0', source_system: 'ERP-EMU', sent_at: '2026-02-17T07:45:00+03:00', payload: workOrderPayload(workOrderId, group) },
    })
  }
  const fresh = () => ({ profile, orders: [], outbox: [], emulator: { accepted: [], attempts: {} }, assemblies: [] })
  let state
  if (storage) state = { ...fresh(), ...(await storage.readJson(statePath) ?? {}) }
  else {
    try { state = { ...fresh(), ...JSON.parse(await readFile(statePath, 'utf8')) } }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = fresh() }
  }
  if (state.profile !== profile) throw new Error(`Файл состояния принадлежит профилю ${state.profile}; требуется отдельный файл для ${profile}`)
  let writes = Promise.resolve()
  const persist = () => {
    const snapshot = JSON.stringify(state, null, 2)
    writes = writes.then(async () => {
      if (storage) await storage.writeJson(statePath, JSON.parse(snapshot))
      else {
        await mkdir(path.dirname(statePath), { recursive: true })
        const temporary = `${statePath}.tmp`
        await writeFile(temporary, snapshot)
        await rename(temporary, statePath)
      }
    })
    return writes
  }
  for (const entry of state.outbox) {
    if (entry.status === 'sending' || entry.status === 'pending') {
      entry.status = 'retry_wait'
      entry.next_retry_at = new Date().toISOString()
    }
  }
  const publicOrder = ({ source_snapshot, ...order }) => order
  const publicState = () => ({
    mode: external?.source ?? 'ERP-EMU', profile, configured: external?.configured ?? true,
    available_orders: profile === 'emulator' ? [...sourceOrders.keys()] : Object.keys(externalMapping?.orders ?? {}), orders: state.orders.map(publicOrder),
    outbox: state.outbox, assemblies: state.assemblies,
    emulator_received: state.emulator.accepted.length,
    sample_results: sampleResults.map(row => row.payload), sample_assembly: sampleAssembly,
  })
  const sending = new Set()
  async function dispatch(entry) {
    if (sending.has(entry.message.correlation_key) || entry.status === 'accepted') return entry
    sending.add(entry.message.correlation_key)
    entry.status = 'sending'
    entry.attempts += 1
    entry.updated_at = new Date().toISOString()
    contracts?.assert('integration', entry.message, '#/$defs/qualityResult', 'Исходящее сообщение ERP не прошло проверку')
    await persist()
    try {
      const order = state.orders.find(row => row.message.payload.work_order_id === entry.message.payload.work_order_id)
      let receipt
      let responseOk = true
      if (external) receipt = await external.sendResult(entry.message, entry.attempts, order)
      else {
        const response = await fetch(`${getBaseUrl()}/api/emulator/results`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...(internalToken ? { 'X-Orbita-Internal': internalToken } : {}) }, body: JSON.stringify(entry.message), signal: AbortSignal.timeout(5000),
        })
        responseOk = response.ok
        receipt = await response.json()
      }
      contracts?.assert('integration', receipt, '#/$defs/qualityResultAck', 'Квитанция ERP не соответствует контракту')
      if (receipt.correlation_key !== entry.message.correlation_key || receipt.attempt !== entry.attempts || receipt.message_type !== 'quality_result_ack') throw new Error('Неверная квитанция ERP')
      entry.receipts.push(receipt)
      if (responseOk && receipt.status === 'accepted') {
        entry.status = 'accepted'; entry.next_retry_at = null; entry.last_error = null
      } else if (receipt.status === 'temporary_unavailable') {
        entry.status = 'retry_wait'; entry.last_error = receipt.error_code || 'ERP временно недоступна'
        entry.next_retry_at = new Date(Date.now() + Math.min(3000 * 2 ** (entry.attempts - 1), 60000)).toISOString()
      } else if (receipt.status === 'rejected') {
        entry.status = 'failed'; entry.last_error = receipt.error_code || 'ERP отклонила результат'; entry.next_retry_at = null
      } else throw new Error('ERP вернула ошибку без согласованной квитанции')
    } catch (error) {
      entry.status = error.retryable === false ? 'failed' : 'retry_wait'; entry.last_error = error.message
      entry.next_retry_at = entry.status === 'failed' ? null : new Date(Date.now() + Math.min(3000 * 2 ** (entry.attempts - 1), 60000)).toISOString()
    } finally {
      entry.updated_at = new Date().toISOString()
      if (entry.attempts >= 5 && entry.status !== 'accepted') { entry.status = 'failed'; entry.next_retry_at = null }
      await persist(); sending.delete(entry.message.correlation_key)
    }
    return entry
  }
  const retryTimer = setInterval(() => {
    for (const entry of state.outbox) if (entry.status === 'retry_wait' && Date.parse(entry.next_retry_at) <= Date.now()) void dispatch(entry).catch(console.error)
  }, 1000)
  retryTimer.unref()

  async function importAssembly(input) {
    if (!text(input.assembly_id) || !text(input.revision) || !Array.isArray(input.components) || !input.components.length || input.components.some(c => !text(c.component_type_id) || !Number.isInteger(c.quantity) || c.quantity < 1)) throw fail(422, 'Нужны ID сборки, ревизия и компоненты с количеством')
    if (input.geometry_included !== false) throw fail(422, 'В учебном импорте явно укажите geometry_included: false')
    const existing = state.assemblies.find(row => row.assembly_id === input.assembly_id && row.revision === input.revision)
    if (existing && canonical(existing.components) !== canonical(input.components)) throw fail(409, 'Конфликт состава той же ревизии')
    if (!existing) { state.assemblies.push({ ...input, imported_at: new Date().toISOString() }); await persist() }
    return { status: existing ? 'duplicate' : 'accepted', assembly: existing ?? input }
  }

  async function handle(request, response, pathname) {
    try {
      if (pathname === '/api/integrations/state' && request.method === 'GET') return json(response, 200, publicState())
      if (profile === 'emulator' && pathname === '/api/emulator/orders' && request.method === 'GET') return json(response, 200, [...sourceOrders.values()])
      if (profile === 'emulator' && pathname.startsWith('/api/emulator/orders/') && request.method === 'GET') {
        const row = sourceOrders.get(decodeURIComponent(pathname.split('/').at(-1)))
        return json(response, row ? 200 : 404, row ?? { error: 'Задание не найдено' })
      }
      if (profile === 'emulator' && pathname === '/api/emulator/results' && request.method === 'POST') {
        const message = await bodyOf(request)
        contracts?.assert('integration', message, '#/$defs/qualityResult', 'Результат ERP не соответствует контракту')
        if (message.message_type !== 'quality_result' || message.schema_version !== '1.0' || !text(message.correlation_key) || !resultStatuses.has(message.payload?.quality_status) || !text(message.payload?.item_id) || !text(message.payload?.work_order_id) || !Array.isArray(message.payload?.basis_event_ids) || !message.payload.basis_event_ids.length) throw fail(422, 'Некорректный результат контроля')
        const key = message.correlation_key
        state.emulator.attempts[key] = (state.emulator.attempts[key] || 0) + 1
        const attempt = state.emulator.attempts[key]
        const previous = state.emulator.accepted.find(row => row.correlation_key === key)
        if (previous && canonical(previous.message) !== canonical(message)) throw fail(409, 'Конфликт correlation_key с другим результатом')
        const previouslyAccepted = !!previous
        const unavailable = message.payload.item_id === 'ITEM-007' && attempt === 1 && !previouslyAccepted
        if (!unavailable && !previouslyAccepted) state.emulator.accepted.push({ correlation_key: key, message, received_at: new Date().toISOString() })
        await persist()
        return json(response, unavailable ? 503 : 200, {
          message_id: `ERP-ACK-${key}-${attempt}`, message_type: 'quality_result_ack', schema_version: '1.0', source_system: 'ERP-EMU',
          correlation_key: key, attempt, status: unavailable ? 'temporary_unavailable' : 'accepted', error_code: unavailable ? 'ERP_TEMPORARY_UNAVAILABLE' : null,
        })
      }
      if (pathname === '/api/integrations/pull' && request.method === 'POST') {
        const input = await bodyOf(request)
        contracts?.assert('integration', input, '#/$defs/pullRequest', 'Запрос ERP не соответствует контракту')
        if (!text(input.work_order_id)) throw fail(422, 'Укажите ID заказа')
        let row
        if (external) row = await external.fetchOrder(input.work_order_id)
        else {
          if (!sourceOrders.has(input.work_order_id)) throw fail(404, 'Неизвестный заказ ERP-эмулятора')
          const upstream = await fetch(`${getBaseUrl()}/api/emulator/orders/${encodeURIComponent(input.work_order_id)}`, { headers: internalToken ? { 'X-Orbita-Internal': internalToken } : {}, signal: AbortSignal.timeout(5000) })
          if (!upstream.ok) throw fail(502, 'Не удалось получить задание от ERP')
          row = await upstream.json()
        }
        contracts?.assert('integration', row.message, '#/$defs/workOrder', 'Задание ERP не соответствует контракту')
        const p = row.message?.payload
        if (row.message?.message_type !== 'work_order' || row.message?.schema_version !== '1.0' || row.message?.source_system !== (external?.source ?? 'ERP-EMU') || !text(p?.work_order_id) || !validWorkOrderItems(p, items)) throw fail(422, 'Получено задание с некорректными идентификаторами')
        const existing = state.orders.find(order => order.message.payload.work_order_id === p.work_order_id)
        if (existing && canonical(existing.message) !== canonical(row.message)) throw fail(409, 'Конфликт версии задания')
        if (!existing) { state.orders.push({ ...row, received_at: new Date().toISOString() }); await persist() }
        return json(response, 200, { status: existing ? 'duplicate' : 'accepted', order: publicOrder(existing ?? row) })
      }
      if (pathname === '/api/integrations/results' && request.method === 'POST') {
        const input = await bodyOf(request)
        contracts?.assert('integration', input, '#/$defs/qualityResultRequest', 'Исходящий результат не соответствует контракту')
        if (!text(input.item_id) || !resultStatuses.has(input.quality_status) || !Array.isArray(input.basis_event_ids) || !input.basis_event_ids.length || input.basis_event_ids.some(id => !text(id))) throw fail(422, 'Укажите изделие, статус и события-основания')
        const order = state.orders.find(row => row.message.payload.item_ids.includes(input.item_id))
        if (!order) throw fail(409, 'Сначала получите задание на это изделие из ERP')
        const payload = { item_id: input.item_id, work_order_id: order.message.payload.work_order_id, quality_status: input.quality_status, basis_event_ids: [...new Set(input.basis_event_ids)].sort() }
        const key = `QC-${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 20)}`
        let entry = state.outbox.find(row => row.message.correlation_key === key)
        if (!entry) {
          entry = { message: { message_id: `MSG-${key}`, message_type: 'quality_result', schema_version: '1.0', source_system: 'QUALITY-MVP', correlation_key: key, requires_ack: true, payload }, status: 'pending', attempts: 0, receipts: [], last_error: null, next_retry_at: null, created_at: new Date().toISOString() }
          state.outbox.push(entry); await persist()
        }
        if (entry.status !== 'accepted') await dispatch(entry)
        return json(response, 200, entry)
      }
      if (pathname.startsWith('/api/integrations/retry/') && request.method === 'POST') {
        const key = decodeURIComponent(pathname.split('/').at(-1))
        const entry = state.outbox.find(row => row.message.correlation_key === key)
        if (!entry) throw fail(404, 'Сообщение не найдено')
        if (entry.status === 'accepted') return json(response, 200, entry)
        entry.attempts = Math.min(entry.attempts, 4)
        await dispatch(entry)
        return json(response, 200, entry)
      }
      if (pathname === '/api/integrations/cad' && request.method === 'POST') {
        return json(response, 200, await importAssembly(await bodyOf(request)))
      }
      return json(response, 404, { error: 'API-маршрут не найден' })
    } catch (error) { return json(response, error.status || 500, { error: error.message || 'Ошибка сервера' }) }
  }
  return { handle, importAssembly, status: publicState, close: () => clearInterval(retryTimer) }
}
