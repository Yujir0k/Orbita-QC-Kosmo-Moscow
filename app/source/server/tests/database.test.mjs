import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase, transaction } from '../db.mjs';
import { loadCrypto, digest } from '../crypto.mjs';
import { createRepository } from '../repository.mjs';
import { createWorkflow, domain } from '../workflow.mjs';
import { createContractRegistry } from '../../../contract-validator.mjs';
import { getMedia } from '../media.mjs';
import { createAuth, passwordHash } from '../auth.mjs';

const pool = await createDatabase();
const media = await createDatabase('MEDIA_DB');
const crypto = await loadCrypto(process.env.KEYRING_FILE);
const repo = createRepository(crypto);
const contracts = await createContractRegistry('/app');
const workflow = createWorkflow(repo, crypto, contracts);
const users = Object.fromEntries(['controller','master','technologist','leader','administrator'].map(role => [role, {id:role+'-01',role,lineIds:['LINE-01','LINE-02']}]));
test.after(async () => { await pool.end(); await media.end(); });

test('controller -> master -> controller is durable, idempotent and atomic with outbox', async () => {
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    const item = 'ITEM-013';
    const command = async (role, action, details = {}) => {
      const history = await repo.history(client, { item }); domain.useAuthoritativeHistory(history);
      const selected = domain.cases.find(row => row.item === item);
      const input = { itemId:item, action, reason:'Проверенное основание производственного действия',caseId:selected.id,expectedRevision:digest(history.map(row=>row.message)),includePhoto:false,...details };
      return { input, result: await workflow(client, users[role], input, randomUUID()) };
    };
    await assert.rejects(command('master','master_complete'), /Нет открытого задания/);
    const confirm = await command('controller','confirm');
    assert.equal(confirm.result.deliveries.at(-1).message.data.disposition,'rework');
    const history = await repo.history(client,{item});
    const stale = {...confirm.input,reason:'Повторное конфликтующее решение'};
    await assert.rejects(workflow(client,users.controller,stale,randomUUID()),error=>error.status===409);
    for (const action of ['tech_allow','tech_deny','confirm','release','scrap']) await assert.rejects(command('technologist',action),error=>error.status===403);
    const master = await command('master','master_complete',{masterDetails:{method:'Согласованная доработка',operator:'OP-01',durationMinutes:12,actualSizeMm:5.2,paperInspection:true}});
    assert.equal(master.result.deliveries.at(-1).message.data.workflow_status,'REVISION_READY');
    await assert.rejects(command('master','release'),error=>error.status===403);
    const released = await command('controller','release',{measurement:{value:5.2,instrumentId:'TEST-CAL-1',calibrationConfirmed:true}});
    assert.equal(released.result.deliveries.at(-1).message.data.disposition,'release');
    assert.ok((await repo.history(client,{item})).length > history.length);
    assert.equal((await client.query("SELECT count(*)::integer AS n FROM outbox WHERE item_id=$1",[item])).rows[0].n,2);
    const check = await repo.verify(client); assert.equal(check.valid,true);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('duplicates, conflicting originals, late events and missing fields retain delivery receipts', async () => {
  const client=await pool.connect(); await client.query('BEGIN');
  try {
    const row=structuredClone((await repo.history(client))[0]);
    assert.equal((await repo.ingest(client,row,domain.validateDelivery,{trusted:true})).kind,'duplicate');
    row.message.data={...row.message.data,reason:'Conflicting immutable value'};
    assert.equal((await repo.ingest(client,row,domain.validateDelivery,{trusted:true})).kind,'error');
    row.message.event_id=randomUUID();row.message.occurred_at='2020-01-01T00:00:00Z';
    assert.equal((await repo.ingest(client,row,domain.validateDelivery,{trusted:true})).kind,'late');
    assert.equal((await repo.ingest(client,{message:null},domain.validateDelivery)).kind,'error');
  } finally { await client.query('ROLLBACK');client.release(); }
});

test('master proposes scrap and controller confirms it without a technologist production decision', async () => {
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    const item = 'ITEM-013';
    const command = async (role, action, key = randomUUID()) => {
      const history = await repo.history(client, { item });
      domain.useAuthoritativeHistory(history);
      const input = { itemId: item, caseId: domain.cases.find(row => row.item === item).id,
        action, reason: 'Документированное основание решения в тесте', expectedRevision: digest(history.map(row => row.message)) };
      return { input, result: await workflow(client, users[role], input, key) };
    };
    await command('controller', 'confirm');
    await command('master', 'master_scrap');
    const history = await repo.history(client, { item });
    domain.useAuthoritativeHistory(history);
    assert.ok(domain.tasks.some(task => task.item === item && task.role === 'controller'));
    assert.equal(history.filter(row => row.message.event_type === 'quality_decision').at(-1).message.data.disposition, 'rework');
    const key = randomUUID();
    const { input, result } = await command('controller', 'scrap', key);
    assert.equal(result.deliveries.at(-1).message.data.disposition, 'scrap');
    assert.deepEqual(await workflow(client, users.controller, input, key), result);
    await assert.rejects(command('technologist', 'release'), error => error.status === 403);
    assert.equal((await repo.verify(client)).valid, true);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('runtime SQL role cannot overwrite or truncate evidence; media requires scope and verifies digest', async () => {
  await assert.rejects(pool.query('UPDATE events SET event_type=event_type'),error=>error.code==='42501');
  await assert.rejects(pool.query('TRUNCATE journal'),error=>error.code==='42501');
  const row=(await media.query('SELECT filename,line_id FROM media LIMIT 1')).rows[0];
  await assert.rejects(getMedia(media,crypto,row.filename,['NO-LINE']),error=>error.status===404);
  const asset=await getMedia(media,crypto,row.filename,[row.line_id]);assert.equal(digest(asset.bytes),asset.hash);
});

test('multiple connections append to one stream without loss or broken chains', async () => {
  const stream=`test:${randomUUID()}`;
  await Promise.all(Array.from({length:30},(_,index)=>transaction(pool,client=>repo.append(client,stream,{type:'concurrency.test',index}))));
  const rows=(await pool.query('SELECT seq FROM journal WHERE stream=$1 ORDER BY seq',[stream])).rows;
  assert.deepEqual(rows.map(row=>Number(row.seq)),Array.from({length:30},(_,i)=>i+1));
  assert.equal((await repo.verify(pool)).valid,true);
});

test('password login, disabled demo, CSRF and account throttling work against shared PostgreSQL', async () => {
  const client = await pool.connect();
  const priorMode = process.env.DEMO_MODE;
  await client.query('BEGIN');
  try {
    process.env.DEMO_MODE = 'true';
    const demoAuth = createAuth(repo, crypto);
    const demo = await demoAuth.demoSession(client, { role:'controller' });
    const demoRequest = {headers:{cookie:demo.headers['Set-Cookie'].split(';')[0]}};
    assert.ok(await demoAuth.session(client,demoRequest));
    process.env.DEMO_MODE = 'false';
    assert.equal(await demoAuth.session(client,demoRequest),null);
    const auth = createAuth(repo, crypto), id = `test-${randomUUID()}`, password = randomUUID();
    const request = { method:'POST', headers:{}, socket:{remoteAddress:'test-local'} };
    await repo.put(client, 'users', id, { id, role:'controller', lineIds:['LINE-01'], password:await passwordHash(password) });
    await assert.rejects(auth.demoSession(client,{role:'administrator'}), error => error.status === 404);
    const result = await auth.login(client, request, {id,password});
    assert.equal(result.status, 200);
    request.headers.cookie = result.headers['Set-Cookie'].split(';')[0];
    const session = await auth.session(client, request);
    assert.deepEqual(session.user.lineIds,['LINE-01']);
    assert.throws(() => auth.require(request,session),error => error.status === 403);
    request.headers['x-csrf-token'] = session.csrfToken;
    assert.equal(auth.require(request,session).id,id);
    assert.throws(() => auth.require(request,session,['administrator']),error => error.status === 403);
    for(let i=0;i<8;i++) assert.equal((await auth.login(client,request,{id,password:'wrong'})).status,401);
    assert.equal((await auth.login(client,request,{id,password:'wrong'})).status,429);
  } finally { process.env.DEMO_MODE = priorMode; await client.query('ROLLBACK'); client.release(); }
});
