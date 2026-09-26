import { approveExecutive } from './executive.mjs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createDatabase, transaction, lock } from './db.mjs';
import { loadCrypto, digest } from './crypto.mjs';
import { createRepository, fail } from './repository.mjs';
import { createAuth, roles } from './auth.mjs';
import { createWorkflow, domain } from './workflow.mjs';
import { getMedia, putMedia } from './media.mjs';
import { withAdapters } from './adapters.mjs';
import { dispatchOne, synchronizePlant } from './worker.mjs';
import { erpQualityStatus } from './integration-policy.mjs';
import { createContractRegistry, readJsonObject } from '../../contract-validator.mjs';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const crypto = await loadCrypto(process.env.KEYRING_FILE);
const pool = await createDatabase();
const mediaPool = await createDatabase('MEDIA_DB');
process.env.EMULATOR_TOKEN = (await readFile(process.env.EMULATOR_TOKEN_FILE, 'utf8')).trim();
const repo = createRepository(crypto);
const auth = createAuth(repo, crypto);
const contracts = await createContractRegistry(directory);
const workflow = createWorkflow(repo, crypto, contracts);
const startedAt = Date.now();
let requests = 0, errors = 0, active = 0, stopping = false;

async function bootstrap(client, user) {
  const dataset = structuredClone((await repo.get(client, 'system', 'dataset')).value);
  const deliveries = await repo.history(client, { lines: user.lineIds });
  const ids = new Set(deliveries.map(row => row.message.item_id));
  dataset.items = dataset.items.filter(row => ids.has(row.id));
  const uploads = (await client.query("SELECT id,payload FROM documents WHERE namespace='media-reference'")).rows.map(row => crypto.open(row.payload, `document:media-reference:${row.id}`));
  dataset.media = [...dataset.media, ...uploads].filter(row => ids.has(row.item_id));
  dataset.catalogs.lines = dataset.catalogs.lines.filter(row => user.lineIds.includes(row.id));
  const prefs = await client.query("SELECT id,payload,revision FROM documents WHERE namespace='preferences' AND id LIKE $1", [user.id + ':%']);
  const preferences = Object.fromEntries(prefs.rows.map(row => [row.id.slice(user.id.length + 1), { value: crypto.open(row.payload, `document:preferences:${row.id}`), revision: Number(row.revision) }]));
  return { dataset, deliveries, preferences, revisions: Object.fromEntries([...ids].map(id => [id, digest(deliveries.filter(row => row.message.item_id === id).map(row => row.message))])) };
}

async function backup(client, user) {
  await lock(client, 'backup');
  const tables = ['documents','stream_heads','journal','events','ingest_receipts','commands','outbox'];
  const snapshots = {};
  await transaction(pool, async snapshot => {
    await snapshot.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await repo.verify(snapshot);
    for (const table of tables) snapshots[table] = (await snapshot.query(`SELECT * FROM ${table}`)).rows;
  });
  const media = (await mediaPool.query('SELECT * FROM media')).rows;
  const backupId = randomUUID(), createdAt = new Date().toISOString();
  const data = JSON.stringify({ format: 'orbita-db-backup-v1', backupId, createdAt, tables: snapshots, media });
  const bytes = Buffer.from(data), filename = `${backupId}.json`;
  await mkdir('/backups', { recursive: true });
  await writeFile(`/backups/${filename}`, bytes, { mode: 0o600, flag: 'wx' });
  if (digest(await readFile(`/backups/${filename}`)) !== digest(bytes)) throw fail(503, 'Проверка копии не пройдена');
  const result = { backupId, createdAt, verifiedAt: new Date().toISOString(), filename, bytes: bytes.length, files: tables.length + 1, sha256: digest(bytes) };
  await repo.put(client, 'system', 'backup', result);
  await repo.append(client, 'security', { type: 'backup.verified', actor: user.id, ...result });
  return result;
}

