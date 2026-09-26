import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createAuditLog, createCrypto, createEncryptedStore, loadRootKey } from './security-crypto.mjs'
import { readJsonObject } from './contract-validator.mjs'

const roleForAction = {
  confirm: 'controller', confirm_hold: 'controller', additional: 'controller', reject: 'controller', accepted_within_spec: 'controller',
  recheck_fail: 'controller', release: 'controller', scrap: 'controller', controller_check: 'controller', manual_measurement: 'controller',
  master_complete: 'master', master_scrap: 'master', master_process_report: 'master', tech_allow: 'technologist', tech_deny: 'technologist', hypothesis: 'technologist', cause_confirm: 'technologist', cause_review_detailed: 'technologist', evidence_request: 'technologist',
}
const decisionForAction = { confirm: 'confirmed', confirm_hold: 'confirmed', additional: 'additional_check', reject: 'rejected', accepted_within_spec: 'accepted_within_spec', recheck_fail: 'confirmed', release: 'release_after_rework', scrap: 'scrap_approved' }
const dispositionForAction = { confirm: item => item === 'ITEM-015' ? 'quarantine' : 'rework', confirm_hold: () => 'hold', additional: () => 'hold', reject: () => 'release', accepted_within_spec: () => 'release', recheck_fail: () => 'rework', release: () => 'release', scrap: () => 'scrap' }
const sequenceForAction = (action, item, approved) => {
  if (action === 'confirm') return item === 'ITEM-015' ? ['inspection_result', 'quality_decision'] : ['quality_decision']
  if (action === 'reject') return item === 'ITEM-016' ? ['inspection_result', 'quality_decision'] : ['quality_decision']
  if (action === 'release') return item === 'ITEM-013' ? ['manual_measurement', 'inspection_result', 'quality_decision'] : ['inspection_result', 'quality_decision']
  if (action === 'recheck_fail') return ['inspection_result', 'quality_decision']
  if (['confirm_hold', 'additional', 'accepted_within_spec', 'scrap'].includes(action)) return ['quality_decision']
  if (['master_complete', 'master_scrap'].includes(action)) return ['master_action']
  if (action === 'manual_measurement') return ['manual_measurement']
  if (action === 'controller_check') return approved?.checkResult === 'signs_detected' && approved?.identified ? ['controller_check', 'inspection_result'] : ['controller_check']
  if (action === 'master_process_report') return ['master_process_report']
  if (action === 'evidence_request') return ['evidence_request']
  if (['tech_allow', 'tech_deny'].includes(action)) return ['technical_disposition']
  return ['cause_review']
}
const object = value => !!value && typeof value === 'object' && !Array.isArray(value)
const onlyKeys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key))
const strings = value => Array.isArray(value) && value.length <= 100 && value.every(part => typeof part === 'string' && part.length > 0 && part.length <= 200)
function validActionData(event, approved) {
  const d = event.data
  if (!object(d) || d.security_action_id !== approved.actionId) return false
  if (event.event_type === 'quality_decision') return onlyKeys(d, ['security_action_id', 'decision', 'disposition', 'finding_refs', 'reason', 'missing_photo_acknowledgement'])
    && d.decision === decisionForAction[approved.action] && d.disposition === dispositionForAction[approved.action](approved.itemId)
    && d.reason === approved.reason && strings(d.finding_refs)
    && (d.missing_photo_acknowledgement === undefined || approved.missingPhotoConfirmation?.acknowledged === true
      && d.missing_photo_acknowledgement.acknowledged === true
      && d.missing_photo_acknowledgement.observation_event_id === approved.missingPhotoConfirmation.observationEventId
      && d.missing_photo_acknowledgement.actor_id === approved.actor)
  if (event.event_type === 'technical_disposition') return onlyKeys(d, ['security_action_id', 'disposition', 'basis_event_ids', 'reason'])
    && d.disposition === (approved.action === 'tech_allow' ? 'rework_allowed' : 'rework_not_allowed')
    && d.reason === approved.reason && strings(d.basis_event_ids)
  if (event.event_type === 'cause_review') return approved.action === 'cause_review_detailed'
    ? onlyKeys(d, ['security_action_id', 'case_id', 'status', 'cause_type', 'finding_refs', 'basis_event_ids', 'reason', 'alternatives', 'missing_data', 'reviewed_event_ids'])
      && d.case_id === approved.caseId && ['hypothesis', 'confirmed', 'unknown'].includes(d.status)
      && typeof d.cause_type === 'string' && d.cause_type.length <= 128 && d.reason === approved.reason
      && typeof d.alternatives === 'string' && d.alternatives.length <= 4000
      && typeof d.missing_data === 'string' && d.missing_data.length <= 4000
      && strings(d.finding_refs) && strings(d.basis_event_ids) && strings(d.reviewed_event_ids)
      && (d.status !== 'confirmed' || d.basis_event_ids.length >= 2 && d.alternatives.trim().length >= 8)
    : onlyKeys(d, ['security_action_id', 'status', 'finding_refs', 'reason'])
      && d.status === (approved.action === 'cause_confirm' ? 'confirmed' : 'hypothesis')
      && d.reason === approved.reason && strings(d.finding_refs)
  if (event.event_type === 'evidence_request') return approved.action === 'evidence_request'
    && onlyKeys(d, ['security_action_id', 'case_id', 'recipient_role', 'reason', 'status', 'finding_refs'])
    && d.case_id === approved.caseId && d.recipient_role === approved.recipient && d.reason === approved.reason
    && d.status === 'open' && strings(d.finding_refs)
  if (event.event_type === 'master_process_report') return approved.action === 'master_process_report'
    && onlyKeys(d, ['security_action_id', 'case_id', 'request_id', 'fixture_condition', 'tool_condition', 'setup_changed', 'comment', 'reason', 'basis_event_ids'])
    && d.case_id === approved.caseId && d.reason === approved.reason && d.comment === approved.reason
    && (d.request_id === undefined || typeof d.request_id === 'string' && d.request_id.length <= 128)
    && ['checked', 'issue', 'unknown', 'not_applicable'].includes(d.fixture_condition)
    && ['checked', 'issue', 'unknown', 'not_applicable'].includes(d.tool_condition)
    && ['yes', 'no', 'unknown'].includes(d.setup_changed) && strings(d.basis_event_ids)
  if (event.event_type === 'master_action') return onlyKeys(d, ['security_action_id', 'action_type', 'workflow_status', 'evidence_refs', 'photo_uploaded_at', 'observation_quality', 'executor_id', 'rework_method', 'duration_minutes', 'actual_size_mm', 'paper_inspection', 'comment', 'reason'])
    && d.action_type === (approved.action === 'master_scrap' ? 'scrap_to_isolator' : approved.masterDetails ? 'rework_completed' : d.action_type)
    && ['rework_completed', 'inspection_support', 'scrap_to_isolator'].includes(d.action_type) && strings(d.evidence_refs)
    && d.workflow_status === (approved.action === 'master_scrap' ? 'SCRAP_ISOLATOR' : 'REVISION_READY')
    && d.executor_id === (approved.masterDetails?.operator ?? approved.actor) && d.comment === approved.reason && d.reason === approved.reason
    && d.rework_method === approved.masterDetails?.method && d.duration_minutes === approved.masterDetails?.durationMinutes
    && d.actual_size_mm === approved.masterDetails?.actualSizeMm && d.paper_inspection === (approved.masterDetails?.paperInspection ?? false)
    && (d.observation_quality === undefined || d.observation_quality === 'good')
    && (approved.includePhoto !== false || d.evidence_refs.length === 0)
  if (event.event_type === 'controller_check') return approved.action === 'controller_check'
    && onlyKeys(d, ['security_action_id', 'case_id', 'observation_event_id', 'inspection_result', 'finding_refs', 'basis_event_ids', 'reason'])
    && d.case_id === approved.caseId && d.inspection_result === approved.checkResult && d.reason === approved.reason
    && strings(d.finding_refs) && strings(d.basis_event_ids) && d.basis_event_ids.includes(d.observation_event_id)
  if (event.event_type === 'inspection_result') return onlyKeys(d, ['security_action_id', 'inspection_point_id', 'inspection_result', 'observation_quality', 'confidence', 'defects', 'method', 'evidence_refs', 'triage_priority', 'capture_context', 'basis_event_ids'])
    && (approved.action === 'controller_check' || d.inspection_point_id === 'CP-POST-MILL')
    && d.inspection_result === (approved.action === 'controller_check' ? approved.checkResult : ['release', 'reject'].includes(approved.action) ? 'no_signs_detected' : 'signs_detected')
    && d.observation_quality === 'good' && d.confidence === null && Array.isArray(d.defects) && d.defects.length <= 20
    && d.method === 'manual_verification' && strings(d.evidence_refs) && ['routine', 'high', 'critical', 'requires_review'].includes(d.triage_priority)
    && object(d.capture_context) && d.capture_context.source === 'manual_verification'
  if (event.event_type === 'manual_measurement') {
    if (!onlyKeys(d, ['security_action_id', 'case_id', 'basis_event_ids', 'feature_id', 'measured_value', 'unit', 'lower_limit', 'upper_limit', 'instrument_id', 'calibration_status', 'result', 'is_camera_measurement', 'reason', 'criteria_document', 'criteria_source'])) return false
    if (approved.action === 'release') return approved.itemId === 'ITEM-013' && d.feature_id === 'WALL-NEAR-RIGHT-HOLE'
      && d.measured_value === approved.measurement?.value && d.measured_value >= 5 && d.unit === 'mm' && d.lower_limit === 5
      && d.instrument_id === approved.measurement?.instrumentId && d.calibration_status === 'operator_confirmed'
      && d.result === 'within_assumed_limit' && d.is_camera_measurement === false
    const reading = approved.measurement
    return approved.action === 'manual_measurement' && d.case_id === approved.caseId && strings(d.basis_event_ids)
      && d.feature_id === reading?.parameter?.trim() && d.measured_value === reading?.value && d.unit === 'mm'
      && d.instrument_id === reading?.instrumentId?.trim() && d.calibration_status === 'operator_confirmed'
      && reading?.calibrated === true && d.is_camera_measurement === false
      && d.lower_limit === reading?.criteria?.lower && d.upper_limit === reading?.criteria?.upper
      && d.criteria_document === reading?.criteria?.document?.trim()
  }
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
  const demoMode = users === undefined
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
      if (pathname === '/api/security/demo-session' && request.method === 'POST') {
        if (!demoMode) throw fail(404, 'Демонстрационный режим недоступен')
        if (!sameOrigin(request) || !['127.0.0.1', '::1'].includes(sourceOf(request))) throw fail(403, 'Демонстрационный режим доступен только локально')
        await audit.verify()
        const body = await bodyOf(request)
        if (!onlyKeys(body, ['role']) || !demoRoles.includes(body.role)) throw fail(422, 'Неизвестная роль')
        const user = byId.get(`${body.role}-01`)
        const existing = String(request.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))
        if (existing) sessions.delete(createHash('sha256').update(existing.slice(cookieName.length + 1)).digest('hex'))
        const { token, session } = issueSession({ id: user.id, role: user.role, lineIds: user.lineIds }, sourceOf(request))
        await audit.append({ type: 'auth.demo_role_selected', at: new Date(now()).toISOString(), actor: user.id, role: user.role })
        send(response, 200, { authenticated: true, user: session.user, csrfToken: session.csrf }, { 'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` })
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
        if (!onlyKeys(body, ['itemId', 'action', 'reason', 'caseId', 'includePhoto', 'masterDetails', 'measurement', 'missingPhotoConfirmation', 'checkResult', 'identified', 'recipient'])) throw fail(422, 'Действие содержит неожиданные поля')
        const item = allItems.find(row => row.id === body.itemId)
        if (!item || !Object.hasOwn(roleForAction, body.action) || typeof body.reason !== 'string' || body.reason.trim().length < 5 || body.reason.length > 4000) throw fail(422, 'Некорректное действие или основание')
        if (body.caseId !== undefined && (typeof body.caseId !== 'string' || body.caseId.length > 128)
          || body.includePhoto !== undefined && typeof body.includePhoto !== 'boolean'
          || body.recipient !== undefined && (body.action !== 'evidence_request' || !['master', 'controller', 'mechanic', 'laboratory'].includes(body.recipient))
          || body.masterDetails !== undefined && (body.action !== 'master_complete' || !object(body.masterDetails) || !onlyKeys(body.masterDetails, ['method', 'operator', 'durationMinutes', 'actualSizeMm', 'paperInspection'])
            || typeof body.masterDetails.method !== 'string' || !body.masterDetails.method.trim() || body.masterDetails.method.length > 400
            || typeof body.masterDetails.operator !== 'string' || !body.masterDetails.operator.trim() || body.masterDetails.operator.length > 128
            || !Number.isFinite(body.masterDetails.durationMinutes) || body.masterDetails.durationMinutes <= 0
            || !Number.isFinite(body.masterDetails.actualSizeMm) || body.masterDetails.actualSizeMm < 0 || typeof body.masterDetails.paperInspection !== 'boolean')
          || body.measurement !== undefined && (!['release', 'manual_measurement'].includes(body.action) || !object(body.measurement))
          || body.missingPhotoConfirmation !== undefined && (!['confirm', 'confirm_hold'].includes(body.action) || !object(body.missingPhotoConfirmation)
            || !onlyKeys(body.missingPhotoConfirmation, ['observationEventId', 'acknowledged']) || body.missingPhotoConfirmation.acknowledged !== true
            || typeof body.missingPhotoConfirmation.observationEventId !== 'string')
          || body.checkResult !== undefined && (body.action !== 'controller_check' || !['signs_detected', 'no_signs_detected'].includes(body.checkResult))
          || body.identified !== undefined && (body.action !== 'controller_check' || !object(body.identified)
            || !onlyKeys(body.identified, ['defectTypeId', 'region', 'componentId']) || !['defectTypeId', 'region', 'componentId'].every(key => typeof body.identified[key] === 'string' && body.identified[key].length > 0 && body.identified[key].length <= 128))) throw fail(422, 'Некорректные параметры действия')
        if (['cause_review_detailed', 'evidence_request', 'master_process_report'].includes(body.action) && !body.caseId
          || body.action === 'evidence_request' && !body.recipient
          || body.action === 'controller_check' && (!body.caseId || !body.checkResult)
          || body.action === 'manual_measurement' && (!body.caseId || !Number.isFinite(body.measurement?.value) || body.measurement.value < 0
            || typeof body.measurement.parameter !== 'string' || !body.measurement.parameter.trim() || typeof body.measurement.instrumentId !== 'string' || !body.measurement.instrumentId.trim()
            || body.measurement.calibrated !== true || !onlyKeys(body.measurement, ['parameter', 'value', 'instrumentId', 'calibrated', 'criteria']))
          || body.action === 'release' && body.itemId === 'ITEM-013' && (!Number.isFinite(body.measurement?.value) || body.measurement.value < 5
            || typeof body.measurement.instrumentId !== 'string' || !body.measurement.instrumentId.trim() || body.measurement.calibrationConfirmed !== true)) throw fail(422, 'Некорректный замер или очная проверка')
        if (roleForAction[body.action] !== session.user.role || !session.user.lineIds.includes(itemLines.get(item.id))) {
          await logDenied(request, 'action_or_line_forbidden', session); throw fail(403, 'Действие недоступно для роли или линии')
        }
        const actionId = randomUUID()
        const record = { type: 'action.approved', at: new Date(now()).toISOString(), actionId, actor: session.user.id, role: session.user.role,
          itemId: item.id, lineId: itemLines.get(item.id), action: body.action, reason: body.reason.trim(), caseId: body.caseId ?? null,
          includePhoto: body.includePhoto, masterDetails: body.masterDetails, measurement: body.measurement,
          missingPhotoConfirmation: body.missingPhotoConfirmation, checkResult: body.checkResult, identified: body.identified, recipient: body.recipient }
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
        const sequence = approved && sequenceForAction(approved.action, approved.itemId, approved)
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
            || !onlyKeys(e, ['event_id', 'event_type', 'schema_version', 'occurred_at', 'source_id', 'item_id', 'item_type_id', 'line_id', 'station_id', 'shift_id', 'actor_id', 'operation_run_id', 'equipment_id', 'item_state', 'data'])
            || e.equipment_id !== undefined && e.event_type !== 'master_process_report'
            || e.item_state !== undefined && (!object(e.item_state) || !onlyKeys(e.item_state, ['physical_location', 'line_lock_status'])
              || typeof e.item_state.physical_location !== 'string' || e.item_state.physical_location.length > 256
              || !['HELD_AT_STATION', 'IN_BUFFER', 'ROUTED_FORWARD'].includes(e.item_state.line_lock_status))
            || e.event_type === 'quality_decision' && (e.item_state?.line_lock_status !== (e.data.disposition === 'release' ? 'ROUTED_FORWARD' : 'HELD_AT_STATION')
              || e.item_state.physical_location !== (e.data.disposition === 'release' ? 'Передана на следующую операцию маршрута' : `${e.station_id}: зона удержания ОТК`))
            || e.event_type === 'master_action' && (e.item_state?.line_lock_status !== 'IN_BUFFER'
              || e.item_state.physical_location !== `${e.station_id}: межоперационный буфер`)
            || !['quality_decision', 'master_action'].includes(e.event_type) && e.item_state !== undefined
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
