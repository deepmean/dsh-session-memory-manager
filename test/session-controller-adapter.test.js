import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';

const dshRequire = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'));
const cordis = dshRequire('@deepseek-ai/cordis');
const Schemastery = dshRequire('@deepseek-ai/schemastery');
const REMOTE_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

async function adapterFactory() {
 const module = await import('../lib/session-controller-adapter.js').catch(() => undefined);
 assert.equal(typeof module?.createSessionControllerAdapter, 'function', 'adapter factory must be exported');
 return module.createSessionControllerAdapter;
}

function makeBase({onInit, frames = [{type:'snapshot', cursor:7}, {type:'event', seq:8}]} = {}) {
 const descriptor = Object.freeze({version:1, methods:Object.freeze([
  Object.freeze({method:'follow', exportName:'follow', mode:'stream', invocation:Object.freeze({kind:'direct'})}),
  Object.freeze({method:'prompt', exportName:'prompt', invocation:Object.freeze({kind:'direct'})})
 ])});
 class Base {
  static inject = ['agents', 'sessions'];
  static Config = Schemastery.object({upstream:Schemastery.string().default('kept')});
  constructor(ctx, config, internals) { this.ctx=ctx; this.baseArgs=[ctx,config,internals]; }
  async [cordis.Service.init]() { if (onInit) await onInit(this); }
  async *follow(request, signal) { this.followArgs=[request,signal]; yield* frames; }
  create(request) { return this._create ? this._create(request) : Promise.resolve({sessionId:request?.sessionId??'created'}); }
   resolveAgent(sessionId) { return this.agents.resolveAgent(sessionId); }
   prompt(request) { this.promptArgs=request; return 'prompt-result'; }
  updateQueue(request) { this.queueArgs=request; return 'queue-result'; }
  cancel(request) { this.cancelArgs=request; return 'cancel-result'; }
 }
 Object.defineProperty(Base.prototype, REMOTE_DESCRIPTOR, {value:descriptor, configurable:true});
 return {Base, descriptor};
}

function managerStub() {
 const calls=[];
 return {
  calls,
  setIdleMs(ms) { calls.push(['idleMs',ms]); },
  beginActivity(id) { calls.push(['begin',id]);let released=false;return ()=>{if(!released){released=true;calls.push(['end',id]);}}; },
  forget(value) { calls.push(['forget',value]); },
  dispose() { calls.push(['dispose']); },

 track(value) { calls.push(['track',value]); },
  beginActivity(id) { calls.push(['begin',id]);let released=false;return ()=>{if(!released){released=true;calls.push(['end',id]);}}; },
  forget(value) { calls.push(['forget',value]); },
  dispose() { calls.push(['dispose']); },
  noteActivity(id) { calls.push(['activity',id]); },
  viewerOpened(id) { calls.push(['open',id]); let released=false; return () => { if (!released) { released=true; calls.push(['release',id]); } }; },
  isEvicting(id) { return calls.some(call=>call[0]==='evicting'&&call[1]===id); },
  waitUntilAvailable(id) { calls.push(['wait',id]); return calls.find(call=>call[0]==='waitPromise'&&call[1]===id)?.[2] ?? Promise.resolve(); },
  statusChanged(agent) { calls.push(['status',agent]); },
  inboxChanged(agent) { calls.push(['inbox',agent]); }
 };
}

function contextWithAgents(agents) {
 const listeners=new Map();
 return {
  agents,
  extend(meta) { return Object.assign(Object.create(this),meta); },
  on(event,handler) { const entries=listeners.get(event)??[];entries.push(handler);listeners.set(event,entries);return ()=>listeners.set(event,entries.filter(item=>item!==handler)); },
  emit(event,payload) { for (const handler of listeners.get(event)??[]) handler(payload); },
  effect() { return () => {}; },
 };
}

