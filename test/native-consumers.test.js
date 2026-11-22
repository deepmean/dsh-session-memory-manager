import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {nativeFixture} from './native-fixture.js';
import * as persistencePlugin from '../lib/persistence-plugin.js';
import DiskSessionQuery from '../lib/query-plugin.js';
import {DISK_META_KEY} from '../lib/presentation-runtime.js';

test('actual native query observes bounded presentation while full persistence reads stay exact',async()=>{
 const f=await nativeFixture();await f.fiber.dispose();
 const fiber=f.ctx.plugin({name:persistencePlugin.name,Config:persistencePlugin.Config,apply:persistencePlugin.apply},{root:f.root,compression:'zstd'});await fiber.await();
 const sessionModule=await f.libs.hostImport('@deepseek-ai/dsh-session');
 const sessionsFiber=f.ctx.plugin(sessionModule.default??sessionModule,{ });await sessionsFiber.await();
 const query=f.ctx.plugin(DiskSessionQuery,{path:':memory:',openAt:'never',preparedSessionCacheSize:1});
 try{
  await query.await();const service=f.ctx.get('sessionQuery');const backend=f.ctx.get('sessionPersistence');
  const observation=await service.observeSession(f.header.id,{projectionMode:'none'});
  try{assert.ok(observation.events[8].data.meta[DISK_META_KEY]);assert.ok(Buffer.byteLength(JSON.stringify(observation.events[8].data.meta.lines))<=4096);}finally{observation[Symbol.dispose]();}
  const full=await service.observeFullSession(f.header.id,{projectionMode:'none'});
  const eventWindow=await service.readEvent({sessionId:f.header.id,seq:8});
  assert.ok(eventWindow.target.data.meta[DISK_META_KEY]);
  try{assert.deepEqual(full.events[8].data.meta,f.events[8].data.meta);}finally{full[Symbol.dispose]();}
  const handle=await backend.open(f.header.id,'read');try{assert.deepEqual((await handle.read(0,undefined)).events[8].data.meta,f.events[8].data.meta);}finally{await handle.close();}
  const controller=backend.diskController;assert.equal(controller.metrics().closed,false);
  await query.dispose();await fiber.dispose();assert.equal(controller.metrics().closed,true);
 }finally{await query.dispose();await fiber.dispose();await sessionsFiber.dispose();await f.cleanup();}
});
