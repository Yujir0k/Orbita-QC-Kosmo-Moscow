import https from 'node:https';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.TEST_BASE_URL || 'https://localhost:8443';
const ca = await readFile(process.env.TEST_CA_FILE || '../../../.secrets/ca.crt');
function request(route, { method = 'GET', body, cookie, csrf, idempotency } = {}) {
  return new Promise((resolve,reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(new URL(route,base), { ca, method, headers: { ...(data ? {'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)} : {}), ...(cookie ? {Cookie:cookie} : {}), ...(csrf ? {'X-CSRF-Token':csrf} : {}), ...(idempotency ? {'Idempotency-Key':idempotency} : {}) } }, res => {
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
        const bytes=Buffer.concat(chunks); let value;try {value=JSON.parse(bytes.toString());}catch {value=bytes;}
        resolve({status:res.statusCode,body:value,headers:res.headers});
      });
    });req.on('error',reject);req.end(data);
  });
}
assert.equal((await request('/api/data/bootstrap')).status,401);
const sessions={};
for(const role of ['controller','master','technologist','leader','administrator']) {
  const result=await request('/api/security/demo-session',{method:'POST',body:{role}});
  assert.equal(result.status,200,JSON.stringify(result.body));
  sessions[role]={cookie:result.headers['set-cookie'][0].split(';')[0],csrf:result.body.csrfToken};
}
const controller=sessions.controller,admin=sessions.administrator;
const data=await request('/api/data/bootstrap',controller);
assert.equal(data.status,200,JSON.stringify(data.body));
assert.ok(data.body.deliveries.length>100);
const asset=data.body.dataset.media[0];
const media=`/media/${asset.path_from_quality_dataset.split('/').at(-1)}`;
assert.equal((await request(media)).status,401);
assert.equal((await request(media,controller)).status,200);
assert.equal((await request('/api/security/demo-session',{method:'POST',body:{role:'root'}})).status,422);
assert.equal((await request('/api/events/ingest',{...controller,method:'POST',body:{deliveries:[{}]}})).status,403);
assert.equal((await request('/api/workflow/commands',{cookie:controller.cookie,method:'POST',body:{}})).status,403);
assert.equal((await request('/api/security/verify',admin)).body.valid,true);
const receipt=await request('/api/events/ingest',{...admin,method:'POST',body:{deliveries:[{delivery_id:'SMOKE-INVALID',message:null}]}});
assert.equal(receipt.body.outcomes[0].kind,'error');
const orders=await request('/api/integrations/pull',{...admin,method:'POST',body:{work_order_id:'WO-B'}});
assert.equal(orders.status,200,JSON.stringify(orders.body));
const persistedDecision = data.body.deliveries.find(row => row.message.event_type === 'quality_decision').message;
assert.equal((await request('/api/integrations/results',{...admin,method:'POST',body:{item_id:persistedDecision.item_id,quality_status:'forged',basis_event_ids:[persistedDecision.event_id]}})).status,403);
const prefs=await request('/api/preferences/smoke-check',controller);
const saved=await request('/api/preferences/smoke-check',{...controller,method:'POST',body:{revision:prefs.body.revision,value:{test:randomUUID()}}});
assert.equal(saved.status,200,JSON.stringify(saved.body));
assert.equal((await request('/api/preferences/smoke-check',{...controller,method:'POST',body:{revision:prefs.body.revision,value:{stale:true}}})).status,409);
for(const role of Object.keys(sessions)) {
  const state=await request('/api/security/session',sessions[role]);
  assert.equal(state.body.user.role,role);
}
const health=await request('/api/operations/health',admin);assert.equal(health.status,200,JSON.stringify(health.body));
for (const action of ['tech_allow','tech_deny','release','scrap','confirm']) {
  assert.equal((await request('/api/workflow/commands', { ...sessions.technologist, method:'POST', idempotency:randomUUID(), body:{action,reason:'Проверка разграничения прав'} })).status,403);
}
const poll = await request('/api/security/events',controller);
assert.equal((await request(`/api/security/events?cursor=${poll.body.cursor}`,controller)).body.unchanged,true);
const image = await request(media, controller);
const uploaded = await request('/api/media', { ...sessions.master, method:'POST', body:{itemId:asset.item_id,contentType:image.headers['content-type'],data:image.body.toString('base64')} });
assert.equal(uploaded.status,200,JSON.stringify(uploaded.body));
assert.equal((await request('/media/'+uploaded.body.asset.path_from_quality_dataset.split('/').at(-1),controller)).status,200);
const backup = await request('/api/operations/backups', { ...admin, method:'POST',body:{} });
assert.equal(backup.status,200,JSON.stringify(backup.body));
process.stdout.write(JSON.stringify({backup:backup.body.backup})+'\n');
if(process.env.LOAD_REQUESTS) {
  const freshPoll = await request('/api/security/events',controller);
  const count = Number(process.env.LOAD_REQUESTS), concurrency = Number(process.env.LOAD_CONCURRENCY || 10);
  let completed = 0; const timings = [], statuses = {}; const start = performance.now();
  await Promise.all(Array.from({length:concurrency},async()=>{
    while(completed++ < count) {
      const begun = performance.now(); const result = await request(`/api/security/events?cursor=${freshPoll.body.cursor}`,controller);
      timings.push(performance.now()-begun); statuses[result.status] = (statuses[result.status] || 0)+1;
    }
  }));
  timings.sort((a,b)=>a-b);
  const result = { requests:timings.length,concurrency,statuses,durationMs:performance.now()-start,p50:timings[Math.floor(timings.length*.5)],p95:timings[Math.floor(timings.length*.95)],max:timings.at(-1) };
  process.stdout.write(JSON.stringify({load:result})+'\n');
  assert.equal(statuses[200],count,'Load run contains failed requests');
}
process.stdout.write(JSON.stringify({status:'passed',items:data.body.dataset.items.length,events:data.body.deliveries.length,roles:Object.keys(sessions).length,protectedMedia:true,erpInbound:orders.body.status,health:health.status})+'\n');