test('adapter preserves the upstream Remote descriptor and Config while adding the idle enum', async () => {
 const create = await adapterFactory();
 const {Base,descriptor} = makeBase();
 const Adapter = create(Base,cordis,{validateInstalledShape:false});
 const ctx=contextWithAgents({});
 const internals={token:'opaque'};
 const instance = new Adapter(ctx,{},internals);
 assert.deepEqual(instance.baseArgs,[ctx,{},internals]);
 assert.deepEqual(Object.keys(Base.Config.dict),['upstream']);
 const ownDescriptor = Object.getOwnPropertyDescriptor(Adapter.prototype,REMOTE_DESCRIPTOR);
 assert.deepEqual(Object.getOwnPropertyDescriptor(Adapter.prototype,REMOTE_DESCRIPTOR),undefined);
 assert.equal(Object.getOwnPropertyDescriptor(Base.prototype,REMOTE_DESCRIPTOR).value,descriptor);
 const parsed=Adapter.Config({});
 assert.equal(parsed.upstream,'kept');
 assert.equal(parsed.idleReclaimMinutes.get(),5);
 assert.equal(Adapter.Config({idleReclaimMinutes:0}).idleReclaimMinutes.get(),0);
 assert.equal(Adapter.Config({idleReclaimMinutes:15}).idleReclaimMinutes.get(),15);
 assert.throws(()=>Adapter.Config({idleReclaimMinutes:2}));
});

test('installed DSH controller shape matches the adapter contract', async () => {
 const create = await adapterFactory();
 const Base=dshRequire('@deepseek-ai/dsh-api-session-controller').SessionController;
 const typert=dshRequire('@deepseek-ai/dsh-typert-protocol');
 const initialBaseDescriptor=Object.getOwnPropertyDescriptor(Base.prototype,REMOTE_DESCRIPTOR);
 const baseConfigKeys=Object.keys(Base.Config.dict);
 const Adapter=create(Base,cordis);
 const adapted=new Adapter(new cordis.Context(),{});
 assert.equal(initialBaseDescriptor,undefined);
 const baseDescriptor=Object.getOwnPropertyDescriptor(Base.prototype,REMOTE_DESCRIPTOR);
 const adaptedDescriptor=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(adapted),REMOTE_DESCRIPTOR);
 assert.equal(Base.length,2);
 assert.equal(Base.prototype.constructor.name,'SessionController');
 assert.deepEqual(Base.inject,['agentDefaultModel','agents','attachments','fileUploads','fs','llm','remoteAccess','sessions','sessionProjections','sessionQuery','typert','typertGateway','workspaceRegistry']);
 assert.deepEqual(Object.keys(Base.Config.dict),['nativeOpen','listWorkSliceMs']);
 assert.deepEqual(Adapter.Config.dict.listWorkSliceMs.meta,Base.Config.dict.listWorkSliceMs.meta);
 assert.deepEqual(Adapter.Config.dict.nativeOpen.meta,Base.Config.dict.nativeOpen.meta);
 assert.equal(baseDescriptor,undefined);
 assert.equal(adaptedDescriptor.value.version,1);
 assert.equal(adaptedDescriptor.value.methods.length,25);
 assert.deepEqual(typert.remoteMethods(adapted).map(method=>method.method),adaptedDescriptor.value.methods.map(method=>method.method));
 assert.equal(Adapter.Config({}).listWorkSliceMs,16);
 assert.equal(Adapter.Config({}).idleReclaimMinutes.get(),5);
});

