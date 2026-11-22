import {createRequire} from 'node:module';
import {AsyncLocalStorage} from 'node:async_hooks';
import path from 'node:path';
import {clearTimeout} from 'node:timers';
import {createIdleAgentManager} from './idle-agent-manager.js';

const REMOTE_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';
const IDLE_RECLAIM_MINUTES = [0, 1, 5, 15];
const INSTALLED_INJECT = ['agentDefaultModel','agents','attachments','fileUploads','fs','llm','remoteAccess','sessions','sessionProjections','sessionQuery','typert','typertGateway','workspaceRegistry'];
const INSTALLED_CONFIG = ['nativeOpen','listWorkSliceMs'];
const INSTALLED_REMOTE_METHODS = ['list','search','create','selectModel','initializeDefaultModel','modelCatalog','canOpenWorkspacePath','openWorkspacePath','workspacePathApplications','rename','fork','prompt','attachment','updateQueue','cancel','page','events','observeEvent','observeProjections','state','observeState','wait','follow','projections','control'];
const STREAM_METHODS = new Set(['observeEvent','observeProjections','observeState','follow','control']);
const INBOX_EVENTS = ['agent/inbox/inserted','agent/inbox/claimed','agent/inbox/discarded','agent/inbox/spliced'];
const noop = () => {};

function loadSchemastery() {
 const installDir=process.env.DSH_INSTALL_DIR;
 if(!installDir) throw new Error('DSH_INSTALL_DIR is required to load the installed Schemastery schema factory');
 return createRequire(path.join(installDir,'package.json'))('@deepseek-ai/schemastery');
}
function sessionIdFromAddress(address) {
 if(address?.kind==='session') return address.sessionId;
 if(address?.kind==='subagent') return address.childSessionId;
 return undefined;
}
function validateRemoteDescriptor(descriptor) {
 const methods=descriptor?.value?.methods;
 if(descriptor?.value?.version!==1 || !Array.isArray(methods)
  || JSON.stringify(methods.map(marker=>marker.method))!==JSON.stringify(INSTALLED_REMOTE_METHODS)
  || methods.some(marker=>marker.invocation?.kind!=='direct' || marker.exportName!==undefined || marker.resources!==undefined
   || (marker.mode==='stream')!==STREAM_METHODS.has(marker.method)))
  throw new Error('installed SessionController Remote methods are incompatible with the memory adapter');
}
function validateInstalledController(Base,cordis,{remote=false,descriptor}={}) {
 if(Base.name!=='SessionController' || Base.length!==2 || Object.getPrototypeOf(Base.prototype)?.constructor?.name!=='TypertRemoteService')
  throw new Error('installed SessionController constructor is incompatible with the memory adapter');
 if(JSON.stringify(Base.inject)!==JSON.stringify(INSTALLED_INJECT)
  || JSON.stringify(Object.keys(Base.Config.dict))!==JSON.stringify(INSTALLED_CONFIG)
  || Base.Config({}).listWorkSliceMs!==16 || Base.Config.dict.listWorkSliceMs?.type!=='number'
  || Base.Config.dict.listWorkSliceMs?.meta?.min!==1 || Base.Config.dict.nativeOpen?.type!=='boolean'
  || typeof Base.prototype?.[cordis.Service.init]!=='function')
  throw new Error('installed SessionController dependencies or Config schema are incompatible with the memory adapter');
 if(remote) validateRemoteDescriptor(descriptor??Object.getOwnPropertyDescriptor(Base.prototype,REMOTE_DESCRIPTOR));
}

export function createSessionMemoryConfig(Base,schemastery) {
 if(typeof Base?.Config?.toJSON!=='function' || typeof schemastery!=='function'
  || typeof schemastery.union!=='function' || typeof schemastery.const!=='function')
  throw new TypeError('session memory config requires Base.Config and Schemastery');
 const config=new schemastery(Base.Config.toJSON());
 const idle=schemastery.union(IDLE_RECLAIM_MINUTES.map(value=>schemastery.const(value)))
  .default(5).description('Minutes of inactivity before an idle owned Agent is reclaimed; 0 disables reclamation.').volatile();
 return config.set('idleReclaimMinutes',idle);
}

