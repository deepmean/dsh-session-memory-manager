import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';

let createAgentLoopClass;
let createQueryClass;
try { ({ createAgentLoopClass, createQueryClass } = await import('../lib/consumer-adapters.js')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const fullEvent = { type: 'tool/ptc-dispatch', seq: 0, time: 1, data: {
  rootCallId: 'r', parentCallId: 'r', subCallId: 'r:ptc:0', name: 'read',
  arguments: { file_path: 'fixture.txt' }, content: [], isError: false,
  meta: { path: 'fixture.txt', offset: 1, lines: [{ number: 1, text: 'full original' }], totalLines: 1 },
} };
const previewEvent = { ...fullEvent, data: { ...fullEvent.data,
  meta: { ...fullEvent.data.meta, lines: [], locator: { seq: 0 } } } };
const clone = value => structuredClone(value);

function context({ adapted = true, gate } = {}) {
  const mode = new AsyncLocalStorage();
  const disposers = [];
  const state = { refs: 0, restored: 0, reads: [], gate, liveEvents: undefined };
  const backend = { identity: Symbol('persistence'),
    diskController: { async restoreEvent(event, { ownerId, signal } = {}) {
      assert.equal(ownerId, 'owner'); signal?.throwIfAborted(); state.restored++;
      return event.data.meta.locator ? clone(fullEvent) : event;
    } },
  };
  if (adapted) {
    backend.runPresentation = operation => mode.run('presentation', operation);
    backend.runFull = operation => mode.run('full', operation);
  }
  const ctx = {
    backend, state, mode,
    get(name) { assert.equal(name, 'sessionPersistence'); return backend; },
    effect(factory) { const dispose = factory(); disposers.push(dispose); return dispose; },
    dispose() { for (const dispose of disposers) dispose(); },
  };
  return ctx;
}

class DshSessionFixture {
  constructor(header,events){this.header=header;this.events=events;}
  get id(){return this.header.id;}
  snapshotEvents(){return this.events;}
}
function cachedEntry(id, revision, events) {
  const header={id,version:4,createdAt:1,isSeeded:false};
  const session=new DshSessionFixture(header,Object.freeze(events));
  return {persistedEventCount:events.length,persistenceIdentity:Symbol('persistence'),revision,session,events:session.events,refs:0};
}

function observation(entry, state) {
  state.refs++; entry.refs++;
  let disposed = false;
  return {
    source: 'prepared', header: entry.session.header,
    inheritedEventCount:0,persistedEventCount:entry.persistedEventCount,
    events: entry.events, cursor: 0, revision: entry.revision,
    projections: { asOfSeq: 0, values: { title: 'fixture' } },
    retain() { if (disposed) throw new Error('disposed source lease'); return observation(entry, state); },
    [Symbol.dispose]() { if (disposed) return; disposed = true; entry.refs--; state.refs--; },
  };
}

class ReaderFixture {
  constructor(ctx, cacheCapacity = 5) {
    this.ctx = ctx; this.cacheCapacity = cacheCapacity; this.cache = new Map();
  }
  async read(id, options = {}) {
    options.signal?.throwIfAborted();
    const mode = this.ctx.mode.getStore() ?? 'full';
    await this.ctx.state.gate?.(mode);
    let entry = this.cache.get(id);
    if (!entry) {
      const events = this.ctx.state.liveEvents ?? [clone(mode === 'presentation' ? previewEvent : fullEvent)];
      entry = cachedEntry(id,'fixture-revision',events);
      this.cache.set(id, entry);
      while (this.cache.size > this.cacheCapacity) this.cache.delete(this.cache.keys().next().value);
      this.ctx.state.reads.push(mode);
    }
    return observation(entry, this.ctx.state);
  }
  async inspect(id, getter, signal) {
    const lease = await this.read(id, { signal });
    try { return getter({ id, events: lease.events }); }
    finally { lease[Symbol.dispose](); }
  }
}

class QueryFixture {
  static Config = { pinned: 'native-schema' };
  static inject = ['sessions'];
  constructor(ctx, config = {}) {
    this.ctx = ctx; this.config = config;
    this._observations = new ReaderFixture(ctx, config.preparedSessionCacheSize ?? 5);
  }
  observeSession(id, options) { return this._observations.read(id, options); }
  inspectSession(id, getter, signal) { return this._observations.inspect(id, getter, signal); }
  async readTitle(id) { assert.equal(id, 'owner'); return this.ctx.mode.getStore() ?? 'full'; }
  async readTitleSnapshots() { return this.ctx.mode.getStore() ?? 'full'; }
  async searchEvents() { return this.ctx.mode.getStore() ?? 'full'; }
  async readEvent() { return this.ctx.mode.getStore() ?? 'full'; }
}

function fakeClock() {
  let now = 0, id = 0;
  const tasks = new Map();
  return {
    setTimeout(callback, delay) { const token = ++id; tasks.set(token, { at: now + delay, callback }); return token; },
    clearTimeout(token) { tasks.delete(token); },
    advance(ms) { now += ms; for (const [token, task] of [...tasks]) if (task.at <= now) { tasks.delete(token); task.callback(); } },
    pending() { return tasks.size; },
  };
}

function query(options = {}) {
  assert.equal(typeof createQueryClass, 'function', 'createQueryClass must implement explicit presentation consumers');
  const ctx = context(options);
  const Adapted = createQueryClass(QueryFixture, options.queryOptions ?? {});
  return { ctx, value: new Adapted(ctx, {}), Adapted };
}

test('loop maps only open to presentation and preserves native this, options and other bindings', async () => {
  assert.equal(typeof createAgentLoopClass, 'function', 'createAgentLoopClass must adapt the native resume path');
  const owner = {};
  const options = { resumeSessionId: 'owner', signal: new AbortController().signal };
  const calls = [];
  const persistence = {
    identity: Symbol('native'),
    open() { throw new Error('full open must not be used'); },
    openPresentation(...args) { assert.equal(this, persistence); calls.push(args); return 'presentation-handle'; },
    stat(id) { assert.equal(this, persistence); return id; },
  };
  class Loop {
    static Config = { agents: [] };
    static inject = ['sessions'];
    async resumeWith(ctx, store, opts) {
      assert.equal(this.marker, 'native-this'); assert.equal(ctx, owner); assert.equal(opts, options);
      assert.equal(store.identity, persistence.identity); assert.equal(store.stat('owner'), 'owner');
      return store.open(opts.resumeSessionId, 'write', { signal: opts.signal });
    }
  }
  const Adapted = createAgentLoopClass(Loop);
  const value = new Adapted(); value.marker = 'native-this';
  assert.equal(await value.resumeWith(owner, persistence, options), 'presentation-handle');
  assert.deepEqual(calls, [['owner', 'write', { signal: options.signal }]]);
  assert.equal(Adapted.Config, Loop.Config); assert.equal(Adapted.inject, Loop.inject);
});

test('loop without an adapted backend passes the original persistence unchanged', async () => {
  assert.equal(typeof createAgentLoopClass, 'function');
  const persistence = { open() {} };
  class Loop { resumeWith(_ctx, original) { assert.equal(original, persistence); return 'native'; } }
  assert.equal(new (createAgentLoopClass(Loop))().resumeWith({}, persistence, {}), 'native');
});

test('presentation and full readers remain independent during concurrent observations', async () => {
  let count = 0; let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const { ctx, value, Adapted } = query({ gate: async () => { if (++count === 2) release(); await barrier; } });
  const originalReader = value._observations;
  const [preview, full] = await Promise.all([value.observeSession('owner'), value.observeFullSession('owner')]);
  assert.equal(preview.events[0].data.meta.lines.length, 0);
  assert.deepEqual(full.events[0], fullEvent);
  assert.equal(value._observations, originalReader);
  assert.deepEqual(originalReader.cache.get('owner').events[0], fullEvent);
  assert.deepEqual(ctx.state.reads.sort(), ['full', 'presentation']);
  assert.equal(Adapted.Config, QueryFixture.Config); assert.equal(Adapted.inject, QueryFixture.inject);
  preview[Symbol.dispose](); full[Symbol.dispose](); assert.equal(ctx.state.refs, 0);
});

test('query without adapted persistence preserves native full observations and inspect', async () => {
  const { ctx, value } = query({ adapted: false });
  const lease = await value.observeSession('owner');
  assert.deepEqual(lease.events[0], fullEvent); lease[Symbol.dispose]();
  assert.equal(await value.inspectSession('owner', session => session.events[0].data.meta.lines[0].text), 'full original');
  assert.equal(ctx.state.refs, 0);
});

test('inspection uses preview mode and keeps its getter synchronous', async () => {
  const { ctx, value } = query();
  let executed = false;
  assert.equal(await value.inspectSession('owner', session => {
    executed = true; assert.equal(ctx.mode.getStore(), 'presentation'); return session.events[0].data.meta.lines.length;
  }), 0);
  assert.equal(executed, true); assert.equal(ctx.state.refs, 0);
});

test('explicit full hydrate restores live preview and wraps retain over one exact snapshot', async () => {
  const { ctx, value } = query();
  ctx.state.liveEvents = [clone(previewEvent)];
  const lease = await value.observeFullSession('owner', { projectionMode: 'all' });
  assert.deepEqual(lease.events, [fullEvent]);
  assert.equal(lease.cursor, 0); assert.equal(lease.revision, 'fixture-revision');
  assert.deepEqual(lease.projections, { asOfSeq: 0, values: { title: 'fixture' } });
  const retained = lease.retain();
  assert.equal(retained.events, lease.events); assert.equal(ctx.state.restored, 1);
  assert.equal(ctx.state.refs, 2);
  lease[Symbol.dispose](); lease[Symbol.dispose]();
  assert.equal(ctx.state.refs, 1);
  assert.throws(() => lease.retain(), /disposed/);
  retained[Symbol.dispose](); assert.equal(ctx.state.refs, 0);
});

test('full hydrate failure releases the acquired source lease', async () => {
  const { ctx, value } = query();
  const failure = new Error('source bytes unavailable');
  ctx.backend.diskController.restoreEvent = async () => { throw failure; };
  await assert.rejects(value.observeFullSession('owner'), error => error === failure);
  assert.equal(ctx.state.refs, 0);
});

test('unload rejects new reads and releases only the unborrowed cache reference', async () => {
  const { ctx, value } = query();
  const lease = await value.observeSession('owner');
  ctx.dispose();
  assert.equal(ctx.state.refs, 1);
  assert.equal(lease.events[0].data.meta.lines.length, 0);
  await assert.rejects(async () => value.observeSession('owner'), /closed|disposed/i);
  await assert.rejects(async () => value.inspectSession('owner', () => 0), /closed|disposed/i);
  await assert.rejects(async () => value.observeFullSession('owner'), /closed|disposed/i);
  const retained = lease.retain();
  lease[Symbol.dispose](); retained[Symbol.dispose](); assert.equal(ctx.state.refs, 0);
});

test('an observation completing after unload is released rather than handed out', async () => {
  let release;
  let started;
  const inGate = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { ctx, value } = query({ gate: async () => { started(); await gate; } });
  const pending = value.observeSession('owner');
  await inGate; ctx.dispose(); release();
  await assert.rejects(pending, /closed|disposed/i);
  assert.equal(ctx.state.refs, 0);
});

test('title, search and event queries run in presentation scope', async () => {
  const { value } = query();
  assert.equal(await value.readTitle('owner'), 'presentation');
  assert.equal(await value.readTitleSnapshots(['owner']), 'presentation');
  assert.equal(await value.searchEvents({ sessionId: 'owner' }), 'presentation');
  assert.equal(await value.readEvent({ sessionId: 'owner', seq: 0 }), 'presentation');
});

test('adapts modern query readers without the legacy inspect method', async () => {
  class ModernReader {
    constructor(ctx, cacheCapacity = 5) {
      this.ctx = ctx;
      this.cacheCapacity = cacheCapacity;
      this.cache = new Map();
    }
    async read(id, options = {}) {
      options.signal?.throwIfAborted();
      let entry=this.cache.get(id);
      if(!entry){entry=cachedEntry(id,'modern-r1',[clone(previewEvent)]);this.cache.set(id,entry);}
      return observation(entry,this.ctx.state);
    }
  }
  class ModernQuery {
    constructor(ctx) {
      this.ctx = ctx;
      this._observations = new ModernReader(ctx);
    }
    observeSession(id, options) { return this._observations.read(id, options); }
  }
  const ctx = context();
  const clock=fakeClock();
  const Adapted = createQueryClass(ModernQuery,{idleMs:10,setTimer:clock.setTimeout,clearTimer:clock.clearTimeout});
  const value = new Adapted(ctx, {});
  assert.equal(await value.inspectSession('owner', session => session.events[0].data.meta.lines.length), 0);
  assert.equal(ctx.state.refs, 0);
  assert.equal(value.memoryMetrics().presentation.pendingEvictions,1);
  clock.advance(10);
  assert.equal(value._observations.cache.size,0);
});

test('inspection schedules only the reader used by the legacy or modern getter', async () => {
  for (const legacy of [true,false]) {
    let instance;
    class Reader {
    constructor(ctx, cacheCapacity=1) { Object.assign(this,{ctx,cacheCapacity,cache:new Map()}); instance=this; }
      async read(id) {
        const entry=cachedEntry(id,'r',[clone(previewEvent)]); this.cache.set(id,entry);
        return observation(entry,this.ctx.state);
      }
    }
    if (legacy) Reader.prototype.inspect=async function(id,fn) {const lease=await this.read(id);try{return fn(lease);}finally{lease[Symbol.dispose]();}};
    class Base { constructor(ctx){this._observations=new Reader(ctx);} observeSession(id){return this._observations.read(id);} }
    let fire; const ctx=context(); const Query=createQueryClass(Base,{setTimer:fn=>{fire=fn;return 1;},clearTimer:()=>{fire=undefined;}});
    const service=new Query(ctx,{});
    try {
      await assert.rejects(service.inspectSession('owner',()=>{throw new Error('getter failed');}),/getter failed/);
      assert.equal(instance.cache.size,1); assert.equal(typeof fire,'function'); fire(); assert.equal(instance.cache.size,0);
    } finally {ctx.dispose();}
  }
});

test('evicts presentation and full prepared caches after the final lease', async () => {
  const clock = fakeClock();
  const { ctx, value } = query({queryOptions:{idleMs:10,setTimer:clock.setTimeout,clearTimer:clock.clearTimeout}});
  const preview = await value.observeSession('owner');
  const previewRetained = preview.retain();
  preview[Symbol.dispose]();
  clock.advance(10);
  assert.equal(value.memoryMetrics().presentation.entries,1,'retained presentation lease pins its cache entry');
  previewRetained[Symbol.dispose]();
  assert.equal(value.memoryMetrics().presentation.pendingEvictions,1);
  clock.advance(10);
  assert.equal(value.memoryMetrics().presentation.entries,0);

  const full = await value.observeFullSession('owner');
  const fullRetained = full.retain();
  full[Symbol.dispose]();
  clock.advance(10);
  assert.equal(value.memoryMetrics().full.entries,1,'retained full lease pins its native cache entry');
  fullRetained[Symbol.dispose]();
  clock.advance(10);
  assert.equal(value.memoryMetrics().full.entries,0);
  assert.equal(ctx.state.refs,0);
  ctx.dispose();
});

test('inspect schedules presentation cache eviction for legacy and modern readers', async () => {
  for (const legacy of [true, false]) {
    const clock = fakeClock();
    let readerInstance;
    class Reader {
      constructor(ctx, cacheCapacity=1) { Object.assign(this,{ctx,cacheCapacity,cache:new Map()}); readerInstance=this; }
      async read(id) {
        const entry=cachedEntry(id,'r1',[clone(previewEvent)]); this.cache.set(id,entry);
        return observation(entry,this.ctx.state);
      }
    }
    if (legacy) Reader.prototype.inspect=async function(id,getter) { const lease=await this.read(id);try{return getter(lease);}finally{lease[Symbol.dispose]();} };
    class Base { constructor(ctx){this._observations=new Reader(ctx,1);} observeSession(id){return this._observations.read(id);} }
    const ctx=context(); const Query=createQueryClass(Base,{idleMs:10,setTimer:clock.setTimeout,clearTimer:clock.clearTimeout});
    const service=new Query(ctx,{});
    assert.equal(await service.inspectSession('owner',session=>session.events[0].data.meta.lines.length),0);
    assert.equal(service.memoryMetrics().presentation.pendingEvictions,1);
    clock.advance(10);
    assert.equal(readerInstance.cache.size,0);
    ctx.dispose();
  }
});

test('constructor refuses an incompatible native observation shape', () => {
  assert.equal(typeof createQueryClass, 'function');
  class Incompatible { constructor() { this._observations = { read() {}, inspect() {} }; } }
  assert.throws(() => new (createQueryClass(Incompatible))(context(), {}), /observation|reader|shape/i);
});
