import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadCrypto } from '../crypto.mjs';
import { generateArchiveRecipient, sealArchive, openArchive } from '../hybrid-crypto.mjs';

test('key rotation reads original records; changed context, tag and unavailable key fail closed',async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),'orbita-key-test-'));
  try {
    const file=path.join(folder,'keys.json'),keys={v1:randomBytes(32).toString('hex'),v2:randomBytes(32).toString('hex')};
    await writeFile(file,JSON.stringify({active:'v1',keys})); const old=await loadCrypto(file);
    const record=old.seal({event_id:'TEST-01'},'event:TEST-01');
    await writeFile(file,JSON.stringify({active:'v2',keys})); const next=await loadCrypto(file);
    assert.equal(next.open(record,'event:TEST-01').event_id,'TEST-01');
    assert.equal(next.seal({value:1},'new').key_id,'v2');
    assert.throws(()=>next.open({...record,tag:randomBytes(16).toString('base64')},'event:TEST-01'));
    assert.throws(()=>next.open(record,'event:OTHER'));
    await writeFile(file,JSON.stringify({active:'v2',keys:{v2:keys.v2}}));
    const missing = await loadCrypto(file);
    assert.throws(()=>missing.open(record,'event:TEST-01'),/unavailable/);
  } finally {await rm(folder,{recursive:true,force:true});}
});

test('hybrid post-quantum envelope supports retained keys, migration references and tamper detection',()=>{
  const old=generateArchiveRecipient('archive-1'),next=generateArchiveRecipient('archive-2');
  const payload={event_id:'EV-01',reason:'Original evidence'};
  const first=sealArchive(payload,old,'EV-01');
  const migrated=sealArchive({original:first,source_id:'EV-01'},next,'migration:EV-01');
  assert.deepEqual(openArchive(first,{'archive-1':old}),payload);
  assert.deepEqual(openArchive(migrated,{'archive-2':next}).original,first);
  assert.throws(()=>openArchive(first,{}),/unavailable/);
  assert.throws(()=>openArchive({...first,source_id:'EV-02'},{'archive-1':old}));
  assert.equal(JSON.stringify(first).includes('PRIVATE KEY'),false);
});
