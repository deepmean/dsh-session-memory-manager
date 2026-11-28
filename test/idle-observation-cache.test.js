import assert from 'node:assert/strict';
import test from 'node:test';

let createIdleObservationCache;
try { ({ createIdleObservationCache } = await import('../lib/idle-observation-cache.js')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    setTimeout(callback, delay) {
      const timer = { id: ++nextId, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timers.set(timer.id, { timer, at: now + delay, callback });
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer?.id); },
    async advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, task]) => task.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        due[1].callback();
        await Promise.resolve();
      }
    },
    pending() { return timers.size; },
    timers,
  };
}

class DshSessionFixture {
  constructor(header,events){this.header=header;this.events=events;}
  get id(){return this.header.id;}
  snapshotEvents(){return this.events;}
}
function dshEntry(revision='r1', events=Object.freeze([{type:'user/message',seq:0,data:{content:'fixture'}}]), id='owner') {
  const header={id,version:4,createdAt:1,isSeeded:false};
  const session=new DshSessionFixture(header,events);
  return {persistedEventCount:events.length,persistenceIdentity:Symbol('persistence'),revision,session,events,refs:0};
}

function fixture({ idleMs = 30_000, entry, onIncompatibleShape } = {}) {
  assert.equal(typeof createIdleObservationCache, 'function', 'idle observation cache helper is required');
  const clock = fakeClock();
  const cached = entry ?? dshEntry();
  const reader = { cache: new Map([['owner', cached]]) };
  const cache = createIdleObservationCache(reader, {
    idleMs, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout, onIncompatibleShape,
  });
  function leaseFor(value = cached) {
    value.refs++;
    let disposed = false;
    return {
      source: 'prepared', header: value.session.header,
      inheritedEventCount:0,persistedEventCount:value.persistedEventCount,
      events:value.events,cursor:value.events.at(-1)?.seq??-1,revision:value.revision,
      retain() { if (disposed) throw new Error('disposed lease'); return leaseFor(value); },
      [Symbol.dispose]() { if (disposed) return; disposed = true; value.refs--; },
    };
  }
  return { clock, reader, cached, cache, leaseFor };
}

test('evicts an unpinned prepared entry after the idle grace', async () => {
  const f = fixture({ idleMs: 30 });
  const lease = f.cache.wrap('owner', f.leaseFor());
  assert.equal(lease.events[0].data.content, 'fixture');
  assert.equal(f.cache.metrics().activeLeases, 1);
  lease[Symbol.dispose]();
  lease[Symbol.dispose]();
  assert.equal(f.reader.cache.get('owner'), f.cached, 'entry stays during grace');
  assert.equal(f.clock.pending(), 1);
  assert.equal([...f.clock.timers.values()][0].timer.unrefCalled, true);
  await f.clock.advance(29);
  assert.equal(f.reader.cache.get('owner'), f.cached);
  await f.clock.advance(1);
  assert.equal(f.reader.cache.has('owner'), false);
  assert.deepEqual(f.cache.metrics(), {
    entries: 0, trackedEntries: 0, retainedEvents: 0, activeLeases: 0, inFlightReads: 0, pendingEvictions: 0, evictions: 1,
  });
});

test('keeps a cache entry until every retained lease is disposed', async () => {
  const f = fixture({ idleMs: 20 });
  const first = f.cache.wrap('owner', f.leaseFor());
  const second = first.retain();
  first[Symbol.dispose]();
  assert.equal(f.cached.refs, 1);
  assert.equal(f.cache.metrics().activeLeases, 1);
  assert.equal(f.clock.pending(), 0);
  await f.clock.advance(100);
  assert.equal(f.reader.cache.get('owner'), f.cached);
  second[Symbol.dispose]();
  await f.clock.advance(20);
  assert.equal(f.reader.cache.has('owner'), false);
  assert.equal(f.cache.metrics().evictions, 1);
});

test('a new read cancels the prior idle timer', async () => {
  const f = fixture({ idleMs: 25 });
  const first = f.cache.wrap('owner', f.leaseFor());
  first[Symbol.dispose]();
  const reopened = f.cache.wrap('owner', f.leaseFor());
  await f.clock.advance(25);
  assert.equal(f.reader.cache.get('owner'), f.cached);
  assert.equal(f.cache.metrics().evictions, 0);
  reopened[Symbol.dispose]();
  await f.clock.advance(25);
  assert.equal(f.reader.cache.has('owner'), false);
});

test('a stale timer cannot delete a replacement revision', async () => {
  const f = fixture({ idleMs: 20 });
  const oldLease = f.cache.wrap('owner', f.leaseFor());
  oldLease[Symbol.dispose]();
  const replacement = dshEntry('r2',Object.freeze([{ type: 'turn/start', seq: 0 }]));
  f.reader.cache.set('owner', replacement);
  await f.clock.advance(20);
  assert.equal(f.reader.cache.get('owner'), replacement);
  assert.equal(f.cache.metrics().evictions, 0);
});

