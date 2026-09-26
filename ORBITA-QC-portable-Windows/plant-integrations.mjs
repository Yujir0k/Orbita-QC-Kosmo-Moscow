import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readJsonObject } from './contract-validator.mjs'

const text = value => typeof value === 'string' && value.trim().length > 0
const fail = (status, message, retryable = false) => Object.assign(new Error(message), { status, retryable })
const json = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(JSON.stringify(body))
}
const canonical = value => JSON.stringify(value, (_key, part) => part && typeof part === 'object' && !Array.isArray(part) ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part)

function gateway(baseUrl, token, fetchImpl) {
  if (!baseUrl) return null
  let url
  try { url = new URL(baseUrl) } catch { throw fail(400, 'Некорректный адрес шлюза') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fail(400, 'Некорректный адрес шлюза')
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw fail(400, 'Для удалённого шлюза требуется HTTPS')
  const root = url.href.replace(/\/$/, '')
  return async (route, options = {}) => {
    let response
    try {
      response = await fetchImpl(`${root}${route}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}) } })
    } catch { throw fail(503, 'Шлюз недоступен по сети', true) }
    if (response.status === 404) throw fail(404, 'Объект в шлюзе не найден')
    if (response.status === 401 || response.status === 403) throw fail(502, 'Шлюз отклонил учётные данные')
    if (response.status === 429 || response.status >= 500) throw fail(503, `Шлюз временно недоступен: HTTP ${response.status}`, true)
    if (!response.ok) throw fail(502, `Шлюз отклонил запрос: HTTP ${response.status}`)
    try { return await response.json() } catch { throw fail(502, 'Шлюз вернул не JSON', true) }
  }
}

function mappings(value, sections) {
  if (!value) return null
  const result = {}
  for (const section of sections) {
    const entries = Object.entries(value[section] ?? {})
    if (!entries.length || entries.some(([internal, external]) => !text(internal) || !text(external)) || new Set(entries.map(([, external]) => external)).size !== entries.length) throw fail(400, `Некорректное сопоставление ${section}`)
    result[section] = { forward: value[section], reverse: new Map(entries.map(([internal, external]) => [external, internal])) }
  }
  return result
}

const mesTypes = new Set(['operation_started', 'operation_finished', 'operation_paused', 'operator_action', 'machine_state'])

export async function createPlantIntegrations({ directory, importAssembly, stateFile, storage, authorizeDecision, contracts, mesOptions = {}, cadOptions = {}, fetchImpl = fetch }) {
  const bodyOf = request => readJsonObject(request, { maxBytes: 1_000_000 })
  async function loadMapping(options, envName) {
    if (options.mapping) return options.mapping
    const file = options.mappingFile ?? process.env[envName]
    if (!file) return null
    return JSON.parse(await readFile(path.isAbsolute(file) ? file : path.resolve(directory, file), 'utf8'))
  }
  const mesMap = mappings(await loadMapping(mesOptions, 'ORBITA_MES_MAPPING_FILE'), ['items', 'itemTypes', 'lines', 'stations', 'shifts', 'runs', 'operations', 'actors', 'equipment'])
  const cadMap = mappings(await loadMapping(cadOptions, 'ORBITA_KOMPAS_MAPPING_FILE'), ['assemblies', 'itemTypes', 'components'])
  const mesRequest = gateway(mesOptions.baseUrl ?? process.env.ORBITA_MES_BASE_URL, mesOptions.token ?? process.env.ORBITA_MES_TOKEN, fetchImpl)
  const cadRequest = gateway(cadOptions.baseUrl ?? process.env.ORBITA_KOMPAS_BASE_URL, cadOptions.token ?? process.env.ORBITA_KOMPAS_TOKEN, fetchImpl)
  const mesConfigured = !!(mesMap && mesRequest)
  const cadConfigured = !!(cadMap && cadRequest)
  const file = stateFile ?? path.join(directory, 'data', 'plant-integration-state.json')
  const demo = JSON.parse(await readFile(path.join(directory, 'source', 'src', 'demo-data.json'), 'utf8'))
  const demoItems = new Map(demo.items.map(item => [item.id, item]))
  const fresh = () => ({ mes: { cursor: '', deliveries: [], raw: [], outbox: [], last_error: null }, cad: { imports: [] } })
  let state
  if (storage) state = { ...fresh(), ...(await storage.readJson(file) ?? {}) }
  else {
    try { state = { ...fresh(), ...JSON.parse(await readFile(file, 'utf8')) } }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = fresh() }
  }
  let writes = Promise.resolve()
  const persist = () => {
    const snapshot = JSON.stringify(state, null, 2)
    writes = writes.then(async () => {
      if (storage) await storage.writeJson(file, JSON.parse(snapshot))
      else { await mkdir(path.dirname(file), { recursive: true }); const temporary = `${file}.tmp`; await writeFile(temporary, snapshot); await rename(temporary, file) }
    })
    return writes
  }
  const publicState = () => ({
    mes: { configured: mesConfigured, cursor: state.mes.cursor, received: state.mes.deliveries.length,
      deliveries: state.mes.deliveries, outbox: state.mes.outbox, last_error: state.mes.last_error },
    cad: { configured: cadConfigured, available_assemblies: Object.keys(cadMap?.assemblies.forward ?? {}),
      imports: state.cad.imports.map(({ source_snapshot, ...entry }) => entry) },
  })
  const map = (section, external) => mesMap?.[section].reverse.get(external)
  function normalizeMes(raw) {
    if (!raw || !text(raw.eventId) || !mesTypes.has(raw.type) || !text(raw.occurredAt) || Number.isNaN(Date.parse(raw.occurredAt))) throw fail(422, 'MES вернула событие вне контракта')
    const itemId = map('items', raw.itemKey), itemTypeId = map('itemTypes', raw.itemTypeKey)
    const lineId = map('lines', raw.lineKey), stationId = map('stations', raw.stationKey), shiftId = map('shifts', raw.shiftKey)
    const runId = raw.runKey ? map('runs', raw.runKey) : undefined
    const operationId = raw.operationKey ? map('operations', raw.operationKey) : undefined
    const actorId = raw.actorKey ? map('actors', raw.actorKey) : undefined
    const equipmentId = raw.equipmentKey ? map('equipment', raw.equipmentKey) : undefined
    if (![itemId, itemTypeId, lineId, stationId, shiftId].every(text) || (raw.runKey && !runId)
      || (raw.operationKey && !operationId) || (raw.actorKey && !actorId) || (raw.equipmentKey && !equipmentId)
      || (raw.type.startsWith('operation_') && (!runId || !operationId))
      || demoItems.get(itemId)?.item_type_id !== itemTypeId
      || !demo.catalogs.lines.some(row => row.id === lineId) || !demo.catalogs.stations.some(row => row.id === stationId)
      || !demo.catalogs.shifts.some(row => row.id === shiftId)) throw fail(422, 'MES прислала несопоставленный ID')
    if (!raw.data || typeof raw.data !== 'object' || Array.isArray(raw.data)) throw fail(422, 'MES прислала событие без данных')
    const event = { event_id: `MES-${raw.eventId}`, event_type: raw.type, schema_version: '2.0', occurred_at: raw.occurredAt,
      source_id: 'MES-GATEWAY', item_id: itemId, item_type_id: itemTypeId, line_id: lineId, station_id: stationId,
      shift_id: shiftId, ...(runId ? { operation_run_id: runId } : {}), ...(actorId ? { actor_id: actorId } : {}),
      ...(equipmentId ? { equipment_id: equipmentId } : {}),
      data: operationId ? { ...raw.data, operation_id: operationId } : raw.data }
    return { delivery_id: `MES-DLV-${raw.eventId}`, deliver_at: new Date().toISOString(), message: event }
  }
  let syncing = null
  async function syncMes() {
    if (!mesConfigured) throw fail(503, 'Шлюз MES и сопоставления не настроены')
    if (syncing) return syncing
    syncing = (async () => {
      try {
        const batch = await mesRequest(`/events?after=${encodeURIComponent(state.mes.cursor)}`)
        contracts?.assert('integration', batch, '#/$defs/mesBatch', 'Пакет MES не соответствует контракту')
        if (!batch || !text(batch.cursor) || !Array.isArray(batch.events)) throw fail(502, 'MES вернула пакет вне контракта', true)
        const normalized = batch.events.map(normalizeMes)
        for (const row of normalized) contracts?.assert('delivery', row, '', 'Событие MES не прошло нормализацию')
        const staged = []
        for (let i = 0; i < normalized.length; i++) {
          const row = normalized[i]
          const existing = [...state.mes.deliveries, ...staged.map(entry => entry.row)].find(saved => saved.message.event_id === row.message.event_id)
          if (existing && canonical(existing.message) !== canonical(row.message)) throw fail(409, 'MES изменила событие с прежним eventId')
          if (!existing) staged.push({ row, raw: batch.events[i] })
        }
        for (const entry of staged) { state.mes.deliveries.push(entry.row); state.mes.raw.push(entry.raw) }
        state.mes.cursor = batch.cursor
        state.mes.last_error = null
        await persist()
        return { received: normalized.length, deliveries: state.mes.deliveries }
      } catch (error) {
        state.mes.last_error = error.message
        await persist()
        throw error
      }
    })()
    try { return await syncing } finally { syncing = null }
  }
  const sending = new Set()
  async function sendDecision(entry) {
    if (!mesConfigured) throw fail(503, 'Шлюз MES и сопоставления не настроены')
    if (sending.has(entry.event.event_id) || entry.status === 'accepted') return entry
    sending.add(entry.event.event_id)
    entry.status = 'sending'; entry.attempts += 1; await persist()
    try {
      const e = entry.event
      const receipt = await mesRequest('/quality-status', { method: 'POST', body: JSON.stringify({ eventId: e.event_id,
        itemKey: mesMap.items.forward[e.item_id], decision: e.data.decision, disposition: e.data.disposition,
        occurredAt: e.occurred_at, actorId: e.actor_id, findingRefs: e.data.finding_refs ?? [] }) })
      contracts?.assert('integration', receipt, '#/$defs/mesReceipt', 'Квитанция MES не соответствует контракту')
      if (!receipt || receipt.eventId !== e.event_id || !text(receipt.receiptId) || !['accepted', 'retry', 'rejected'].includes(receipt.status)) throw fail(502, 'MES вернула неверную квитанцию', true)
      entry.receipts.push(receipt)
      entry.status = receipt.status === 'accepted' ? 'accepted' : receipt.status === 'retry' ? 'retry_wait' : 'failed'
      entry.last_error = receipt.status === 'accepted' ? null : receipt.errorCode ?? receipt.status
    } catch (error) { entry.status = error.retryable ? 'retry_wait' : 'failed'; entry.last_error = error.message }
    finally {
      entry.next_retry_at = entry.status === 'retry_wait' && entry.attempts < 5 ? new Date(Date.now() + Math.min(3000 * 2 ** (entry.attempts - 1), 60000)).toISOString() : null
      if (entry.status === 'retry_wait' && entry.attempts >= 5) entry.status = 'failed'
      await persist(); sending.delete(entry.event.event_id)
    }
    return entry
  }
  const retryTimer = setInterval(() => {
    for (const entry of state.mes.outbox) if (entry.status === 'retry_wait' && Date.parse(entry.next_retry_at) <= Date.now()) void sendDecision(entry).catch(console.error)
  }, 1000)
  retryTimer.unref()

  async function queueDecision(event) {
    if (!mesConfigured) throw fail(503, 'Шлюз MES и сопоставления не настроены')
    contracts?.assert('decision', event, '', 'Решение для MES не соответствует контракту')
    if (!event || !text(event.event_id) || event.source_id !== 'ORBITA-UI' || event.event_type !== 'quality_decision'
      || !text(event.item_id) || !text(event.actor_id) || !text(event.occurred_at) || !text(event.data?.decision)
      || !text(mesMap.items.forward[event.item_id])) throw fail(422, 'Некорректное решение для MES')
    let entry = state.mes.outbox.find(row => row.event.event_id === event.event_id)
    if (entry && canonical(entry.event) !== canonical(event)) throw fail(409, 'Конфликт eventId решения')
    if (!entry) { entry = { event, status: 'pending', attempts: 0, receipts: [], last_error: null, next_retry_at: null }; state.mes.outbox.push(entry); await persist() }
    if (entry.status === 'pending') await sendDecision(entry)
    return entry
  }

  async function pullCad(assemblyId) {
    if (!cadConfigured) throw fail(503, 'Адаптер КОМПАС-3D и сопоставления не настроены')
    const externalId = cadMap.assemblies.forward[assemblyId]
    if (!text(externalId)) throw fail(422, 'Сборка не сопоставлена с КОМПАС-3D')
    const raw = await cadRequest(`/assemblies/${encodeURIComponent(externalId)}`)
    if (!raw || raw.assemblyId !== externalId || !text(raw.revision) || !text(raw.itemTypeId) || !Array.isArray(raw.components) || !raw.components.length) throw fail(422, 'Адаптер КОМПАС-3D вернул структуру вне контракта')
    const itemType = cadMap.itemTypes.reverse.get(raw.itemTypeId)
    const instanceIds = new Set(raw.components.map(c => c.instanceId))
    if (instanceIds.size !== raw.components.length || instanceIds.has(externalId) || raw.components.some(c => !text(c.instanceId) || !text(c.parentInstanceId) || (c.parentInstanceId !== externalId && !instanceIds.has(c.parentInstanceId)))) throw fail(422, 'Повтор или неизвестный родитель компонента КОМПАС-3D')
    const components = raw.components.map(c => ({ instance_id: `CAD-${c.instanceId}`,
      component_type_id: cadMap.components.reverse.get(c.typeId), quantity: c.quantity,
      parent: c.parentInstanceId === externalId ? assemblyId : `CAD-${c.parentInstanceId}` }))
    if (!itemType || components.some(c => !text(c.component_type_id) || !Number.isInteger(c.quantity) || c.quantity < 1 || c.instance_id === c.parent)) throw fail(422, 'Неизвестный компонент или количество в сборке КОМПАС-3D')
    const byId = new Map(components.map(c => [c.instance_id, c]))
    for (const component of components) {
      const visited = new Set([component.instance_id])
      let parent = component.parent
      while (parent !== assemblyId) {
        if (visited.has(parent) || !byId.has(parent)) throw fail(422, 'Цикл или неизвестный родитель в сборке КОМПАС-3D')
        visited.add(parent); parent = byId.get(parent).parent
      }
    }
    const normalized = { assembly_id: assemblyId, item_type_id: itemType, revision: raw.revision,
      geometry_included: false, components, source: 'KOMPAS-SDK-ADAPTER' }
    const result = await importAssembly(normalized)
    if (!state.cad.imports.some(row => row.assembly_id === assemblyId && row.revision === raw.revision)) {
      state.cad.imports.push({ assembly_id: assemblyId, revision: raw.revision, source_key: externalId, imported_at: new Date().toISOString(), source_snapshot: raw }); await persist()
    }
    return result
  }

  async function handle(request, response, pathname, principal) {
    try {
      if (pathname === '/api/plant/state' && request.method === 'GET') return json(response, 200, publicState())
      if (pathname === '/api/plant/mes/configured' && request.method === 'GET') return json(response, 200, { configured: mesConfigured })
      if (pathname === '/api/plant/mes/sync' && request.method === 'POST') {
        const batch = await syncMes()
        const lines = principal?.user?.lineIds
        return json(response, 200, lines ? { ...batch, deliveries: batch.deliveries.filter(row => lines.includes(row.message.line_id)) } : batch)
      }
      if (pathname === '/api/plant/mes/decisions' && request.method === 'POST') {
        const decision = await bodyOf(request)
        if (principal?.user && (principal.user.id !== decision?.actor_id || !principal.user.lineIds.includes(decision?.line_id))) throw fail(403, 'Решение недоступно для учётной записи или линии')
        if (authorizeDecision && !authorizeDecision(decision)) throw fail(403, 'Решение не подтверждено защищённым журналом действий')
        return json(response, 200, await queueDecision(decision))
      }
      if (pathname.startsWith('/api/plant/mes/retry/') && request.method === 'POST') {
        const id = decodeURIComponent(pathname.split('/').at(-1))
        const entry = state.mes.outbox.find(row => row.event.event_id === id)
        if (!entry) throw fail(404, 'Решение в очереди MES не найдено')
        if (entry.status !== 'accepted') { entry.attempts = Math.min(entry.attempts, 4); await sendDecision(entry) }
        return json(response, 200, entry)
      }
      if (pathname === '/api/plant/cad/pull' && request.method === 'POST') {
        const body = await bodyOf(request)
        return json(response, 200, await pullCad(body.assembly_id))
      }
      return json(response, 404, { error: 'API-маршрут не найден' })
    } catch (error) { return json(response, error.status || 500, { error: error.message || 'Ошибка сервера' }) }
  }
  return { handle, status: publicState, close: () => clearInterval(retryTimer) }
}
