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

function fixture({ idleMs = 30_000, entry, onIncompatibleShape } = {}) {
  assert.equal(typeof createIdleObservationCache, 'function', 'idle observation cache helper is required');
  const clock = fakeClock();
  const events = Object.freeze([{ type: 'user/message', seq: 0, data: { content: 'fixture' } }]);
  const cached = entry ?? { revision: 'r1', events, refs: 0 };
  const reader = { cache: new Map([['owner', cached]]) };
  const cache = createIdleObservationCache(reader, {
    idleMs, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout, onIncompatibleShape,
  });
  function leaseFor(value = cached) {
    value.refs++;
    let disposed = false;
    return {
      source: 'prepared',
      header: { id: 'owner', version: 4 },
      events: value.events,
      revision: value.revision,
      retain() {
        if (disposed) throw new Error('disposed lease');
        return leaseFor(value);
      },
      [Symbol.dispose]() {
        if (disposed) return;
        disposed = true;
        value.refs--;
      },
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
    entries: 0, retainedEvents: 0, activeLeases: 0, inFlightReads: 0, pendingEvictions: 0, evictions: 1,
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
  const replacement = { revision: 'r2', events: Object.freeze([{ type: 'turn/start', seq: 0 }]), refs: 0 };
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

test('an in-flight read protects the entry and a failed read rearms it', async () => {
  const f=fixture({idleMs:30}); const lease=f.cache.wrap('owner',f.leaseFor()); lease[Symbol.dispose]();
  const end=f.cache.beginRead('owner'); await f.clock.advance(30); assert.equal(f.reader.cache.size,1);
  end(); await f.clock.advance(30); assert.equal(f.reader.cache.size,0);
});

test('a live observation is passed through without evaluating lazy events', () => {
  const f=fixture(); const hold=f.leaseFor();
  const live={source:'live',get events(){throw new Error('unexpected materialization');}};
  assert.equal(f.cache.wrap('owner',live),live); hold[Symbol.dispose]();
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