test('host-injected Schemastery removes the DSH_INSTALL_DIR requirement', async () => {
 const create=await adapterFactory();
 const {Base}=makeBase();
 const previous=process.env.DSH_INSTALL_DIR;
 delete process.env.DSH_INSTALL_DIR;
 try {
  const Adapter=create(Base,cordis,{schemastery:Schemastery,validateInstalledShape:false});
  assert.equal(Adapter.Config({}).idleReclaimMinutes.get(),5);
 } finally {
  if (previous===undefined) delete process.env.DSH_INSTALL_DIR;
  else process.env.DSH_INSTALL_DIR=previous;
 }
});
test('service initialization scopes agents, tracks exact handles, hides evicting ids, and restores ctx', async () => {
 const create = await adapterFactory();
 const manager=managerStub();
 const firstAgent={id:'new-id',session:{header:{id:'new-id'}}};
 const secondAgent={id:'resumed-id',session:{header:{id:'resumed-id'}}};
 const createHandle={agent:firstAgent,dispose:async()=>{}};
 const resumeHandle={agent:secondAgent,dispose:async()=>{}};
 const registry={
  async create() { return createHandle; },
  async resume() { return resumeHandle; },
  get(id) { return id==='known-id'?firstAgent:undefined; },
  sentinel:23
 };
 let originalContext, createResult, resumeResult;
 const {Base}=makeBase({onInit:async service=>{
  assert.notEqual(service.ctx,originalContext);
  assert.notEqual(service.ctx.agents,registry);
  createResult=await service.ctx.agents.create({sessionId:'new-id'});
  resumeResult=await service.ctx.agents.resume({resumeSessionId:'resumed-id'});
  manager.calls.push(['evicting','evicting-id']);
  assert.equal(service.ctx.agents.get('evicting-id'),undefined);
  assert.equal(service.ctx.agents.get('known-id'),firstAgent);
  assert.equal(service.ctx.agents.sentinel,23);
 }});
 originalContext=contextWithAgents(registry);
 const Adapter=create(Base,cordis,{createManager:()=>manager,validateInstalledShape:false});
 const service=new Adapter(originalContext,{idleReclaimMinutes:5});
 await service[cordis.Service.init]();
 originalContext.emit('agent/status',{agent:firstAgent,status:'running'});
 originalContext.emit('agent/inbox/inserted',{agent:firstAgent,message:{}});
 assert.deepEqual(manager.calls.filter(call=>call[0]==='status'),[['status',firstAgent]]);
 assert.deepEqual(manager.calls.filter(call=>call[0]==='inbox'),[['inbox',firstAgent]]);
 assert.equal(createResult,createHandle);
 assert.equal(resumeResult,resumeHandle);
 assert.equal(service.ctx,originalContext);
 assert.deepEqual(manager.calls.filter(call=>call[0]==='track').map(call=>call[1].handle),[createHandle,resumeHandle]);
 assert.deepEqual(manager.calls.filter(call=>call[0]==='activity'),[['activity','known-id']]);
});

test('Service.init restores the inherited context when upstream initialization fails', async () => {
 const create=await adapterFactory();
 const manager=managerStub();
 const original=contextWithAgents({create(){throw new Error('unused');},resume(){throw new Error('unused');},get(){return undefined;}});
 const failure=new Error('upstream init failed');
 const {Base}=makeBase({onInit:service=>{assert.notEqual(service.ctx,original);throw failure;}});
 const Adapter=create(Base,cordis,{manager,validateInstalledShape:false});
 const service=new Adapter(original,{idleReclaimMinutes:5});
 await assert.rejects(service[cordis.Service.init](),error=>error===failure);
 assert.equal(service.ctx,original);
});
test('the owning Cordis fiber drains the manager after failed upstream initialization', async () => {
 const create=await adapterFactory();
 const manager=managerStub();
 const root=new cordis.Context();
 const failure=new Error('fixture upstream init failed');
 const {Base}=makeBase({onInit:()=>{throw failure;}});
 const Adapter=create(Base,cordis,{manager,validateInstalledShape:false});
 const fiber=root.plugin({async apply(ctx) {
  const service=new Adapter(ctx.extend({agents:{}}),{});
  await service[cordis.Service.init]();
 }});
 try {
  await assert.rejects(fiber.await(),/fixture upstream init failed/);
  await fiber.dispose();
  assert.equal(manager.calls.filter(call=>call[0]==='dispose').length,1);
 } finally { await root.fiber.dispose(); }
});

test('an installed-style raw Agent resolver retires only the externally borrowed Agent', async () => {
 const create=await adapterFactory();
 const manager=managerStub();
 const agent={id:'borrowed-id'};
 let resolve;
 const {Base}=makeBase({onInit:service=>{
  service.agents={async resolveAgent(id) { assert.equal(id,agent.id);return {agent}; }};
  resolve=id=>service.agents.resolveAgent(id);
 }});
 const service=new (create(Base,cordis,{manager,validateInstalledShape:false}))(contextWithAgents({}),{});
 await service[cordis.Service.init]();
 await service.withActivity({sessionId:agent.id},()=>resolve(agent.id));
 assert.deepEqual(manager.calls.filter(call=>call[0]==='forget'),[]);
 assert.equal((await resolve(agent.id)).agent,agent);
 assert.deepEqual(manager.calls.filter(call=>call[0]==='forget'),[['forget',{sessionId:agent.id,agent}]]);
});