async function route(client, request, url, body) {
  const pathname = url.pathname, method = request.method;
  if (pathname === '/api/config') return { production: true, authentication: process.env.DEMO_MODE === 'true' ? 'demo' : 'password', dataset: 'synthetic' };
  if (pathname === '/api/security/demo-session' && method === 'POST') return auth.demoSession(client, body);
  if (pathname === '/api/security/login' && method === 'POST') return auth.login(client, request, body);
  const session = await auth.session(client, request);
  if (pathname === '/api/security/session' && method === 'GET') return session ? { authenticated: true, user: session.user, csrfToken: session.csrfToken, production: true } : { authenticated: false, production: true };
  const user = auth.require(request, session);
  if (await auth.limited(client, `api:${user.id}`, 3000, 60)) return { status: 429, body: { error: 'Лимит запросов превышен' } };
  if (pathname === '/api/security/logout' && method === 'POST') {
    await client.query('DELETE FROM sessions WHERE token_hash=$1', [session.hash]);
    await repo.append(client, 'security', { type: 'auth.logout', actor: user.id, at: new Date().toISOString() });
    return { status: 200, body: { status: 'logged_out' }, headers: { 'Set-Cookie': 'orbita_session=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' } };
  }
  if (pathname === '/api/data/bootstrap' && method === 'GET') return bootstrap(client, user);
  if (pathname === '/api/security/events' && method === 'GET') {
    const head = await client.query('SELECT count(*)::text AS count,max(received_at)::text AS latest FROM events WHERE line_id=ANY($1)', [user.lineIds]);
    const uploads = await client.query("SELECT count(*)::text AS count,max(updated_at)::text AS latest FROM documents WHERE namespace='media-reference'");
    const cursor = digest({ head: head.rows, uploads: uploads.rows, lines: user.lineIds });
    if (url.searchParams.get('cursor') === cursor) return { unchanged: true, cursor, authoritative: true };
    const data = await bootstrap(client, user);
    return { deliveries: data.deliveries, revisions: data.revisions, media: data.dataset.media, cursor, authoritative: true };
  }
  if (pathname === '/api/workflow/commands' && method === 'POST') return workflow(client, user, body, request.headers['idempotency-key']);
  if (pathname === '/api/events/ingest' && method === 'POST') {
    auth.require(request, session, ['administrator']);
    const rows = Array.isArray(body.deliveries) ? body.deliveries : [];
    if (!rows.length || rows.length > 200) throw fail(422, 'Передайте от 1 до 200 событий');
    const outcomes = [];
    for (const row of rows) {
      const validate = row => {
        try { contracts.assert('delivery', row); } catch (error) { return error.message; }
        return !user.lineIds.includes(row.message.line_id) ? 'Линия недоступна' : domain.validateDelivery(row);
      };
      outcomes.push(await repo.ingest(client, row, validate, { actor: user.id }));
    }
    await repo.append(client, 'ingestion', { type: 'batch.received', actor: user.id, outcomes, at: new Date().toISOString() });
    return { outcomes };
  }
  if (pathname === '/api/events/receipts' && method === 'GET') {
    auth.require(request, session, ['administrator']);
    const result = await client.query('SELECT payload FROM ingest_receipts ORDER BY id DESC LIMIT 100');
    const totals = await client.query('SELECT outcome,count(*)::integer AS count FROM ingest_receipts GROUP BY outcome');
    return { outcomes: result.rows.map(row => crypto.open(row.payload, 'ingest-receipt').result), counts: Object.fromEntries(totals.rows.map(row => [row.outcome,row.count])) };
  }
  if (pathname === '/api/media' && method === 'POST') {
    auth.require(request, session, ['master','controller','administrator']);
    if (typeof body.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) throw fail(422, 'Ожидается изображение base64');
    const history = await repo.history(client, { item: body.itemId, lines: user.lineIds });
    if (!history.length) throw fail(404, 'Изделие недоступно');
    const bytes = Buffer.from(body.data, 'base64');
    if (bytes.length > 12 * 1024 * 1024) throw fail(413, 'Лимит загрузки 12 МиБ');
    const hash = digest(bytes), id = `UPLOAD-${digest({ item: body.itemId, hash })}`;
    const filename = `${id}.${({ 'image/png':'png', 'image/jpeg':'jpg', 'image/webp':'webp' })[body.contentType] ?? 'invalid'}`;
    await transaction(mediaPool, mc => putMedia(mc, crypto, { id, item: body.itemId, line: history[0].message.line_id, filename, bytes, contentType: body.contentType }));
    const asset = { asset_id: id, item_id: body.itemId, path_from_quality_dataset: `media/${filename}`, sha256: hash,
      capture_source: 'manual_upload', stage: 'after_rework', description: `Материал ${body.itemId}, загрузил ${user.id}`,
      synthetic_generated_image: false, not_a_measurement_or_authentic_production_record: true };
    await repo.put(client, 'media-reference', id, asset);
    await repo.append(client, `item:${body.itemId}`, { type: 'media.uploaded', actor: user.id, assetId: id, sha256: hash, at: new Date().toISOString() });
    return { asset };
  }
  if (pathname.startsWith('/media/') && method === 'GET') {
    const media = await getMedia(mediaPool, crypto, path.basename(pathname), user.lineIds);
    return { status: 200, binary: media.bytes, headers: { 'Content-Type': media.type, 'X-Content-SHA256': media.hash } };
  }
  if (pathname === '/api/executive/approvals') {
    auth.require(request, session, ['leader']);
    if (method === 'POST') await approveExecutive(client, repo, user, body.actionId);
    const rows = (await client.query("SELECT id,payload FROM documents WHERE namespace='executive' ORDER BY id")).rows;
    return { approvals: rows.map(row => crypto.open(row.payload, `document:executive:${row.id}`)) };
  }
  if (pathname.startsWith('/api/preferences/')) {
    const id = decodeURIComponent(pathname.slice('/api/preferences/'.length));
    if (!/^[a-zA-Z0-9:_.-]{1,180}$/.test(id)) throw fail(422, 'Недопустимый ключ');
    const key = `${user.id}:${id}`;
    if (method === 'GET') return (await repo.get(client, 'preferences', key)) ?? { value: null, revision: 0 };
    if (method === 'POST') {
      await lock(client, `preferences:${key}`);
      const current = await repo.get(client, 'preferences', key);
      if (body.revision !== (current?.revision ?? 0)) throw fail(409, 'Запись изменена в другом окне');
      if (JSON.stringify(body.value).length > 200000) throw fail(413, 'Запись слишком большая');
      const revision = await repo.put(client, 'preferences', key, body.value);
      await repo.append(client, `user:${user.id}`, { type: 'workspace.saved', key: id, actor: user.id, revision, at: new Date().toISOString() });
      return { value: body.value, revision };
    }
  }
  if (pathname === '/api/security/verify' && method === 'GET') { auth.require(request, session, ['administrator']); return repo.verify(client); }
  if (pathname === '/api/security/audit' && method === 'GET') {
    auth.require(request, session, ['administrator']);
    const { rows } = await client.query('SELECT * FROM journal ORDER BY created_at DESC LIMIT 300');
    return { entries: rows.map(row => ({ id: row.id, seq: row.seq, mac: row.mac, at: row.created_at, ...crypto.open(row.payload, `journal:${row.stream}:${row.seq}`), event: undefined })) };
  }
  if (pathname === '/api/security/sessions' && method === 'GET') {
    auth.require(request, session, ['administrator']);
    const { rows } = await client.query('SELECT token_hash,user_id,payload,expires_at,idle_until FROM sessions WHERE expires_at>now() AND idle_until>now()');
    return { sessions: rows.map(row => ({ id: row.token_hash, user: crypto.open(row.payload, `session:${row.token_hash}`).user, createdAt: crypto.open(row.payload, `session:${row.token_hash}`).createdAt, lastSeenAt: new Date(new Date(row.idle_until).getTime()-1800000).toISOString(), source: 'HTTPS', expiresAt: row.expires_at, idleUntil: row.idle_until, current: row.token_hash === session.hash })) };
  }
  if (pathname === '/api/security/sessions/revoke' && method === 'POST') {
    auth.require(request, session, ['administrator']);
    await client.query('DELETE FROM sessions WHERE token_hash=$1', [body.sessionId ?? body.id]);
    await repo.append(client, 'security', { type: 'session.revoked', actor: user.id, sessionId: body.sessionId ?? body.id, at: new Date().toISOString() });
    return { status: 'revoked' };
  }
  if (pathname === '/api/security/crypto/status') { auth.require(request, session, ['administrator']); return { profile: 'AES-256-GCM-HKDF-SHA256', fingerprint: crypto.keyId, mode: 'versioned-keyring', rotation: null }; }
  if (pathname === '/api/contracts') { auth.require(request, session, ['administrator']); return contracts.describe(); }
  if (pathname === '/api/operations/outbox') {
    auth.require(request, session, ['administrator']);
    if (method === 'POST') {
      const updated = await client.query("UPDATE outbox SET status='pending',attempts=0,available_at=now(),lease_id=NULL,lease_until=NULL WHERE id=$1 AND status IN ('failed','retry_wait') RETURNING id", [body.id]);
      if (!updated.rowCount) throw fail(409, 'Сообщение уже принято или обрабатывается');
      await repo.append(client, 'integration-actions', { type:'outbox.retry_requested', actor:user.id, id:body.id, at:new Date().toISOString() });
    }
    return { jobs: (await client.query('SELECT id,item_id,destination,status,attempts,last_error,updated_at FROM outbox ORDER BY updated_at DESC LIMIT 100')).rows };
  }
  if (pathname === '/api/operations/backups') {
    auth.require(request, session, ['administrator']);
    return method === 'POST' ? { backup: await backup(client, user) } : { backup: (await repo.get(client, 'system', 'backup'))?.value ?? null };
  }
  if (pathname === '/api/operations/health') {
    auth.require(request, session, ['administrator']);
    await mediaPool.query('SELECT 1');
    const queues = {};
    for (const name of ['erp','mes']) {
      const { rows } = await client.query("SELECT count(*)::integer total,count(*) FILTER(WHERE status IN ('pending','retry_wait','sending'))::integer pending,count(*) FILTER(WHERE status='failed')::integer failed FROM outbox WHERE destination=$1", [name]);
      queues[name] = rows[0];
    }
    const sessions = await client.query('SELECT count(*)::integer AS active FROM sessions WHERE expires_at>now() AND idle_until>now()');
    return { checkedAt: new Date().toISOString(), uptimeSeconds: (Date.now()-startedAt)/1000, process: { node: process.version, pid: process.pid },
      audit: await repo.verify(client), contracts: { count: Object.keys(contracts.files).length, status: 'Проверены' }, sessions: { active: sessions.rows[0].active, idleMinutes: 30 }, queues,
      components: { erp: { configured: true, mode: process.env.ORBITA_ERP_PROFILE || 'emulator' }, mes: { configured: !!process.env.ORBITA_MES_BASE_URL }, cad: { configured: !!process.env.ORBITA_KOMPAS_BASE_URL, imports: 0 } },
      storage: { dataBytes: Number((await client.query('SELECT pg_database_size(current_database()) AS size')).rows[0].size), files: 2, freeBytes: null },
      crypto: { profile: 'AES-256-GCM-HKDF-SHA256', fingerprint: crypto.keyId }, backup: (await repo.get(client, 'system', 'backup'))?.value ?? null };
  }
  if (pathname.startsWith('/api/integrations/') || pathname.startsWith('/api/plant/') || pathname.startsWith('/api/mobile/')) {
    const readShared = ['/api/plant/mes/configured','/api/mobile/events'];
    auth.require(request, session, readShared.includes(pathname) ? roles : pathname.startsWith('/api/mobile/') ? ['master','administrator'] : pathname === '/api/plant/mes/sync' ? roles : ['administrator']);
    if (pathname === '/api/integrations/results') {
      const history = await repo.history(client, { item: body.item_id, lines: user.lineIds });
      const decision = history.filter(row => row.message.event_type === 'quality_decision').at(-1)?.message;
      if (!decision || body.basis_event_ids?.length !== 1 || body.basis_event_ids[0] !== decision.event_id || body.quality_status !== erpQualityStatus(decision)) throw fail(403, 'Результат должен точно соответствовать последнему сохранённому решению ОТК');
    }
    const result = await withAdapters(client, repo, directory, contracts, adapters => adapters.invoke(pathname.startsWith('/api/mobile/') ? adapters.mobile : pathname.startsWith('/api/plant/') ? adapters.plant : adapters.integration, pathname, method === 'GET' ? undefined : body, { user }, method));
    if (method !== 'GET') await repo.append(client, 'integration-actions', { type: 'integration.request', actor: user.id, path: pathname, at: new Date().toISOString() });
    return result;
  }
  throw fail(404, 'Маршрут не найден');
}

