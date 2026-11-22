import {createRequire} from 'node:module';
import path from 'node:path';

const REMOTE_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';
const IDLE_RECLAIM_MINUTES = [0, 1, 5, 15];
const INSTALLED_INJECT = ['agentDefaultModel','agents','attachments','fileUploads','fs','llm','remoteAccess','sessions','sessionProjections','sessionQuery','typert','typertGateway','workspaceRegistry'];
const INSTALLED_CONFIG = ['nativeOpen','listWorkSliceMs'];
const INSTALLED_REMOTE_METHODS = ['list','search','create','selectModel','initializeDefaultModel','modelCatalog','canOpenWorkspacePath','openWorkspacePath','workspacePathApplications','rename','fork','prompt','attachment','updateQueue','cancel','page','events','observeEvent','observeProjections','state','observeState','wait','follow','projections','control'];
const STREAM_METHODS = new Set(['observeEvent','observeProjections','observeState','follow','control']);

function loadSchemastery() {
 const installDir = process.env.DSH_INSTALL_DIR;
 if (!installDir) throw new Error('DSH_INSTALL_DIR is required to load the installed Schemastery schema factory');
 return createRequire(path.join(installDir, 'package.json'))('@deepseek-ai/schemastery');
}

function sessionIdFromAddress(address) {
 if (address?.kind === 'session') return address.sessionId;
 if (address?.kind === 'subagent') return address.childSessionId;
 return undefined;
}

function trackHandle(manager, handle) {
 const agent = handle?.agent;
 if (!agent || agent.session?.header?.origin === 'subagent') return;
 manager?.track({sessionId:agent.id, agent, handle, provenance:'owned'});
}

function scopedAgentRegistry(registry, manager) {
 if (!registry || typeof registry !== 'object') throw new TypeError('session controller requires ctx.agents');
 return new Proxy(registry, {
  get(target, property) {
   const original = Reflect.get(target, property, target);
   if (property === 'get' && typeof original === 'function') {
    return function get(sessionId, ...args) {
     if (manager?.isEvicting(sessionId)) return undefined;
     const agent = Reflect.apply(original, target, [sessionId, ...args]);
     if (agent !== undefined) manager?.noteActivity(sessionId);
     return agent;
    };
   }
   if (property === 'resume' && typeof original === 'function') {
    return async function resume(options, ...args) {
     const sessionId = options?.resumeSessionId;
     if (sessionId !== undefined) await manager?.waitUntilAvailable(sessionId);
     const handle = await Reflect.apply(original, target, [options, ...args]);
     trackHandle(manager, handle);
     return handle;
    };
   }
   if (property === 'create' && typeof original === 'function') {
    return async function create(options, ...args) {
     const handle = await Reflect.apply(original, target, [options, ...args]);
     trackHandle(manager, handle);
     return handle;
    };
   }
   if (typeof original === 'function') return original.bind(target);
   return original;
  },
  set(target, property, value) { return Reflect.set(target, property, value, target); },
 });
}

function noteRequestActivity(manager, request) {
 if (typeof request?.sessionId === 'string') manager?.noteActivity(request.sessionId);
}

function validateInstalledController(Base, cordis, {remote = true} = {}) {
 if (Base.name !== 'SessionController' || Base.length !== 2
   || Object.getPrototypeOf(Base.prototype)?.constructor?.name !== 'TypertRemoteService') {
  throw new Error('installed SessionController constructor is incompatible with the memory adapter');
 }
 if (JSON.stringify(Base.inject) !== JSON.stringify(INSTALLED_INJECT)
   || JSON.stringify(Object.keys(Base.Config.dict)) !== JSON.stringify(INSTALLED_CONFIG)
   || Base.Config({}).listWorkSliceMs !== 16
   || Base.Config.dict.listWorkSliceMs?.type !== 'number'
   || Base.Config.dict.listWorkSliceMs?.meta?.min !== 1
   || Base.Config.dict.nativeOpen?.type !== 'boolean') {
  throw new Error('installed SessionController dependencies or Config schema are incompatible with the memory adapter');
 }
 if (!remote) return;
 const descriptor = Object.getOwnPropertyDescriptor(Base.prototype, REMOTE_DESCRIPTOR);
 const methods = descriptor?.value?.methods;
 if (descriptor?.value?.version !== 1 || !Array.isArray(methods)
   || JSON.stringify(methods.map(marker=>marker.method)) !== JSON.stringify(INSTALLED_REMOTE_METHODS)
   || methods.some(marker => marker.invocation?.kind !== 'direct'
     || marker.exportName !== undefined || marker.resources !== undefined
     || (marker.mode === 'stream') !== STREAM_METHODS.has(marker.method))) {
  throw new Error('installed SessionController Remote methods are incompatible with the memory adapter');
 }
}