test('public resolver retires a borrowed Agent from idle tracking once', async () => {
 const create=await adapterFactory();
 const manager=managerStub();
 const agent={id:'public-borrowed'};
 const {Base}=makeBase({onInit:service=>{
  service.agents={async resolveAgent(id) { assert.equal(id,agent.id);return {agent}; }};
 }});
 const service=new (create(Base,cordis,{manager,validateInstalledShape:false}))(contextWithAgents({}),{});
 await service[cordis.Service.init]();
 assert.equal((await service.resolveAgent(agent.id)).agent,agent);
 assert.equal(manager.calls.filter(call=>call[0]==='forget').length,1);
});

test('minted-ID create refreshes the tracked Agent after the scoped registry create completes', async () => {
 const create=await adapterFactory();
 const id='minted-session';
 const agent={id,session:{header:{id}}};
 const handle={agent,dispose(){}};
 const registry={async create(options){assert.equal(options.sessionId,id);return handle;},async resume(){throw new Error('unused');},get(){return agent;}};
 const manager=managerStub();
 const ctx=contextWithAgents(registry);
 const {Base}=makeBase({onInit:service=>{
  const scoped=service.ctx.agents;
  service._create=async()=>{await scoped.create({sessionId:id});return {sessionId:id};};
 }});
 const Adapter=create(Base,cordis,{validateInstalledShape:false,manager});
 const service=new Adapter(ctx,{});
 await service[cordis.Service.init]();
 assert.deepEqual(await service.create({}),{sessionId:id});
 assert.equal(manager.calls.some(call=>call[0]==='track' && call[1].handle===handle),true);
 const begin=manager.calls.findIndex(call=>call[0]==='begin'&&call[1]===id);
  const track=manager.calls.findIndex(call=>call[0]==='track'&&call[1].handle===handle);
  const end=manager.calls.findIndex(call=>call[0]==='end'&&call[1]===id);
  assert.ok(begin>=0&&begin<track&&track<end,'the inner Registry.create lease spans exact-handle tracking');
  assert.deepEqual(manager.calls.filter(call=>call[0]==='activity'),[['activity',id]]);
});

test('factory-injected manager ignores subagent-origin AgentHandles', async () => {
 const create=await adapterFactory();
 const manager=managerStub();
 const regular={id:'regular',session:{header:{id:'regular'}}};
 const child={id:'child',session:{header:{id:'child',origin:'subagent'}}};
 const regularHandle={agent:regular,dispose:async()=>{}};
 const childHandle={agent:child,dispose:async()=>{}};
 const registry={async create(options){return options.sessionId==='child'?childHandle:regularHandle;},async resume(){throw new Error('unused');},get(){return undefined;}};
 const {Base}=makeBase({onInit:async service=>{
  assert.equal(await service.ctx.agents.create({sessionId:'regular'}),regularHandle);
  assert.equal(await service.ctx.agents.create({sessionId:'child'}),childHandle);
 }});
 const Adapter=create(Base,cordis,{manager,validateInstalledShape:false});
 const service=new Adapter(contextWithAgents(registry),{idleReclaimMinutes:5});
 await service[cordis.Service.init]();
 assert.deepEqual(manager.calls.filter(call=>call[0]==='track').map(call=>call[1].handle),[regularHandle]);
});

test('resume waits for an in-flight eviction before invoking AgentRegistry.resume', async () => {
 const create = await adapterFactory();
 const manager=managerStub();
 let unlock;
 const pending=new Promise(resolve=>{unlock=resolve;});
 manager.calls.push(['waitPromise','blocked-id',pending]);
 let resumed=false;
 const registry={
  async resume() { resumed=true; return {agent:{id:'blocked-id',session:{header:{id:'blocked-id'}}},dispose:async()=>{}}; },
  async create() { throw new Error('unused'); },
  get() { return undefined; }
 };
 const {Base}=makeBase({onInit:async service=>{
  const result=service.ctx.agents.resume({resumeSessionId:'blocked-id'});
  await Promise.resolve();
  assert.equal(resumed,false);
  unlock();
  await result;
 }});
 const service=new (create(Base,cordis,{createManager:()=>manager,validateInstalledShape:false}))(contextWithAgents(registry),{idleReclaimMinutes:5});
 await service[cordis.Service.init]();
 assert.equal(resumed,true);
 assert.deepEqual(manager.calls.find(call=>call[0]==='wait'),['wait','blocked-id']);
});