function trackHandle(manager,handle,owned) {
 const agent=handle?.agent;
 if(!agent || agent.session?.header?.origin==='subagent') return;
 manager?.track({sessionId:agent.id,agent,handle,provenance:owned?'owned':'external'});
}
function scopedAgentRegistry(registry,manager,ownership) {
 if(!registry || typeof registry!=='object') throw new TypeError('session controller requires ctx.agents');
 return new Proxy(registry,{get(target,property){
  const original=Reflect.get(target,property,target);
  if(property==='get' && typeof original==='function') return function get(sessionId,...args){
   if(manager?.isEvicting(sessionId)) return undefined;
   const agent=Reflect.apply(original,target,[sessionId,...args]);
   if(agent!==undefined) {
    manager?.noteActivity(sessionId);
   }
   return agent;
  };
  if(property==='resume' && typeof original==='function') return async function resume(options,...args){
   const sessionId=options?.resumeSessionId;
   const release=sessionId===undefined?undefined:manager?.beginActivity(sessionId);
   try {
    if(sessionId!==undefined) await manager?.waitUntilAvailable(sessionId);
    const owned=ownership.getStore()===true;
     const handle=owned?await ownership.run(true,()=>Reflect.apply(original,target,[options,...args])):await Reflect.apply(original,target,[options,...args]);
    trackHandle(manager,handle,owned);
    return handle;
   } finally { release?.(); }
  };
  if(property==='create' && typeof original==='function') return async function create(options,...args){
   const sessionId=options?.sessionId;
   const release=sessionId===undefined?undefined:manager?.beginActivity(sessionId);
   try {
    const owned=ownership.getStore()===true;
     const handle=owned?await ownership.run(true,()=>Reflect.apply(original,target,[options,...args])):await Reflect.apply(original,target,[options,...args]);
    trackHandle(manager,handle,owned);
    return handle;
   } finally { release?.(); }
  };
  return typeof original==='function'?original.bind(target):original;
 },set(target,property,value){return Reflect.set(target,property,value,target);}});
}
// ApiSessionAgentController is captured by native command/upload/Typert closures.
// Protect only that per-adapter instance; never mutate the installed prototype.
function protectExternalResolver(agentController,manager,ownership) {
 const resolve=agentController?.resolveAgent;
 if(typeof resolve!=='function') return false;
 Object.defineProperty(agentController,'resolveAgent',{
  configurable:true,writable:true,value:async function resolveAgent(sessionId) {
   if(ownership.getStore()===true) return resolve.call(this,sessionId);
   const release=manager.beginActivity(sessionId);
   try {
    await manager.waitUntilAvailable(sessionId);
    const result=await resolve.call(this,sessionId);
    if(result?.agent) manager.forget({sessionId,agent:result.agent});
     return result;

   } finally { release(); }
  },
 });
 return true;
}

function minutesFrom(options,config,fallback=5) {
 const value=options.getIdleReclaimMinutes?.() ?? options.idleReclaimMinutes?.get?.()
  ?? config?.idleReclaimMinutes?.get?.() ?? config?.idleReclaimMinutes ?? fallback;
 return IDLE_RECLAIM_MINUTES.includes(value)?value:0;
}
function makeManager(ctx,minutes,options) {
 return createIdleAgentManager({idleMs:minutes*60_000,
  setTimer(callback,delay){const timer=(options.setTimer??setTimeout)(callback,delay);timer.unref?.();return timer;},clearTimer:options.clearTimer??clearTimeout,
  onError(error){try{ctx.logger?.warn?.(`session-memory-manager: idle reclaim failed: ${String(error).slice(0,240)}`);}catch{}},
  isCurrent({sessionId,agent,handle}){return ctx.agents?.get(sessionId)===agent && ctx.sessions?.get(sessionId)===agent.session
   && handle.agent===agent && agent.session?.header?.origin===undefined && agent.phase?.kind==='idle'
   && agent.inbox?.nextTurn?.length===0 && agent.inbox?.nextStep?.length===0;}});
}