/** Build a version-checked adapter while keeping the installed controller as the implementation base. */
export function createSessionControllerAdapter(Base, cordis, options = {}) {
 if (typeof Base !== 'function' || typeof cordis?.Service?.init !== 'symbol') {
  throw new TypeError('session controller adapter requires the installed Base class and Cordis Service.init symbol');
 }
 const schemastery = options.schemastery ?? loadSchemastery();
 if (options.validateInstalledShape !== false && (typeof Base.Config?.set !== 'function' || !Array.isArray(Base.inject)
   || !Base.inject.includes('agents') || typeof Base.prototype?.[cordis.Service.init] !== 'function')) {
  throw new Error('installed SessionController shape is incompatible with the memory adapter');
 }
 if (options.validateInstalledShape !== false) validateInstalledController(Base, cordis, {remote:false});
  const upstreamConfig = new schemastery(Base.Config.toJSON());
 const idleSchema = schemastery.union(IDLE_RECLAIM_MINUTES.map(value=>schemastery.const(value)))
  .default(5).description('Minutes of inactivity before an idle owned Agent is reclaimed; 0 disables reclamation.');

 class SessionControllerAdapter extends Base {
  static Config = upstreamConfig.set('idleReclaimMinutes', idleSchema);

  constructor(ctx, config, internals) {
   super(ctx, config, internals);
   this.idleReclaimMinutes = config?.idleReclaimMinutes ?? 5;
    if (options.validateInstalledShape !== false) validateInstalledController(Base, cordis);
   const descriptor = Object.getOwnPropertyDescriptor(Base.prototype, REMOTE_DESCRIPTOR);
   if (descriptor === undefined || descriptor.value?.version !== 1 || !Array.isArray(descriptor.value.methods)) {
    throw new Error('installed SessionController Remote method descriptor is missing or incompatible');
   }
   Object.defineProperty(SessionControllerAdapter.prototype, REMOTE_DESCRIPTOR, descriptor);
  }

  async [cordis.Service.init]() {
   const originalContext = this.ctx;
   const manager = options.createManager?.(this.idleReclaimMinutes, originalContext) ?? options.manager;
   if (manager !== undefined) this.manager = manager;
   const scopedContext = originalContext.extend({agents:scopedAgentRegistry(originalContext.agents, manager)});
   this.ctx = scopedContext;
   try {
    await super[cordis.Service.init]();
   } finally {
    this.ctx = originalContext;
   }
   if (manager) {
    originalContext.on('agent/status', ({agent})=>manager.statusChanged(agent));
    for (const event of ['agent/inbox/inserted','agent/inbox/claimed','agent/inbox/discarded','agent/inbox/spliced']) {
     originalContext.on(event, ({agent})=>manager.inboxChanged(agent));
    }
   }
  }

  async *follow(request, signal) {
   const sessionId = sessionIdFromAddress(request?.address);
    const release = sessionId === undefined ? undefined : this.manager?.viewerOpened(sessionId);
   try {
    yield* super.follow({...request, activate:false}, signal);
   } finally {
    release?.();
   }
  }

  selectModel(request) {
   noteRequestActivity(this.manager,request);
   return super.selectModel(request);
  }

  rename(request) {
   noteRequestActivity(this.manager,request);
   return super.rename(request);
  }

  fork(request) {
   noteRequestActivity(this.manager,request);
   return super.fork(request);
  }

  prompt(request, signal) {
   noteRequestActivity(this.manager,request);
   return super.prompt(request,signal);
  }

  updateQueue(request) {
   noteRequestActivity(this.manager,request);
   return super.updateQueue(request);
  }

  cancel(request) {
   noteRequestActivity(this.manager,request);
   return super.cancel(request);
  }
 }

 const existingRemoteDescriptor = Object.getOwnPropertyDescriptor(Base.prototype, REMOTE_DESCRIPTOR);
 if (existingRemoteDescriptor !== undefined) {
  Object.defineProperty(SessionControllerAdapter.prototype, REMOTE_DESCRIPTOR, existingRemoteDescriptor);
 }
 return SessionControllerAdapter;
}

export {REMOTE_DESCRIPTOR as SESSION_CONTROLLER_REMOTE_DESCRIPTOR};
