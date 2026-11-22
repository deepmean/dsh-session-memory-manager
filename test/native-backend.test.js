import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {zstdCompressSync,constants} from 'node:zlib';
import {nativeFixture} from './native-fixture.js';
import {createBackendClass} from '../lib/backend-adapter.js';
import {DiskPresentationController,DISK_META_KEY} from '../lib/presentation-runtime.js';

async function setup(options){
 const f=await nativeFixture(options);await f.fiber.dispose();
 const controller=new DiskPresentationController({dshDir:process.env.DSH_INSTALL_DIR,root:f.root});
 const Backend=createBackendClass(f.native.JsonlSessionPersistence,controller,{catalog:f.libs.catalog,compressFrame:raw=>zstdCompressSync(raw,{params:{[constants.ZSTD_c_checksumFlag]:1}})});
 let backend;
 const fiber=f.ctx.plugin({name:'adapted-native-test',apply:async ctx=>{
  let child;ctx.effect(function*(){const tracker=new f.native.JsonlBackendTracker('session-persistence-jsonl');yield tracker.install(ctx);child=ctx.plugin({name:'adapted-backend-service',apply:serviceCtx=>{backend=new Backend(serviceCtx,{root:f.root,compression:'zstd'},tracker);controller.setResolver(id=>backend.resolveCurrentLog(id));}});yield child.dispose;},'adapted native resources');await child.await();ctx.effect(()=>()=>controller.close(),'disk controller');
 }});await fiber.await();
 return {...f,backend,controller,async cleanup(){await fiber.dispose();await f.cleanup();}};
}

test('real native backend cold presentation and full export stay isolated while append keeps the original prefix',async()=>{
 const f=await setup();
 try{
  const before=await fs.readFile(f.file);
  const view=await f.backend.openPresentation(f.header.id,'write');
  const stored=await view.read(0,undefined);
  assert.ok(stored.events[8].data.meta[DISK_META_KEY]);
  const original=await f.backend.open(f.header.id,'read');
  assert.deepEqual((await original.read(0,undefined)).events[8].data.meta,f.events[8].data.meta);await original.close();
  const expected=f.libs.session.Session.fromRestore(f.header.id,f.events,f.header,0,'detached');
  const actual=f.libs.session.Session.fromRestore(f.header.id,stored.events,f.header,0,stored.eventState);
  assert.deepEqual(actual.deriveMessages(),expected.deriveMessages());
  assert.deepEqual(actual.requestHeader(),expected.requestHeader());
  const event={type:'session/title',seq:f.events.length,time:300,data:{title:'append unchanged',messageSeqs:[],source:{kind:'user'}}};
  await view.append([event]);await view.flush();await view.close();
  const after=await fs.readFile(f.file);assert.deepEqual(after.subarray(0,before.length),before);
  const full=await f.backend.open(f.header.id,'read');const read=await full.read(0,undefined);
  assert.deepEqual(read.events.slice(0,f.events.length),f.events);await full.close();
 }finally{await f.cleanup();}
});

test('warm child with shifted event sequence serves details through its existing token',async()=>{
 const f=await setup();
 try{
  const source=await f.backend.openPresentation(f.header.id,'read');const read=await source.read(0,undefined);await source.close();
  const childHeader={...f.header,id:'session-shifted-child',isSeeded:false};
  const shifted=[{type:'sandbox/mode',seq:0,time:1,data:{mode:'workspace-write'}},...read.events.map(event=>({...event,seq:event.seq+1,...event.sourceEventSeqs?{sourceEventSeqs:event.sourceEventSeqs.map(seq=>seq+1)}:{}}))];
  const child=await f.backend.create(childHeader);await child.append(shifted);await child.flush();await child.close();
  await fs.rename(f.file,path.join(f.temp,'original-parent-unavailable.zstd'));
  const marker=read.events[8].data.meta[DISK_META_KEY];
  const page=await f.controller.readPtcLines({sessionId:childHeader.id,seq:marker.seq,token:marker.token,maxBytes:2048});
  assert.equal(page.seq,marker.seq);assert.equal(page.lines[0].text,f.events[8].data.meta.lines[0].text);
 }finally{await f.cleanup();}
});

test('materialized child retains complete metadata even when parent is removed',async()=>{
 const f=await setup();
 try{
  const view=await f.backend.openPresentation(f.header.id,'read');const read=await view.read(0,undefined);await view.close();
  const childHeader={...f.header,id:'session-child-copy',isSeeded:false};
  const child=await f.backend.create(childHeader);await child.append(read.events);await child.flush();await child.close();
  const childFile=await f.backend.resolveCurrentLog(childHeader.id);
  const expectedLines=f.events[8].data.meta.lines;
  await fs.rename(f.file,path.join(f.temp,'parent-unavailable.zstd'));
  const restored=await f.controller.restoreEvent(read.events[8],{ownerId:childHeader.id});
  assert.deepEqual(restored.data.meta.lines,expectedLines);
  const childRead=await f.backend.open(childHeader.id,'read');const childEvents=(await childRead.read(0,undefined)).events;await childRead.close();
  assert.deepEqual(childEvents,f.events);assert.ok(!JSON.stringify(childEvents).includes(DISK_META_KEY));
 }finally{await f.cleanup();}
});
