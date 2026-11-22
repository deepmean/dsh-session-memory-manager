import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {nativeFixture} from './native-fixture.js';
let runtime={};try{runtime=await import('../lib/presentation-runtime.js');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
const digest=b=>createHash('sha256').update(b).digest('hex');

test('cold preview validates native events and serializes without hydrating original metadata',async()=>{
 assert.equal(typeof runtime.DiskPresentationController,'function','presentation controller missing');
 const f=await nativeFixture();const before=await fs.readFile(f.file);
 const c=new runtime.DiskPresentationController({dshDir:process.env.DSH_INSTALL_DIR,root:f.root});
 try{
  const stored=await c.readStoredPrefix({file:f.file,id:f.header.id,revision:'fixture',buffer:before});
  assert.equal(stored.events.length,f.events.length);assert.equal(stored.inheritedEventCount,0);
  const ev=stored.events[8];assert.ok(Buffer.byteLength(JSON.stringify(ev.data.meta.lines))<=4096);
  for(const field of ['rootCallId','parentCallId','subCallId','name']){
   const forged={...ev,data:{...ev.data,[field]:'forged-call'}};
   await assert.rejects(c.restoreEvent(forged),/identity|token|reference|call/i);
  }
  for(const marker of [false,null,{},'invalid']){
   const forged={...ev,data:{...ev.data,meta:{...ev.data.meta,[runtime.DISK_META_KEY]:marker}}};
   await assert.rejects(c.restoreEvent(forged),/marker|token|reference/i);
  }
  assert.ok(ev.data.meta[runtime.DISK_META_KEY]);assert.deepEqual(ev.data.content,f.events[8].data.content);
  const reads=c.metrics().detailReads;JSON.stringify(stored.events);JSON.stringify(stored.events);
  assert.equal(c.metrics().detailReads,reads,'serialization must never read disk automatically');
  assert.deepEqual((await c.restoreEvent(ev)).data.meta,f.events[8].data.meta);
  assert.equal(digest(await fs.readFile(f.file)),digest(before));
  f.libs.format;
 }finally{await c.close();await f.cleanup();}
});

test('cold restore transfers events in acknowledged bounded batches',async()=>{
  assert.equal(typeof runtime.DiskPresentationController,'function');
  const f=await nativeFixture();const c=new runtime.DiskPresentationController({dshDir:process.env.DSH_INSTALL_DIR,root:f.root,presentationBatchEvents:2});
  try{
   const result=await c.readStoredPrefix({file:f.file,id:f.header.id,revision:'batch-fixture',buffer:await fs.readFile(f.file)});
   assert.equal(result.events.length,f.events.length);
   assert.ok(c.metrics().largestTransferBatch<=2);
   assert.ok(c.metrics().batches>=Math.ceil(f.events.length/2));
  }finally{await c.close();await f.cleanup();}
});

test('explicit metadata pages reassemble exact original and keep ordinary JSON bounded',async()=>{
 assert.equal(typeof runtime.DiskPresentationController,'function','presentation controller missing');
 const f=await nativeFixture({lineCount:4,lineLength:18000});const c=new runtime.DiskPresentationController({dshDir:process.env.DSH_INSTALL_DIR,root:f.root});
 try{
  const stored=await c.readStoredPrefix({file:f.file,id:f.header.id,revision:'fixture',buffer:await fs.readFile(f.file)});
  const marker=stored.events[8].data.meta[runtime.DISK_META_KEY];
  const restored=new Map();let offset=0,textOffset=0,more=true;
  while(more){
   const page=await c.readPtcLines({sessionId:f.header.id,seq:8,token:marker.token,offset,textOffset,limit:20,maxBytes:2048});
   assert.ok(Buffer.byteLength(JSON.stringify(page))<=2048);
   for(const line of page.lines)restored.set(line.number,(restored.get(line.number)??'')+line.text);
   ({nextOffset:offset,nextTextOffset:textOffset,hasMore:more}=page);
  }
  assert.deepEqual([...restored].map(([number,text])=>({number,text})),f.events[8].data.meta.lines);
  await assert.rejects(c.restoreEvent({...stored.events[8],data:{...stored.events[8].data,meta:{...stored.events[8].data.meta,[runtime.DISK_META_KEY]:{...marker,token:'forged'}}}}),/token|locator|reference/i);
 }finally{await c.close();await f.cleanup();}
});

test('source snapshot mismatch and closed controller fail without altering log',async()=>{
 assert.equal(typeof runtime.DiskPresentationController,'function','presentation controller missing');
 const f=await nativeFixture();const c=new runtime.DiskPresentationController({dshDir:process.env.DSH_INSTALL_DIR,root:f.root});
 try{
  const original=await fs.readFile(f.file);
  await assert.rejects(c.readStoredPrefix({file:f.file,id:f.header.id,revision:'bad',buffer:Buffer.from('another snapshot')}),/snapshot|hash|changed/i);
  assert.equal(digest(await fs.readFile(f.file)),digest(original));
  await c.close();await assert.rejects(c.readStoredPrefix({file:f.file,id:f.header.id,buffer:original}),/closed/i);
 }finally{await c.close();await f.cleanup();}
});