const server = https.createServer({ key: await readFile(process.env.TLS_KEY_FILE), cert: await readFile(process.env.TLS_CERT_FILE), minVersion: 'TLSv1.2', requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 16384 }, async (request, response) => {
  const requestId = randomUUID(); requests++; active++;
  response.setHeader('X-Request-ID', requestId);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Strict-Transport-Security', 'max-age=31536000');
  try {
    const url = new URL(request.url, 'https://localhost');
    if (url.pathname === '/health/ready') { await pool.query('SELECT 1'); await mediaPool.query('SELECT 1'); response.writeHead(stopping ? 503 : 200).end('ready'); return; }
    if (url.pathname === '/health/live') { response.writeHead(200).end('live'); return; }
    if (url.pathname === '/metrics') { response.writeHead(200, { 'Content-Type': 'text/plain' }).end(`orbita_requests_total ${requests}\norbita_errors_total ${errors}\norbita_active_requests ${active}\norbita_uptime_seconds ${(Date.now()-startedAt)/1000}\n`); return; }
    if (!['GET','HEAD','POST'].includes(request.method)) throw fail(405, 'Метод не поддерживается');
    const origin = request.headers.origin;
    if (origin && origin !== process.env.PUBLIC_ORIGIN) throw fail(403, 'Недоверенный источник запроса');
    const body = request.method === 'POST' ? await readJsonObject(request, { maxBytes: url.pathname === '/api/media' ? 17_000_000 : 2_000_000 }) : null;
    const result = await transaction(pool, client => route(client, request, url, body));
    const status = result?.status && typeof result.status === 'number' ? result.status : 200;
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...result?.headers });
    response.end(result?.binary ?? JSON.stringify(result?.body ?? result));
  } catch (error) {
    errors++;
    const status = error.status ?? (['40001','40P01','55P03'].includes(error.code) ? 409 : 503);
    if (request.method === 'POST') {
      try { await transaction(pool, client => repo.append(client, 'security', { type: 'request.denied', requestId, path: request.url?.split('?')[0], status, at: new Date().toISOString() })); }
      catch { process.stderr.write(JSON.stringify({ level: 'error', requestId, component: 'audit', message: 'Failed to record denied request' }) + '\n'); }
    }
    process.stderr.write(JSON.stringify({ level: 'error', requestId, path: request.url?.split('?')[0], code: error.code ?? error.name, message: error.message }) + '\n');
    response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.status ? error.message : status === 409 ? 'Конкурирующее изменение. Повторите команду.' : 'Сервис временно недоступен', requestId }));
  } finally { active--; }
});

server.listen(Number(process.env.PORT || 8443), '0.0.0.0');
let workerBusy = false;
const worker = setInterval(async () => {
  if (workerBusy || stopping) return;
  workerBusy = true;
  try {
    await dispatchOne(pool, repo, crypto, directory, contracts);
    if (process.env.ORBITA_MES_BASE_URL) await synchronizePlant(pool, repo, directory, contracts);
  }
  catch (error) { process.stderr.write(JSON.stringify({ level: 'error', component: 'worker', message: error.message }) + '\n'); }
  finally { workerBusy = false; }
}, 1000);
async function shutdown() {
  stopping = true; clearInterval(worker);
  server.close(async () => { await pool.end(); await mediaPool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 25000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
