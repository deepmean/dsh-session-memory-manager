import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {nativeFixture} from './native-fixture.js';
import * as persistencePlugin from '../lib/persistence-plugin.js';
import DiskAgentLoop from '../lib/agent-loop-plugin.js';
import {DISK_META_KEY} from '../lib/presentation-runtime.js';

test('actual AgentLoop resume uses disk presentation without invoking a model and closes cleanly',async()=>{
 const f=await nativeFixture();await f.fiber.dispose();const fibers=[];let owned;
 try{
  const persistence=f.ctx.plugin(persistencePlugin,{root:f.root,compression:'zstd'});fibers.push(persistence);await persistence.await();
  for(const spec of ['@deepseek-ai/dsh-session','@deepseek-ai/dsh-session-projection','@deepseek-ai/dsh-agent','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tools']){
   const module=await f.libs.hostImport(spec);const plugin=module.default;
   assert.ok(plugin,`native plugin ${spec} must exist`);
   const fiber=f.ctx.plugin(plugin,{});fibers.push(fiber);await fiber.await();
  }
  const loop=f.ctx.plugin(DiskAgentLoop,{agents:[]});fibers.push(loop);await loop.await();
  owned=await f.ctx.get('agents').resume({resumeSessionId:f.header.id,agentOptions:{provider:'fixture',model:'fixture'}});
  const session=owned.agent.session;
  assert.ok(session.eventAt(8).data.meta[DISK_META_KEY]);
  assert.deepEqual(session.deriveMessages(),f.libs.session.Session.fromRestore(f.header.id,f.events,f.header,0,'detached').deriveMessages());
  const raw=await fs.readFile(f.file);assert.ok(raw.length>0);
  await owned.dispose();owned=undefined;
  const controller=f.ctx.get('sessionPersistence').diskController;
  for(const fiber of fibers.reverse())await fiber.dispose();fibers.length=0;
  assert.equal(controller.metrics().closed,true);
 }finally{await owned?.dispose();for(const fiber of fibers.reverse())await fiber.dispose();await f.cleanup();}
});
