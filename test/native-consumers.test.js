import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {nativeFixture} from './native-fixture.js';
import * as persistencePlugin from '../lib/persistence-plugin.js';
import {createQueryClass} from '../lib/consumer-adapters.js';
import {DISK_META_KEY} from '../lib/presentation-runtime.js';

test('actual native query observes bounded presentation while full persistence reads stay exact',async()=>{
 const f=await nativeFixture();await f.fiber.dispose();
 const fiber=f.ctx.plugin({name:persistencePlugin.name,Config:persistencePlugin.Config,apply:persistencePlugin.apply},{root:f.root,compression:'zstd'});await fiber.await();
 const sessionModule=await f.libs.hostImport('@deepseek-ai/dsh-session');
 const sessionsFiber=f.ctx.plugin(sessionModule.default??sessionModule,{});await sessionsFiber.await();
 const projectionModule=await f.libs.hostImport('@deepseek-ai/dsh-session-projection');
 const projectionsFiber=f.ctx.plugin(projectionModule.default??projectionModule,{});await projectionsFiber.await();
 const {SqliteSessionQueryEngine}=await f.libs.hostImport('@deepseek-ai/dsh-session-query-sqlite');
 const timers=new Map();let now=0;
 const Query=createQueryClass(SqliteSessionQueryEngine,{setTimer(fn,ms){const token={};timers.set(token,{fn,at:now+ms});return token;},clearTimer(token){timers.delete(token);}});
 function advance(ms){now+=ms;for(const [token,timer] of [...timers])if(timer.at<=now){timers.delete(token);timer.fn();}}
 const query=f.ctx.plugin(Query,{path:':memory:',openAt:'never',preparedSessionCacheSize:1});
 try{
  await query.await();const service=f.ctx.get('sessionQuery');const backend=f.ctx.get('sessionPersistence');
  const listed=await service.listSessions();
  assert.ok(listed.some(session=>session.header.id===f.header.id),'the current session list includes the persisted session');
  const restoredSession=f.libs.session.Session.fromRestore(f.header.id,f.events,f.header,0,'detached');
  assert.deepEqual(service.getListMetadata(restoredSession),{blank:false,lastPromptAt:14});
  const observation=await service.observeSession(f.header.id,{projectionMode:'none'});
  try{assert.ok(observation.events[8].data.meta[DISK_META_KEY]);assert.ok(Buffer.byteLength(JSON.stringify(observation.events[8].data.meta.lines))<=4096);}finally{observation[Symbol.dispose]();}assert.equal(service.memoryMetrics().presentation.entries,1);assert.equal(service.memoryMetrics().presentation.pendingEvictions,1);advance(30_000);assert.equal(service.memoryMetrics().presentation.entries,0);
  const full=await service.observeFullSession(f.header.id,{projectionMode:'none'});
  const eventWindow=await service.readEvent({sessionId:f.header.id,seq:8});
  assert.ok(eventWindow.target.data.meta[DISK_META_KEY]);
  try{assert.deepEqual(full.events[8].data.meta,f.events[8].data.meta);}finally{full[Symbol.dispose]();}assert.equal(service.memoryMetrics().full.entries,1);assert.equal(service.memoryMetrics().full.pendingEvictions,1);advance(30_000);assert.equal(service.memoryMetrics().full.entries,0);
  const reopened=await service.observeSession(f.header.id,{projectionMode:'none'});assert.ok(reopened.events[8].data.meta[DISK_META_KEY]);assert.ok(Buffer.byteLength(JSON.stringify(reopened.events[8].data.meta.lines))<=4096);assert.deepEqual(service.getListMetadata(f.libs.session.Session.fromRestore(f.header.id,reopened.events,reopened.header,0,'detached')),{blank:false,lastPromptAt:14});reopened[Symbol.dispose]();advance(30_000);const handle=await backend.open(f.header.id,'read');try{assert.deepEqual((await handle.read(0,undefined)).events[8].data.meta,f.events[8].data.meta);}finally{await handle.close();}
  const controller=backend.diskController;assert.equal(controller.metrics().closed,false);
  await query.dispose();await fiber.dispose();assert.equal(controller.metrics().closed,true);
 }finally{await query.dispose();await fiber.dispose();await projectionsFiber.dispose();await sessionsFiber.dispose();await f.cleanup();}
});