test('an incompatible entry shape fails safe without deletion', async () => {
  const incompatible = { events: [], revision: 'r1' };
  let warnings = 0;
  const f = fixture({ entry: incompatible, idleMs: 10, onIncompatibleShape: () => warnings++ });
  const lease = { source: 'prepared', events: [], [Symbol.dispose]() {} };
  const returned = f.cache.wrap('owner', lease);
  assert.equal(returned.source, 'prepared', 'wrapper must preserve observation properties');
  assert.equal(typeof returned[Symbol.dispose], 'function');
  returned[Symbol.dispose]();
  assert.equal(warnings, 1);
  await f.clock.advance(100);
  assert.equal(f.reader.cache.get('owner'), incompatible);
  assert.equal(f.cache.metrics().evictions, 0);
});

test('a stale timer releases helper references after native capacity evicts the entry', async () => {
  const f=fixture({idleMs:10});
  const oldLease=f.cache.wrap('owner',f.leaseFor());oldLease[Symbol.dispose]();
  const replacement=dshEntry('r2',Object.freeze([{type:'turn/start',seq:0}]),'other');
  f.reader.cache.delete('owner');f.reader.cache.set('other',replacement);
  await f.clock.advance(10);
  assert.equal(f.reader.cache.get('other'),replacement);
  assert.equal(f.cache.metrics().trackedEntries,0,'stale state must not keep old entry/events reachable');
});

test('cold concurrent reads are fenced before the native cache entry exists', async () => {
  const f=fixture({idleMs:10});f.reader.cache.clear();let warnings=0;f.cache.clear();
  const cache=createIdleObservationCache(f.reader,{idleMs:10,setTimer:f.clock.setTimeout,clearTimer:f.clock.clearTimeout,onIncompatibleShape:()=>warnings++});
  const finishFirst=cache.beginRead('owner');
  const finishSecond=cache.beginRead('owner');
  const firstEntry=dshEntry('cold-r1',Object.freeze([{type:'user/message',seq:0,data:{content:'first'}}]));
  f.reader.cache.set('owner',firstEntry);
  const first=cache.wrap('owner',f.leaseFor(firstEntry));
  finishFirst();first[Symbol.dispose]();
  assert.equal(f.clock.pending(),0,'second cold read still protects the first cache entry');
  const secondEntry=dshEntry('cold-r2',Object.freeze([{type:'user/message',seq:0,data:{content:'second'}}]));
  f.reader.cache.set('owner',secondEntry);
  const stale=cache.wrap('owner',f.leaseFor(firstEntry));
  assert.equal(stale.events,firstEntry.events,'a stale lease is not rebound to the replacement entry');
  stale[Symbol.dispose]();
  const second=cache.wrap('owner',f.leaseFor(secondEntry));
  finishSecond();second[Symbol.dispose]();
  assert.equal(warnings,0,'a valid alpha2 lease from a superseded read is not an unknown shape');
  await f.clock.advance(10);
  assert.equal(f.reader.cache.has('owner'),false);
});

test('does not associate a stale lease with a different entry of the same revision', async () => {
  const f=fixture({idleMs:10});
  const oldEntry=f.cached;
  const oldLease=f.cache.wrap('owner',f.leaseFor(oldEntry));
  const sameRevision=dshEntry(oldEntry.revision,Object.freeze([{type:'turn/start',seq:0}]),'owner');
  f.reader.cache.set('owner',sameRevision);
  const freshLease=f.cache.wrap('owner',f.leaseFor(sameRevision));
  oldLease[Symbol.dispose]();
  freshLease[Symbol.dispose]();
  await f.clock.advance(10);
  assert.equal(f.reader.cache.has('owner'),false);
  assert.equal(f.cache.metrics().trackedEntries,0);
});

test('rejects a lookalike entry missing the pinned DSH ownership fields', async () => {
  const lookalike={revision:'r1',events:[],refs:1};
  let warnings=0;
  const f=fixture({entry:lookalike,idleMs:10,onIncompatibleShape:()=>warnings++});
  const lease={source:'prepared',revision:'r1',events:[],header:{id:'owner'},[Symbol.dispose](){}};
  f.cache.wrap('owner',lease);
  await f.clock.advance(20);
  assert.equal(f.reader.cache.get('owner'),lookalike);
  assert.equal(warnings,1);
  assert.equal(f.cache.metrics().trackedEntries,0);
});

test('clear cancels timers and leaves borrowed leases usable', () => {
  const f = fixture({ idleMs: 20 });
  const borrowed = f.cache.wrap('owner', f.leaseFor());
  const retained = borrowed.retain();
  borrowed[Symbol.dispose]();
  f.cache.clear();
  assert.equal(f.clock.pending(), 0);
  assert.equal(f.reader.cache.size, 0);
  assert.equal(retained.events[0].data.content, 'fixture');
  retained[Symbol.dispose]();
});