test('follow forces passive mode, preserves frames, and releases its viewer lease on early close', async () => {
 const create = await adapterFactory();
 const manager=managerStub();
 const {Base}=makeBase();
 const Adapter=create(Base,cordis,{createManager:()=>manager,validateInstalledShape:false});
 const service=new Adapter(contextWithAgents({}), {idleReclaimMinutes:5});
 await service[cordis.Service.init]();
 const frames=[{type:'snapshot',cursor:7},{type:'event',seq:8}];
 const iterator=service.follow({address:{kind:'session',sessionId:'history-id'},activate:true},new AbortController().signal);
 assert.deepEqual(await iterator.next(),{value:frames[0],done:false});
 assert.deepEqual(service.followArgs[0],{address:{kind:'session',sessionId:'history-id'},activate:false});
 await iterator.return();
 assert.deepEqual(manager.calls.filter(call=>['open','release'].includes(call[0])),[['open','history-id'],['release','history-id']]);
});

test('abort while a follow waits for eviction releases the viewer without opening native history', async () => {
 const create=await adapterFactory();
 const manager=managerStub();
 const pending=Promise.withResolvers();
 manager.calls.push(['evicting','history-id'],['waitPromise','history-id',pending.promise]);
 const {Base}=makeBase();
 const service=new (create(Base,cordis,{manager,validateInstalledShape:false}))(contextWithAgents({}),{});
 await service[cordis.Service.init]();
 const abort=new AbortController();
 const iterator=service.follow({address:{kind:'session',sessionId:'history-id'},activate:true},abort.signal);
 const result=iterator.next();
 abort.abort();
 try {
  await assert.rejects(Promise.race([result,new Promise((_,reject)=>setImmediate(()=>reject(new Error('aborted follow is still waiting'))))]),{name:'AbortError'});
  assert.equal(service.followArgs,undefined);
  assert.deepEqual(manager.calls.filter(call=>['open','release'].includes(call[0])),[['open','history-id'],['release','history-id']]);
 } finally { pending.resolve(); await iterator.return(); }
});

test('host-only refresh reads the current outer volatile config and updates idle delay', async () => {
 const module=await import('../lib/session-controller-adapter.js');
 assert.equal(typeof module.createSessionMemoryConfig,'function');
 const create=module.createSessionControllerAdapter;
 const {Base}=makeBase();
 const manager=managerStub();
 let minutes=1;
 const Adapter=create(Base,cordis,{manager,getIdleReclaimMinutes:()=>minutes,validateInstalledShape:false});
 const service=new Adapter(contextWithAgents({}),{idleReclaimMinutes:5});
 await service[cordis.Service.init]();
 assert.equal(typeof service.refreshIdleReclaim,'function');
 minutes=15;
 service.refreshIdleReclaim();
 assert.deepEqual(manager.calls.filter(call=>call[0]==='idleMs'),[['idleMs',900000]]);
 assert.equal(manager.calls.some(call=>call[0]==='activity'),false);
});

test('Agent-mutating commands mark target activity before delegating unchanged requests', async () => {
 const create = await adapterFactory();
 const manager=managerStub();
 const {Base}=makeBase();
 const service=new (create(Base,cordis,{createManager:()=>manager,validateInstalledShape:false}))(contextWithAgents({}), {idleReclaimMinutes:5});
 await service[cordis.Service.init]();
 const prompt={sessionId:'p',content:[{type:'text',text:'hello'}]};
 const queue={sessionId:'q',itemId:'item'};
 const cancel={sessionId:'c'};
 assert.equal(await service.prompt(prompt),'prompt-result');
 assert.equal(await service.updateQueue(queue),'queue-result');
 assert.equal(await service.cancel(cancel),'cancel-result');
 assert.deepEqual(manager.calls.filter(call=>call[0]==='activity'),[['activity','p'],['activity','q'],['activity','c']]);
 assert.equal(service.promptArgs,prompt);
 assert.equal(service.queueArgs,queue);
 assert.equal(service.cancelArgs,cancel);
});