export function createSessionControllerAdapter(Base,cordis,options={}) {
 if(typeof Base!=='function' || typeof cordis?.Service?.init!=='symbol')
  throw new TypeError('session controller adapter requires the installed Base class and Cordis Service.init symbol');
 const schemastery=options.schemastery??loadSchemastery();
 if(options.validateInstalledShape!==false && (typeof Base.Config?.set!=='function' || !Array.isArray(Base.inject)
  || !Base.inject.includes('agents') || typeof Base.prototype?.[cordis.Service.init]!=='function'))
  throw new Error('installed SessionController shape is incompatible with the memory adapter');
 if(options.validateInstalledShape!==false) validateInstalledController(Base,cordis);
 const AdapterConfig=createSessionMemoryConfig(Base,schemastery);
 const ownership=new AsyncLocalStorage();

 class SessionControllerAdapter extends Base {
  static Config=AdapterConfig;
  constructor(ctx,config,internals) {
   super(ctx,config,internals);
   this.config=config;
   this.idleReclaimMinutes=minutesFrom(options,config,5);
    const descriptor=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this),REMOTE_DESCRIPTOR)
     ?? Object.getOwnPropertyDescriptor(Base.prototype,REMOTE_DESCRIPTOR);

   if(options.validateInstalledShape!==false) validateInstalledController(Base,cordis,{remote:true,descriptor});
   else if(!descriptor || descriptor.value?.version!==1 || !Array.isArray(descriptor.value.methods))
    throw new Error('installed SessionController Remote method descriptor is missing or incompatible');

  }
  refreshIdleReclaim() { this.manager?.setIdleMs(minutesFrom(options,this.config,this.idleReclaimMinutes)*60_000); }
  async [cordis.Service.init]() {
   const ctx=this.ctx;
   const minutes=minutesFrom(options,this.config,this.idleReclaimMinutes);
   const manager=options.createManager?.(minutes,ctx)??options.manager??makeManager(ctx,minutes,options);
   this.manager=manager;
   const disposers=[];
   const listen=(event,handler)=>{const remove=ctx.on(event,handler);if(typeof remove==='function')disposers.push(remove);};
   listen('agent/status',({agent})=>manager.statusChanged(agent));
   for(const event of INBOX_EVENTS) listen(event,({agent})=>manager.inboxChanged(agent));
   listen('agent/disposed',({agent})=>manager.forget({sessionId:agent.id,agent}));
   listen('loader/volatile-update',()=>this.refreshIdleReclaim());
   const cleanup=async()=>{for(const remove of disposers.splice(0))remove();await manager.dispose?.();};
   if(typeof ctx.effect==='function') ctx.effect(()=>cleanup,'session-memory-manager lifecycle');
   this.ctx=ctx.extend({agents:scopedAgentRegistry(ctx.agents,manager,ownership)});
   try { await super[cordis.Service.init](); } finally { this.ctx=ctx; }
   if(!protectExternalResolver(this.agents,manager,ownership) && options.validateInstalledShape!==false)
    throw new Error('installed SessionController Agent resolver is incompatible with the memory adapter');
  }
  async *follow(request,signal) {
   const id=sessionIdFromAddress(request?.address);
   const release=id===undefined?undefined:this.manager?.viewerOpened(id);
   let onAbort;
   try {
    signal?.throwIfAborted();
    if(id!==undefined){
     const available=this.manager?.waitUntilAvailable(id);
     if(signal && available){
      const aborted=new Promise((_,reject)=>{
       onAbort=()=>reject(signal.reason??new DOMException('The operation was aborted','AbortError'));
       signal.addEventListener('abort',onAbort,{once:true});
      });
      await Promise.race([available,aborted]);
     } else await available;
    }
    signal?.throwIfAborted();
    yield* super.follow({...request,activate:false},signal);
   } finally {
    if(onAbort) signal.removeEventListener('abort',onAbort);
    release?.();
   }
  }
  async withActivity(request,operation) {
   const id=request?.sessionId??sessionIdFromAddress(request?.address);
   const release=id===undefined?noop:(this.manager?.beginActivity(id)??noop);
   try { if(id!==undefined) await this.manager?.waitUntilAvailable(id);this.manager?.noteActivity(id);return await ownership.run(true,operation); }
   finally { release(); }
  }
  create(request){return this.withActivity(request,()=>super.create(request));}
  selectModel(request){return this.withActivity(request,()=>super.selectModel(request));}
  initializeDefaultModel(){return ownership.run(true,()=>super.initializeDefaultModel());}
  rename(request){return this.withActivity(request,()=>super.rename(request));}
  fork(request){return this.withActivity(request,()=>super.fork(request));}
  prompt(request,signal){return this.withActivity(request,()=>super.prompt(request,signal));}
  attachment(request){return super.attachment(request);}
  updateQueue(request){return this.withActivity(request,()=>super.updateQueue(request));}
  cancel(request){
   const id=request?.sessionId;
   const release=id===undefined?noop:(this.manager?.beginActivity(id)??noop);
   try { this.manager?.noteActivity(id);return super.cancel(request); }
   finally { release(); }
  }
  async resolveAgent(sessionId){
   await this.manager?.waitUntilAvailable(sessionId);
   return super.resolveAgent(sessionId);
   }
 }

 //
 return SessionControllerAdapter;
}
export {REMOTE_DESCRIPTOR as SESSION_CONTROLLER_REMOTE_DESCRIPTOR};
