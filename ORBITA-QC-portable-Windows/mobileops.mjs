import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { readJsonObject } from './contract-validator.mjs'

const fail = (status, message) => Object.assign(new Error(message), { status })
const send = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(JSON.stringify(body))
}

/** The simulator is one replaceable device adapter; missions and observations keep the same contract. */
export async function createMobileOps({ directory, storage, audit, contracts, items, itemLineMap, stateFile, now = () => new Date() }) {
  const demo = items ? null : JSON.parse(await readFile(path.join(directory, 'source', 'src', 'demo-data.json'), 'utf8'))
  const knownItems = items ?? demo.items
  const lines = new Map(Object.entries(itemLineMap ?? {}))
  for (const row of demo?.source ?? []) if (row.message?.item_id && row.message?.line_id) lines.set(row.message.item_id, row.message.line_id)
  const context = new Map()
  for (const row of demo?.source ?? []) if (row.message?.item_id) context.set(row.message.item_id, row.message)
  const file = stateFile ?? path.join(directory, 'data', 'mobileops-state.json')
  const initial = { version: 1, robots: [
    { id: 'MOBILE-01', lineId: 'LINE-01', online: true, sensors: ['visual'], simulator: true },
    { id: 'MOBILE-02', lineId: 'LINE-02', online: true, sensors: ['visual'], simulator: true },
  ], missions: [], outbox: [], deliveries: [] }
  let state = await storage.readJson(file) ?? initial
  if (state.version !== 1 || !Array.isArray(state.robots) || !Array.isArray(state.missions) || !Array.isArray(state.outbox) || !Array.isArray(state.deliveries)) throw new Error('Unsupported MobileOps state')
  let queue = Promise.resolve()
  const transaction = work => {
    const task = queue.then(async () => {
      const draft = structuredClone(state)
      const result = await work(draft)
      await storage.writeJson(file, draft)
      state = draft
      return result
    })
    queue = task.catch(() => {})
    return task
  }
  const scope = (principal, lineId) => principal?.user?.lineIds?.includes(lineId)
  const requireOperator = principal => { if (!['master', 'administrator'].includes(principal?.user?.role)) throw fail(403, 'Действие доступно только мастеру или администратору') }
  const requireRobot = (draft, robotId, principal) => {
    const robot = draft.robots.find(row => row.id === robotId)
    if (!robot) throw fail(404, 'Комплекс не найден')
    if (!scope(principal, robot.lineId)) throw fail(403, 'Комплекс находится вне доступной линии')
    return robot
  }
  const deliverySummary = row => ({
    eventId: row.message.event_id,
    missionId: row.message.data.capture_context.mission_id,
    itemId: row.message.item_id,
    robotId: row.message.actor_id,
    occurredAt: row.message.occurred_at,
    deliveredAt: row.receipt?.accepted_at ?? null,
  })
  const view = principal => ({ robots: state.robots.filter(row => scope(principal, row.lineId)),
    missions: state.missions.filter(row => scope(principal, row.lineId)),
    buffered: state.outbox.filter(row => scope(principal, row.message.line_id)).length,
    delivered: state.deliveries.filter(row => scope(principal, row.message.line_id)).length,
    bufferedEvents: state.outbox.filter(row => scope(principal, row.message.line_id)).map(deliverySummary),
    recentDeliveries: state.deliveries.filter(row => scope(principal, row.message.line_id))
      .slice().sort((a, b) => String(b.deliver_at).localeCompare(String(a.deliver_at))).slice(0, 10).map(deliverySummary) })
  const acceptDelivery = (draft, delivery, acceptedAt) => {
    const existing = draft.deliveries.find(saved => saved.message.event_id === delivery.message.event_id)
    if (existing) return { delivery: existing, accepted: false }
    const accepted = { ...delivery, deliver_at: acceptedAt, receipt: {
      status: 'accepted', accepted_at: acceptedAt, event_id: delivery.message.event_id,
      mission_id: delivery.message.data.capture_context.mission_id,
    } }
    draft.deliveries.push(accepted)
    return { delivery: accepted, accepted: true }
  }
  async function createMission(input, principal) {
    requireOperator(principal)
    const item = knownItems.find(row => row.id === input?.itemId)
    const lineId = item && lines.get(item.id)
    if (!item || !lineId || !['CP-IN', 'CP-POST-MILL', 'CP-FINAL'].includes(input?.checkpoint)) throw fail(422, 'Неизвестное изделие или контрольная точка')
    if (!scope(principal, lineId)) throw fail(403, 'Изделие вне доступной линии')
    return transaction(async draft => {
      const robot = requireRobot(draft, input.robotId, principal)
      if (robot.lineId !== lineId) throw fail(422, 'Комплекс и изделие находятся на разных линиях')
      if (!robot.online) throw fail(409, 'Сначала восстановите связь с комплексом')
      const mission = { id: randomUUID(), itemId: item.id, itemTypeId: item.item_type_id, lineId, robotId: robot.id,
        checkpoint: input.checkpoint, status: 'issued', createdAt: now().toISOString(), createdBy: principal.user.id,
        observationId: null, observationResult: null, capturedAt: null, deliveredAt: null }
      contracts?.assert('mobileops', mission, '#/$defs/mission', 'Созданное задание MobileOps не прошло проверку')
      await audit.append({ type: 'mobile.mission.issued', at: mission.createdAt, actor: principal.user.id, role: principal.user.role,
        missionId: mission.id, itemId: item.id, lineId, robotId: robot.id, checkpoint: mission.checkpoint })
      draft.missions.push(mission)
      return mission
    })
  }
  async function simulateObservation(missionId, input, principal) {
    requireOperator(principal)
    if (!['unable_to_assess', 'no_signs_detected'].includes(input?.result)) throw fail(422, 'Недопустимый результат наблюдения')
    return transaction(async draft => {
      const mission = draft.missions.find(row => row.id === missionId)
      if (!mission) throw fail(404, 'Задание не найдено')
      if (!scope(principal, mission.lineId)) throw fail(403, 'Задание вне доступной линии')
      if (mission.observationId) {
        if (mission.observationResult === input.result) return { mission, deliveryStatus: mission.status, duplicate: true }
        throw fail(409, 'Результат уже зафиксирован с другим содержимым')
      }
      const robot = requireRobot(draft, mission.robotId, principal)
      const source = context.get(mission.itemId)
      const stationBase = { 'CP-IN': 'ST-IN', 'CP-POST-MILL': 'ST-MILL', 'CP-FINAL': 'ST-ASSEMBLY' }[mission.checkpoint]
      const stationId = `${stationBase}${mission.lineId === 'LINE-02' ? '-02' : ''}`
      const occurredAt = now().toISOString()
      const eventId = `MOBILE-${mission.id}-1`
      const unable = input.result === 'unable_to_assess'
      const delivery = { delivery_id: `MOBILE-DLV-${mission.id}`, deliver_at: occurredAt,
        message: { event_id: eventId, event_type: 'inspection_result', schema_version: '2.0', occurred_at: occurredAt,
          source_id: 'MOBILE-EMU', item_id: mission.itemId, item_type_id: mission.itemTypeId, line_id: mission.lineId,
          station_id: stationId, shift_id: source?.shift_id ?? 'SHIFT-A', actor_id: robot.id,
          data: { inspection_point_id: mission.checkpoint, inspection_result: input.result, observation_quality: unable ? 'poor' : 'good',
            confidence: null, defects: [], method: 'mobile_visual_check', evidence_refs: [], triage_priority: unable ? 'high' : 'routine',
            capture_context: { source: 'mobile_robot_simulator', robot_id: robot.id, mission_id: mission.id, synthetic: true } } } }
      contracts?.assert('mobileops', delivery.message, '#/$defs/mobileObservation', 'Наблюдение MobileOps не прошло проверку')
      contracts?.assert('delivery', delivery, '', 'Доставка MobileOps не прошла проверку')
      await audit.append({ type: 'mobile.observation.captured', at: occurredAt, actor: robot.id, requestedBy: principal.user.id,
        missionId: mission.id, eventId, result: input.result, buffered: !robot.online })
      mission.observationId = eventId
      mission.observationResult = input.result
      mission.capturedAt = occurredAt
      if (robot.online) {
        const accepted = acceptDelivery(draft, delivery, occurredAt)
        mission.status = 'delivered'; mission.deliveredAt = accepted.delivery.receipt.accepted_at
        if (accepted.accepted) await audit.append({ type: 'mobile.observation.delivered', at: occurredAt, actor: robot.id,
          requestedBy: principal.user.id, missionId: mission.id, eventId, receiptStatus: 'accepted' })
      } else { mission.status = 'buffered'; draft.outbox.push(delivery) }
      return { mission, deliveryStatus: mission.status }
    })
  }
  async function setLink(robotId, online, principal) {
    requireOperator(principal)
    if (typeof online !== 'boolean') throw fail(422, 'Ожидается состояние online')
    return transaction(async draft => {
      const robot = requireRobot(draft, robotId, principal)
      await audit.append({ type: 'mobile.link.simulated', at: now().toISOString(), actor: principal.user.id, role: principal.user.role,
        robotId: robot.id, online })
      robot.online = online
      let flushed = 0
      if (online) {
        const waiting = draft.outbox.filter(row => row.message.actor_id === robot.id)
        for (const row of waiting) {
          const acceptedAt = now().toISOString()
          const accepted = acceptDelivery(draft, row, acceptedAt)
          if (accepted.accepted) {
            flushed += 1
            await audit.append({ type: 'mobile.observation.delivered', at: acceptedAt, actor: robot.id,
              requestedBy: principal.user.id, missionId: accepted.delivery.receipt.mission_id,
              eventId: accepted.delivery.receipt.event_id, receiptStatus: accepted.delivery.receipt.status })
          }
          const mission = draft.missions.find(entry => entry.observationId === row.message.event_id)
          if (mission) { mission.status = 'delivered'; mission.deliveredAt = accepted.delivery.receipt?.accepted_at ?? accepted.delivery.deliver_at }
        }
        draft.outbox = draft.outbox.filter(row => row.message.actor_id !== robot.id)
      }
      return { robot, flushed }
    })
  }
  const deliveredEvents = principal => state.deliveries.filter(row => scope(principal, row.message.line_id))
  async function handle(request, response, pathname, principal) {
    try {
      if (pathname === '/api/mobile/state' && request.method === 'GET') return send(response, 200, view(principal))
      if (pathname === '/api/mobile/events' && request.method === 'GET') return send(response, 200, { deliveries: deliveredEvents(principal) })
      if (pathname === '/api/mobile/missions' && request.method === 'POST') {
        const body = await readJsonObject(request)
        contracts?.assert('mobileops', body, '#/$defs/createMissionRequest', 'Задание MobileOps не соответствует контракту')
        return send(response, 200, { mission: await createMission(body, principal) })
      }
      const capture = /^\/api\/mobile\/missions\/([^/]+)\/simulate$/.exec(pathname)
      if (capture && request.method === 'POST') {
        const body = await readJsonObject(request)
        contracts?.assert('mobileops', body, '#/$defs/observationRequest', 'Результат MobileOps не соответствует контракту')
        return send(response, 200, await simulateObservation(capture[1], body, principal))
      }
      const link = /^\/api\/mobile\/robots\/([^/]+)\/link$/.exec(pathname)
      if (link && request.method === 'POST') {
        const body = await readJsonObject(request)
        contracts?.assert('mobileops', body, '#/$defs/linkRequest', 'Состояние связи не соответствует контракту')
        return send(response, 200, await setLink(link[1], body.online, principal))
      }
      send(response, 404, { error: 'Маршрут MobileOps не найден' })
    } catch (error) { send(response, error.status ?? 503, { error: error.status ? error.message : 'Операция MobileOps не выполнена' }) }
  }
  return { handle, view, deliveredEvents, createMission, simulateObservation, setLink }
}
