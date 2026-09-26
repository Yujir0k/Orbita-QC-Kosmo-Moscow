import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createAuditLog, createCrypto, createEncryptedStore, loadRootKey } from './security-crypto.mjs'
import { readJsonObject } from './contract-validator.mjs'

const roleForAction = {
  confirm: 'controller', additional: 'controller', reject: 'controller', recheck_fail: 'controller', release: 'controller', scrap: 'controller',
  master_complete: 'master', tech_allow: 'technologist', tech_deny: 'technologist', hypothesis: 'technologist', cause_confirm: 'technologist',
}
const decisionForAction = { confirm: 'confirmed', additional: 'additional_check', reject: 'rejected', recheck_fail: 'confirmed', release: 'release_after_rework', scrap: 'scrap_approved' }
const dispositionForAction = { confirm: item => item === 'ITEM-015' ? 'quarantine' : 'rework', additional: () => 'hold', reject: () => 'release', recheck_fail: () => 'rework', release: () => 'release', scrap: () => 'scrap' }
const sequenceForAction = (action, item) => {
  if (action === 'confirm') return item === 'ITEM-015' ? ['inspection_result', 'quality_decision'] : ['quality_decision']
  if (action === 'reject') return item === 'ITEM-016' ? ['inspection_result', 'quality_decision'] : ['quality_decision']
  if (action === 'release') return item === 'ITEM-013' ? ['manual_measurement', 'inspection_result', 'quality_decision'] : ['inspection_result', 'quality_decision']
  if (action === 'recheck_fail') return ['inspection_result', 'quality_decision']
  if (['additional', 'scrap'].includes(action)) return ['quality_decision']
  if (action === 'master_complete') return ['master_action']
  if (['tech_allow', 'tech_deny'].includes(action)) return ['technical_disposition']
  return ['cause_review']
}
const object = value => !!value && typeof value === 'object' && !Array.isArray(value)
const onlyKeys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key))
const strings = value => Array.isArray(value) && value.length <= 100 && value.every(part => typeof part === 'string' && part.length > 0 && part.length <= 200)
function validActionData(event, approved) {
  const d = event.data
  if (!object(d) || d.security_action_id !== approved.actionId) return false
  if (event.event_type === 'quality_decision') return onlyKeys(d, ['security_action_id', 'decision', 'disposition', 'finding_refs', 'reason'])
    && d.decision === decisionForAction[approved.action] && d.disposition === dispositionForAction[approved.action](approved.itemId)
    && d.reason === approved.reason && strings(d.finding_refs)
  if (event.event_type === 'technical_disposition') return onlyKeys(d, ['security_action_id', 'disposition', 'basis_event_ids', 'reason'])
    && d.disposition === (approved.action === 'tech_allow' ? 'rework_allowed' : 'rework_not_allowed')
    && d.reason === approved.reason && strings(d.basis_event_ids)
  if (event.event_type === 'cause_review') return onlyKeys(d, ['security_action_id', 'status', 'finding_refs', 'reason'])
    && d.status === (approved.action === 'cause_confirm' ? 'confirmed' : 'hypothesis')
    && d.reason === approved.reason && strings(d.finding_refs)
  if (event.event_type === 'master_action') return onlyKeys(d, ['security_action_id', 'action_type', 'evidence_refs', 'observation_quality', 'executor_id', 'comment', 'reason'])
    && ['rework_completed', 'inspection_support'].includes(d.action_type) && strings(d.evidence_refs)
    && d.executor_id === approved.actor && d.comment === approved.reason && d.reason === approved.reason
    && (d.observation_quality === undefined || d.observation_quality === 'good')
  if (event.event_type === 'inspection_result') return onlyKeys(d, ['security_action_id', 'inspection_point_id', 'inspection_result', 'observation_quality', 'confidence', 'defects', 'method', 'evidence_refs', 'triage_priority', 'capture_context'])
    && d.inspection_point_id === 'CP-POST-MILL' && d.inspection_result === (['release', 'reject'].includes(approved.action) ? 'no_signs_detected' : 'signs_detected')
    && d.observation_quality === 'good' && d.confidence === null && Array.isArray(d.defects) && d.defects.length <= 20
    && d.method === 'manual_verification' && strings(d.evidence_refs) && ['routine', 'high', 'critical'].includes(d.triage_priority)
    && object(d.capture_context) && d.capture_context.source === 'manual_verification'
  if (event.event_type === 'manual_measurement') return onlyKeys(d, ['security_action_id', 'feature_id', 'measured_value', 'unit', 'lower_limit', 'instrument_id', 'calibration_status', 'result', 'is_camera_measurement', 'reason'])
    && approved.action === 'release' && approved.itemId === 'ITEM-013' && d.feature_id === 'WALL-NEAR-RIGHT-HOLE'
    && d.measured_value === 5.12 && d.unit === 'mm' && d.lower_limit === 5 && d.instrument_id === 'GAGE-01'
    && d.calibration_status === 'valid_in_demo' && d.result === 'within_assumed_limit' && d.is_camera_measurement === false
    && d.reason === 'Ручной замер прибором: 5,12 мм при минимуме 5,0 мм.'
  return false
}
const demoRoles = ['controller', 'master', 'technologist', 'leader', 'administrator']
const canonical = value => JSON.stringify(value, (_key, part) => part && typeof part === 'object' && !Array.isArray(part) ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part)
const send = (response, status, body, headers = {}) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers })
  response.end(JSON.stringify(body))
}
const fail = (status, message) => Object.assign(new Error(message), { status })
function permission(pathname, method) {
  if (method === 'GET' && pathname === '/api/contracts') return ['administrator']
  if (method === 'GET' && pathname === '/api/operations/health') return ['administrator']
  if (method === 'GET' && pathname === '/api/operations/backups') return ['administrator']
  if (method === 'POST' && pathname === '/api/operations/backups') return ['administrator']
  if (method === 'GET' && pathname === '/api/integrations/state') return ['administrator']
  if (method === 'POST' && /^\/api\/integrations\/(pull|results|cad|retry\/[^/]+)$/.test(pathname)) return ['administrator']
  if (method === 'GET' && pathname === '/api/plant/state') return ['administrator']
  if (method === 'GET' && pathname === '/api/plant/mes/configured') return demoRoles
  if (method === 'POST' && pathname === '/api/plant/mes/sync') return demoRoles
  if (method === 'POST' && pathname === '/api/plant/mes/decisions') return ['controller']
  if (method === 'POST' && /^\/api\/plant\/mes\/retry\/[^/]+$/.test(pathname)) return ['administrator']
  if (method === 'POST' && pathname === '/api/plant/cad/pull') return ['administrator']
  if (method === 'GET' && pathname === '/api/mobile/events') return demoRoles
  if (method === 'GET' && pathname === '/api/mobile/state') return ['master', 'administrator']
  if (method === 'POST' && pathname === '/api/mobile/missions') return ['master', 'administrator']
  if (method === 'POST' && /^\/api\/mobile\/missions\/[^/]+\/simulate$/.test(pathname)) return ['master', 'administrator']
  if (method === 'POST' && /^\/api\/mobile\/robots\/[^/]+\/link$/.test(pathname)) return ['master', 'administrator']
  return []
}

