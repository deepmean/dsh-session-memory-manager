import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {nativeFixture} from './native-fixture.js';
import * as persistencePlugin from '../lib/persistence-plugin.js';
import DiskAgentLoop from '../lib/agent-loop-plugin.js';
import DiskSessionQuery from '../lib/query-plugin.js';
import {createSessionControllerAdapter} from '../lib/session-controller-adapter.js';

function fakeClock(){
 let now=0,id=0;const tasks=new Map();
 return {setTimeout(callback,delay){const token=++id;tasks.set(token,{at:now+delay,callback});return token;},clearTimeout(token){tasks.delete(token);},async advance(ms){now+=ms;for(const [token,task] of [...tasks])if(task.at<=now){tasks.delete(token);task.callback();}await Promise.resolve();await Promise.resolve();},pending(){return tasks.size;}};
}

async function installNativeAgentServices(f,fibers){
 const persistence=f.ctx.plugin(persistencePlugin,{root:f.root,compression:'zstd'});fibers.push(persistence);await persistence.await();
 for(const spec of ['@deepseek-ai/dsh-session','@deepseek-ai/dsh-session-projection','@deepseek-ai/dsh-agent','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-system-prompt','@deepseek-ai/dsh-tools']){
  const plugin=(await f.libs.hostImport(spec)).default;
  assert.ok(plugin,`installed service ${spec} is available`);
  const fiber=f.ctx.plugin(plugin,{});fibers.push(fiber);await fiber.await();
 }
 const loop=f.ctx.plugin(DiskAgentLoop,{agents:[]});fibers.push(loop);await loop.await();
 const query=f.ctx.plugin(DiskSessionQuery,{path:':memory:',openAt:'never',preparedSessionCacheSize:1});fibers.push(query);await query.await();
}

function provideUnrelatedControllerServices(ctx,Base){
 const noop=()=>()=>{};
 const values={agentDefaultModel:{saveSelection:async()=>{}},attachments:{readImage:async()=>{throw new Error('unused');},admitPromptContent:async content=>content},fileUploads:{registerAgentResolver:noop,retirePrompt:noop,bindPrompt(){return{commit(){},[Symbol.dispose](){}}}},fs:{},llm:{},remoteAccess:{allows:()=>true},typert:{resources:{register:noop},lookups:{configure:noop},contexts:{configureHost:noop}},typertGateway:{},workspaceRegistry:{}};
 for(const key of Base.inject) if(!ctx.get(key)) ctx.provide(key,values[key]??{});
}

test('native controller cold follow is passive and owned idle Agent disposal preserves durable history',async()=>{
 const f=await nativeFixture({lineCount:25,lineLength:40});
 await f.fiber.dispose();
 const fibers=[];let adapterFiber,controller,handle;
 try{
  await installNativeAgentServices(f,fibers);
  const Base=(await f.libs.hostImport('@deepseek-ai/dsh-api-session-controller')).SessionController;
  const cordis=f.libs.cordis;
  const {remoteMethods}=await f.libs.hostImport('@deepseek-ai/dsh-typert-protocol');
  const marker='@deepseek-ai/dsh-typert-protocol/remote-methods';
  assert.equal(Object.getOwnPropertyDescriptor(Base.prototype,marker),undefined);
  provideUnrelatedControllerServices(f.ctx,Base);
  const clock=fakeClock();
  const Adapter=createSessionControllerAdapter(Base,cordis,{schemastery:f.libs.schema,setTimer:clock.setTimeout,clearTimer:clock.clearTimeout});
  const resolvedConfig=Adapter.Config({idleReclaimMinutes:5,nativeOpen:false});
  adapterFiber=f.ctx.plugin({inject:Base.inject,apply:async childCtx=>{
   const projectedQuery=Object.create(childCtx.sessionQuery);
   projectedQuery.observeSession=async(sessionId,options={})=>{
    const observation=await childCtx.sessionQuery.observeSession(sessionId,{...options,projectionMode:'none'});
    return new Proxy(observation,{get(target,key){if(key==='projections')return {asOfSeq:target.cursor,values:{}};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
   };
   controller=new Adapter(childCtx.extend({sessionQuery:projectedQuery}),resolvedConfig);
   await controller[cordis.Service.init]();
  }});
  await adapterFiber.await();
  assert.ok(controller instanceof Base);
  assert.equal(remoteMethods(controller).length,25);
  assert.equal(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(controller),marker).value.methods.length,25);
  assert.equal(Object.getOwnPropertyDescriptor(Base.prototype,marker),undefined);

  const original=await fs.readFile(f.file);
  const originalHash=crypto.createHash('sha256').update(original).digest('hex');
  const expected=f.libs.session.Session.fromRestore(f.header.id,f.events,f.header,0,'detached').deriveMessages();
  const follow=controller.follow({address:{kind:'session',sessionId:f.header.id},activate:true},new AbortController().signal);
  assert.equal((await follow.next()).done,false);
  assert.equal(f.ctx.get('agents').get(f.header.id),undefined,'cold history follow is passive');
  const resolved=await controller.withActivity({sessionId:f.header.id},()=>controller.agents.resolveAgent(f.header.id));
  assert.ok(resolved.agent.session);
  handle=resolved.agent._agentHandle;
  assert.equal(handle,undefined,'native Agents do not expose their owning AgentHandle');
  assert.equal(clock.pending(),0,'the open viewer prevents timer scheduling');
  const beforeEviction=await fs.readFile(f.file);
  const beforeEvictionHash=crypto.createHash('sha256').update(beforeEviction).digest('hex');
  await follow.return();
  assert.equal(clock.pending(),1,'closing the last viewer arms one-shot timer');
  await clock.advance(5*60_000);
  await controller.manager.waitUntilAvailable(f.header.id);
  assert.equal(f.ctx.get('agents').get(f.header.id),undefined,'the exact controller-owned Agent was disposed');
  const afterEviction=await fs.readFile(f.file);
  assert.equal(afterEviction.length,beforeEviction.length);
  assert.equal(crypto.createHash('sha256').update(afterEviction).digest('hex'),beforeEvictionHash);
  const reopened=await f.ctx.get('sessionQuery').observeSession(f.header.id,{projectionMode:'none'});
  assert.deepEqual(f.libs.session.Session.fromRestore(f.header.id,reopened.events,reopened.header,0,'detached').deriveMessages(),expected);
  reopened[Symbol.dispose]();
  assert.ok(original.length>0 && originalHash.length===64);

  const prompt={sessionId:f.header.id,requestId:'task-3b-retry',content:[{type:'text',text:'synthetic local prompt'}],mode:'queue'};
  assert.deepEqual(await controller.prompt(prompt,new AbortController().signal),{accepted:true});
  const restored=f.ctx.get('agents').get(f.header.id);
  assert.ok(restored,'native prompt resumed the durable session');
  assert.equal(restored.id,f.header.id);
  assert.notEqual(restored,resolved.agent);
  assert.deepEqual(await controller.prompt(prompt,new AbortController().signal),{accepted:true});
  const accepted=restored.session.snapshotEvents().filter(event=>event.type==='agent/inbox/spliced'&&event.data.inserted?.some(message=>message.source.rpcId==='task-3b-retry'));
  assert.equal(accepted.length,1,'native prompt retry is idempotent');
 }finally{
  await adapterFiber?.dispose();
  const live=f.ctx.get('agents');
  if(handle && live?.get(handle.agent.id)===handle.agent) await handle.dispose();
  for(const fiber of fibers.reverse()) await fiber.dispose();
  await f.cleanup();
 }
});