export async function createSecurity({ directory, rootKey, auditFile, users, items, itemLineMap, contracts, now = () => Date.now() }) {
  const bodyOf = request => readJsonObject(request, { maxBytes: 1_000_000 })
  const loadedRootKey = await loadRootKey(directory, rootKey)
  const crypto = createCrypto(loadedRootKey)
  const keyFingerprint = createHash('sha256').update(loadedRootKey).digest('hex').slice(0, 16)
  let rotationMetadata = null
  try { rotationMetadata = JSON.parse(await readFile(path.join(directory, 'data', 'security', 'key-rotation.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const store = createEncryptedStore(crypto)
  const audit = await createAuditLog(auditFile ?? path.join(directory, 'data', 'security', 'audit.jsonl'), crypto)
  const demo = items ? null : JSON.parse(await readFile(path.join(directory, 'source', 'src', 'demo-data.json'), 'utf8'))
  const itemLines = new Map(Object.entries(itemLineMap ?? {}))
  for (const row of demo?.source ?? []) if (row.message?.item_id && row.message?.line_id) itemLines.set(row.message.item_id, row.message.line_id)
  const allItems = items ?? demo?.items ?? []
  const allLines = [...new Set((demo?.catalogs?.lines ?? []).map(row => row.id))]
  const accounts = users ?? demoRoles.map(role => ({ id: `${role}-01`, role, lineIds: allLines }))
  const byId = new Map(accounts.map(user => [user.id, { ...user, lineIds: user.lineIds ?? allLines }]))
  const sessions = new Map()
  const internalToken = randomBytes(32).toString('base64url')
  const loginFailures = new Map()
  const actions = new Map()
  const completed = new Map()
  for (const row of audit.entries()) {
    if (row.event.type === 'action.approved') actions.set(row.event.actionId, row.event)
    if (row.event.type === 'action.completed') completed.set(row.event.actionId, row.event.deliveries)
  }
  const cookieName = 'orbita_session'
  const sourceOf = request => String(request.socket?.remoteAddress ?? 'local').replace(/^::ffff:/, '')
  const purgeSessions = () => {
    for (const [tokenHash, session] of sessions) if (session.expiresAt < now() || session.idleUntil < now()) sessions.delete(tokenHash)
  }
  const sessionOf = request => {
    const cookie = String(request.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))
    if (!cookie) return null
    const token = cookie.slice(cookieName.length + 1)
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const session = sessions.get(tokenHash)
    if (!session || session.expiresAt < now() || session.idleUntil < now()) { if (session) sessions.delete(tokenHash); return null }
    session.lastSeenAt = now(); session.idleUntil = now() + 30 * 60_000
    return session
  }
  const sameOrigin = request => {
    const origin = request.headers.origin
    if (!origin) return true // CLI clients still need a session and CSRF token.
    try { return new URL(origin).host === request.headers.host && new URL(origin).protocol === 'http:' } catch { return false }
  }
  const validCsrf = (request, session) => session && sameOrigin(request) && crypto.constantTimeEqual(String(request.headers['x-csrf-token'] ?? ''), session.csrf)
  const logDenied = async (request, reason, session) => {
    if (request.method !== 'GET') await audit.append({ type: 'access.denied', at: new Date(now()).toISOString(), actor: session?.user.id ?? 'anonymous', role: session?.user.role ?? null, path: new URL(request.url, 'http://localhost').pathname, reason })
  }
  const requireSession = async (request, response, roles = demoRoles) => {
    const session = sessionOf(request)
    if (!session) { await logDenied(request, 'unauthenticated', null); send(response, 401, { error: 'Требуется вход' }); return null }
    if (!roles.includes(session.user.role)) { await logDenied(request, 'forbidden_role', session); send(response, 403, { error: 'Недостаточно прав' }); return null }
    if (request.method !== 'GET' && request.method !== 'HEAD' && !validCsrf(request, session)) {
      await logDenied(request, 'invalid_csrf_or_origin', session); send(response, 403, { error: 'Неверный CSRF-токен или источник запроса' }); return null
    }
    return session
  }
  const issueSession = (user, source) => {
    const token = randomBytes(32).toString('base64url')
    const session = { id: randomUUID(), user, csrf: randomBytes(32).toString('base64url'), source, createdAt: now(), lastSeenAt: now(), expiresAt: now() + 8 * 60 * 60_000, idleUntil: now() + 30 * 60_000 }
    sessions.set(createHash('sha256').update(token).digest('hex'), session)
    return { token, session }
  }
  const failureBucket = key => loginFailures.get(key) ?? { count: 0, until: 0 }
  const recordFailure = (key, limit, lockMs) => {
    const bucket = failureBucket(key)
    bucket.count += 1
    if (bucket.count >= limit) bucket.until = now() + lockMs
    loginFailures.set(key, bucket)
    return bucket
  }
  async function handle(request, response, pathname) {
    if (!pathname.startsWith('/api/security/')) return false
    try {
      if (pathname === '/api/security/session' && request.method === 'GET') {
        const session = sessionOf(request)
        send(response, 200, session ? { authenticated: true, user: session.user, csrfToken: session.csrf } : { authenticated: false })
        return true
      }
      if (pathname === '/api/security/login' && request.method === 'POST') {
        if (!sameOrigin(request)) throw fail(403, 'Недоверенный источник запроса')
        await audit.verify()
        const body = await bodyOf(request)
        if (!onlyKeys(body, ['id', 'password'])) throw fail(422, 'Запрос входа содержит неожиданные поля')
        const id = typeof body.id === 'string' ? body.id : ''
        const password = typeof body.password === 'string' ? body.password : ''
        const source = sourceOf(request)
        const accountKey = `account:${id}`
        const sourceKey = `source:${source}`
        const retryAt = Math.max(failureBucket(accountKey).until, failureBucket(sourceKey).until)
        if (retryAt > now()) throw Object.assign(fail(429, 'Слишком много попыток входа'), { headers: { 'Retry-After': String(Math.max(1, Math.ceil((retryAt - now()) / 1000))) } })
        const user = byId.get(id)
        const expected = user?.password ?? crypto.accountSecret(id)
        if (!user || !crypto.constantTimeEqual(password, expected)) {
          recordFailure(accountKey, 5, 60_000); recordFailure(sourceKey, 12, 5 * 60_000)
          await audit.append({ type: 'auth.failed', at: new Date(now()).toISOString(), actor: id || 'unknown', source })
          throw fail(401, 'Неверные учётные данные')
        }
        loginFailures.delete(accountKey)
        const { token, session } = issueSession({ id: user.id, role: user.role, lineIds: user.lineIds }, source)
        await audit.append({ type: 'auth.login', at: new Date(now()).toISOString(), actor: user.id, role: user.role })
        send(response, 200, { authenticated: true, user: session.user, csrfToken: session.csrf }, { 'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` })
        return true
      }
      if (pathname === '/api/security/logout' && request.method === 'POST') {
        const session = await requireSession(request, response)
        if (!session) return true
        const cookie = String(request.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))
        if (cookie) sessions.delete(createHash('sha256').update(cookie.slice(cookieName.length + 1)).digest('hex'))
        await audit.append({ type: 'auth.logout', at: new Date(now()).toISOString(), actor: session.user.id, role: session.user.role })
        send(response, 200, { status: 'ok' }, { 'Set-Cookie': `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` })
        return true
      }
      if (pathname === '/api/security/sessions' && request.method === 'GET') {
        const session = await requireSession(request, response, ['administrator'])
        if (!session) return true
        purgeSessions()
        send(response, 200, { sessions: [...sessions.values()].map(value => ({ id: value.id, user: value.user, source: value.source, createdAt: new Date(value.createdAt).toISOString(), lastSeenAt: new Date(value.lastSeenAt).toISOString(), expiresAt: new Date(value.expiresAt).toISOString(), current: value.id === session.id })) })
        return true
      }
      if (pathname === '/api/security/sessions/revoke' && request.method === 'POST') {
        const session = await requireSession(request, response, ['administrator'])
        if (!session) return true
        const body = await bodyOf(request)
        if (!onlyKeys(body, ['sessionId']) || typeof body.sessionId !== 'string') throw fail(422, 'Укажите сеанс')
        const target = [...sessions].find(([, value]) => value.id === body.sessionId)
        if (!target) throw fail(404, 'Сеанс уже завершён')
        sessions.delete(target[0])
        await audit.append({ type: 'auth.session_revoked', at: new Date(now()).toISOString(), actor: session.user.id, role: session.user.role, target: target[1].user.id, sessionId: body.sessionId })
        send(response, 200, { status: 'revoked', sessionId: body.sessionId, current: body.sessionId === session.id })
        return true
      }
      if (pathname === '/api/security/crypto/status' && request.method === 'GET') {
        const session = await requireSession(request, response, ['administrator'])
        if (!session) return true
        send(response, 200, { fingerprint: keyFingerprint, profile: 'AES-256-GCM', rotation: rotationMetadata, mode: 'offline' })
        return true
      }
      if (pathname === '/api/security/actions' && request.method === 'POST') {
        const session = await requireSession(request, response)
        if (!session) return true
        await audit.verify()
        const body = await bodyOf(request)
        if (!onlyKeys(body, ['itemId', 'action', 'reason', 'caseId'])) throw fail(422, 'Действие содержит неожиданные поля')
        const item = allItems.find(row => row.id === body.itemId)
        if (!item || !Object.hasOwn(roleForAction, body.action) || typeof body.reason !== 'string' || body.reason.trim().length < 5 || body.reason.length > 4000) throw fail(422, 'Некорректное действие или основание')
        if (roleForAction[body.action] !== session.user.role || !session.user.lineIds.includes(itemLines.get(item.id))) {
          await logDenied(request, 'action_or_line_forbidden', session); throw fail(403, 'Действие недоступно для роли или линии')
        }
        const actionId = randomUUID()
        const record = { type: 'action.approved', at: new Date(now()).toISOString(), actionId, actor: session.user.id, role: session.user.role,
          itemId: item.id, lineId: itemLines.get(item.id), action: body.action, reason: body.reason.trim(), caseId: body.caseId ?? null }
        await audit.append(record); actions.set(actionId, record)
        send(response, 200, { actionId, actorId: session.user.id, role: session.user.role })
        return true
      }
      if (pathname === '/api/security/actions/complete' && request.method === 'POST') {
        const session = await requireSession(request, response)
        if (!session) return true
        await audit.verify()
        const body = await bodyOf(request)
        if (!onlyKeys(body, ['actionId', 'deliveries'])) throw fail(422, 'Подтверждение действия содержит неожиданные поля')
        const approved = actions.get(body.actionId)
        const sequence = approved && sequenceForAction(approved.action, approved.itemId)
        if (!approved || approved.actor !== session.user.id || completed.has(body.actionId) || !Array.isArray(body.deliveries) || body.deliveries.length !== sequence.length) throw fail(409, 'Нет ожидающего подтверждения действия')
        const ids = new Set()
        const deliveryIds = new Set()
        for (const [index, row] of body.deliveries.entries()) {
          contracts?.assert('delivery', row, '', 'Запись действия не соответствует контракту')
          const e = row?.message
          const item = allItems.find(value => value.id === approved.itemId)
          if (typeof row?.delivery_id !== 'string' || !row.delivery_id.startsWith('UI-DLV-') || deliveryIds.has(row.delivery_id) || Number.isNaN(Date.parse(row.deliver_at)) || !object(e)
            || e.event_id !== `UI-${body.actionId}-${index + 1}` || ids.has(e.event_id) || e.event_type !== sequence[index]
            || e.item_id !== approved.itemId || e.item_type_id !== item?.item_type_id || e.line_id !== approved.lineId || !e.station_id || !e.shift_id
            || Number.isNaN(Date.parse(e.occurred_at)) || e.schema_version !== '2.0' || e.actor_id !== approved.actor || e.source_id !== 'ORBITA-UI'
            || !onlyKeys(e, ['event_id', 'event_type', 'schema_version', 'occurred_at', 'source_id', 'item_id', 'item_type_id', 'line_id', 'station_id', 'shift_id', 'actor_id', 'operation_run_id', 'data'])
            || !validActionData(e, approved)) throw fail(422, 'Событие не соответствует разрешённому действию')
          if (e.event_type === 'quality_decision') contracts?.assert('decision', e, '', 'Решение контролёра не соответствует контракту')
          ids.add(e.event_id)
          deliveryIds.add(row.delivery_id)
        }
        await audit.append({ type: 'action.completed', at: new Date(now()).toISOString(), actionId: body.actionId, actor: session.user.id, role: session.user.role, deliveries: body.deliveries })
        completed.set(body.actionId, body.deliveries)
        send(response, 200, { status: 'recorded', actionId: body.actionId })
        return true
      }
      if (pathname === '/api/security/events' && request.method === 'GET') {
        const session = await requireSession(request, response)
        if (!session) return true
        await audit.verify()
        send(response, 200, { deliveries: [...completed.values()].flat().filter(row => session.user.lineIds.includes(row.message.line_id)) })
        return true
      }
      if (pathname === '/api/security/audit' && request.method === 'GET') {
        const session = await requireSession(request, response, ['administrator'])
        if (!session) return true
        await audit.verify()
        send(response, 200, { entries: audit.entries().map(row => ({ seq: row.seq, mac: row.mac, ...row.event, deliveries: undefined })) })
        return true
      }
      if (pathname === '/api/security/verify' && request.method === 'GET') {
        const session = await requireSession(request, response, ['administrator'])
        if (!session) return true
        send(response, 200, await audit.verify())
        return true
      }
      send(response, 404, { error: 'Неизвестный маршрут безопасности' })
    } catch (error) {
      send(response, error.status ?? 503, { error: error.status ? error.message : 'Проверка безопасности не выполнена' }, error.headers)
    }
    return true
  }
  async function guard(request, response, pathname) {
    if (pathname.startsWith('/api/emulator/')) {
      if (crypto.constantTimeEqual(String(request.headers['x-orbita-internal'] ?? ''), internalToken)) return { internal: true }
      send(response, 403, { error: 'Внутренний маршрут эмулятора' }); return null
    }
    const allowed = permission(pathname, request.method)
    if (!allowed.length) { send(response, 404, { error: 'Неизвестный маршрут API' }); return null }
    const session = await requireSession(request, response, allowed)
    if (!session) return null
    if (pathname === '/api/mobile/events' || pathname === '/api/mobile/state') {
      try { await audit.verify() }
      catch { send(response, 503, { error: 'Журнал аудита недоступен; состояние MobileOps не выдаётся' }); return null }
    }
    if (request.method !== 'GET') {
      try { await audit.verify(); await audit.append({ type: 'api.request', at: new Date(now()).toISOString(), actor: session.user.id, role: session.user.role, path: pathname }) }
      catch { send(response, 503, { error: 'Журнал аудита недоступен; операция остановлена' }); return null }
    }
    return session
  }
  return {
    store, audit, handle, guard, internalToken,
    sessionStatus: () => { purgeSessions(); return { active: sessions.size, expiresAfterHours: 8, idleMinutes: 30 } },
    cryptoStatus: () => ({ fingerprint: keyFingerprint, profile: 'AES-256-GCM', rotation: rotationMetadata, mode: 'offline' }),
    demoCredentials: () => accounts.filter(user => !user.password).map(user => ({ id: user.id, role: user.role, password: crypto.accountSecret(user.id) })),
    validateMesDecision: event => {
      const actionId = event?.data?.security_action_id
      const approved = actions.get(actionId)
      return !!(approved && completed.has(actionId) && approved.role === 'controller' && approved.itemId === event.item_id && approved.lineId === event.line_id && approved.actor === event.actor_id
        && Object.hasOwn(decisionForAction, approved.action) && decisionForAction[approved.action] === event.data.decision
        && completed.get(actionId).some(row => canonical(row.message) === canonical(event)))
    },
  }
}
