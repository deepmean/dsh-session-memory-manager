const noop = () => {};
const ENTRY_KEYS = ['events','persistedEventCount','persistenceIdentity','refs','revision','session'];
const validEntry = (entry, sessionId) => {
 try {
  if (!entry || typeof entry !== 'object' || Object.getPrototypeOf(entry) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(entry);
  if (keys.length !== ENTRY_KEYS.length || !ENTRY_KEYS.every(key => Object.hasOwn(entry, key))) return false;
  const descriptors=Object.getOwnPropertyDescriptors(entry);
  if(ENTRY_KEYS.some(key=>!Object.hasOwn(descriptors[key],'value')))return false;
  const {events,persistedEventCount,persistenceIdentity,refs,revision,session}=Object.fromEntries(ENTRY_KEYS.map(key=>[key,descriptors[key].value]));
  if(typeof revision!=='string'||typeof persistenceIdentity!=='symbol'
    ||!Number.isSafeInteger(persistedEventCount)||persistedEventCount<0
    ||!Number.isSafeInteger(refs)||refs<0||!Array.isArray(events)||!Object.isFrozen(events)
    ||!session||typeof session!=='object')return false;
  const sessionDescriptors=Object.getOwnPropertyDescriptors(session);
  const idDescriptor=sessionDescriptors.id??Object.getOwnPropertyDescriptor(Object.getPrototypeOf(session),'id');
  if(!idDescriptor||(Object.hasOwn(idDescriptor,'value')?idDescriptor.value!==sessionId:typeof idDescriptor.get!=='function'))return false;
  if(typeof sessionDescriptors.header?.value!=='object'||sessionDescriptors.header.value===null)return false;
  const headerDescriptors=Object.getOwnPropertyDescriptors(sessionDescriptors.header.value);
  const snapshotDescriptor=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(session),'snapshotEvents');
  return headerDescriptors.id?.value===sessionId&&typeof snapshotDescriptor?.value==='function';
 } catch { return false; }
};
const validLeaseShape = lease => {
 try {
  if(!lease||typeof lease!=='object'||Object.getPrototypeOf(lease)!==Object.prototype)return false;
  const descriptors=Object.getOwnPropertyDescriptors(lease);
  const required=['source','header','inheritedEventCount','persistedEventCount','events','cursor','revision','retain'];
  if(required.some(key=>!Object.hasOwn(descriptors,key)||!Object.hasOwn(descriptors[key],'value')))return false;
  return descriptors.source.value==='prepared'
    && !!descriptors.header.value && typeof descriptors.header.value==='object'
    && !!descriptors.events.value && typeof descriptors.events.value==='object'
    && typeof descriptors.revision.value==='string'
    && Number.isSafeInteger(descriptors.persistedEventCount.value)
    && typeof descriptors.retain.value==='function'
    && Object.hasOwn(descriptors,Symbol.dispose)
    && Object.hasOwn(descriptors[Symbol.dispose],'value')
    && typeof descriptors[Symbol.dispose].value==='function'
    && Reflect.ownKeys(descriptors).every(key=>Object.hasOwn(descriptors[key],'value'));
 } catch { return false; }
};
const validLease = (lease, entry, sessionId) => {
 try {
  if(!validLeaseShape(lease))return false;
  const descriptors=Object.getOwnPropertyDescriptors(lease);
  const sessionDescriptors=Object.getOwnPropertyDescriptors(entry.session);
  const header=sessionDescriptors.header.value;
  const headerDescriptors=Object.getOwnPropertyDescriptors(header);
  return descriptors.header.value===header
    && headerDescriptors.id?.value===sessionId
    && descriptors.events.value===entry.events
    && descriptors.revision.value===entry.revision
    && descriptors.persistedEventCount.value===entry.persistedEventCount;
 } catch { return false; }
};

/** Owns idle timers for one SessionObservationReader cache. */
export function createIdleObservationCache(reader, options = {}) {
  const idleMs = options.idleMs ?? 30_000;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const onEviction = options.onEviction ?? noop;
  const onIncompatibleShape = options.onIncompatibleShape ?? noop;
  if (!Number.isFinite(idleMs) || idleMs < 0) throw new RangeError('idleMs must be a finite non-negative number');

  const states = new Map();
  const allStates = new Set();
  const pendingReads = new Map();
  let warnedIncompatible = false;
  let evictions = 0;
  let cleared = false;

  function reportIncompatible() {
    if (warnedIncompatible) return;
    warnedIncompatible = true;
    try { onIncompatibleShape(); } catch {}
  }

  function cacheEntry(sessionId) {
    if (!(reader?.cache instanceof Map)) {
      reportIncompatible();
      return;
    }
    const entry = reader.cache.get(sessionId);
    if (entry === undefined) return;
    if (!validEntry(entry, sessionId)) {
      reportIncompatible();
      return;
    }
    return entry;
  }

  function cancelTimer(state) {
    if (state.timer === undefined) return;
    clearTimer(state.timer);
    state.timer = undefined;
  }

  function current(state) {
    return !cleared && reader?.cache instanceof Map
      && states.get(state.sessionId) === state
      && reader.cache.get(state.sessionId) === state.entry
      && state.entry.revision === state.revision;
  }

  function unlinkState(state) {
    cancelTimer(state);
    if (states.get(state.sessionId) === state) states.delete(state.sessionId);
    allStates.delete(state);
  }

  function readCount(sessionId) { return pendingReads.get(sessionId) ?? 0; }

  function schedule(state) {
    if (cleared) { unlinkState(state); return; }
    if (!current(state)) { unlinkState(state); return; }
    if (state.activeLeases !== 0 || readCount(state.sessionId) !== 0 || state.entry.refs !== 0) return;
    cancelTimer(state);
    if (idleMs === 0) {
      evict(state);
      return;
    }
    const timer = setTimer(() => {
      if (state.timer !== timer) return;
      state.timer = undefined;
      evict(state);
    }, idleMs);
    state.timer = timer;
    timer?.unref?.();
  }

  function evict(state) {
    if (!current(state)) { unlinkState(state); return; }
    if (state.activeLeases !== 0 || readCount(state.sessionId) !== 0 || state.entry.refs !== 0) return;
    reader.cache.delete(state.sessionId);
    unlinkState(state);
    evictions++;
    try { onEviction(); } catch {}
  }

  function stateFor(sessionId, entry) {
    let state = states.get(sessionId);
    if (state?.entry === entry && state.revision === entry.revision) {
      cancelTimer(state);
      return state;
    }
    if (state) unlinkState(state);
    state = { sessionId, entry, revision: entry.revision, activeLeases: 0, inFlightReads: 0, timer: undefined };
    states.set(sessionId, state);
    allStates.add(state);
    return state;
  }

  function beginRead(sessionId) {
    if(cleared||!(reader?.cache instanceof Map)){reportIncompatible();return noop;}
    const existing=states.get(sessionId);
    if(existing)cancelTimer(existing);
    pendingReads.set(sessionId,readCount(sessionId)+1);
    let released=false;
    return () => {
      if(released)return;
      released=true;
      const count=readCount(sessionId);
      if(count<=1)pendingReads.delete(sessionId);else pendingReads.set(sessionId,count-1);
      const currentState=states.get(sessionId);
      const entry=entryFor(sessionId);
      if(currentState) schedule(currentState);
      else if(entry!==undefined) schedule(stateFor(sessionId,entry));
    };
  }

  function wrapWithState(state, lease) {
    state.activeLeases++;
    let disposed = false;
    const wrapped = {
      ...lease,
      retain() {
        if (disposed) throw new Error('session observation lease is disposed');
        if (typeof lease.retain !== 'function') throw new TypeError('session observation lease cannot be retained');
        return wrapWithState(state, lease.retain());
      },
      [Symbol.dispose]() {
        if (disposed) return;
        disposed = true;
        try { lease[Symbol.dispose](); }
        finally {
          state.activeLeases--;
          schedule(state);
          if (!current(state) && state.activeLeases === 0) allStates.delete(state);
        }
      },
    };
    return wrapped;
  }

  function entryFor(sessionId) {
    if (cleared || !(reader?.cache instanceof Map)) {
      reportIncompatible();
      return;
    }
    return cacheEntry(sessionId);
  }

  return {
    beginRead,
    wrap(sessionId, lease) {
      if (lease?.source === 'live') return lease;
      if (!validLeaseShape(lease)) { reportIncompatible(); return lease; }
      const entry = entryFor(sessionId);
      if (entry === undefined) return lease;
      if (!validLease(lease, entry, sessionId)) return lease;
      return wrapWithState(stateFor(sessionId, entry), lease);
    },
    afterInspect(sessionId) {
      const entry = entryFor(sessionId);
      if (entry === undefined) return;
      if (entry.refs !== 0) return;
      schedule(stateFor(sessionId, entry));
    },
    metrics() {
      let retainedEvents = 0;
      for (const [sessionId,entry] of reader?.cache instanceof Map ? reader.cache : []) {
        if (validEntry(entry,sessionId)) retainedEvents += entry.events.length;
      }
      let activeLeases = 0;
      let pendingEvictions = 0;
      for (const state of allStates) {
        activeLeases += state.activeLeases;
        if (state.timer !== undefined) pendingEvictions++;
      }
      return {
        entries: reader?.cache instanceof Map ? reader.cache.size : 0,
        trackedEntries: allStates.size,
        retainedEvents,
        activeLeases,
        inFlightReads: [...pendingReads.values()].reduce((sum,count) => sum + count, 0),
        pendingEvictions,
        evictions,
      };
    },
    clear() {
      if (!cleared) {
        cleared = true;
        for (const state of allStates) cancelTimer(state);
        states.clear();
        allStates.clear();
        pendingReads.clear();
      }
      if (reader?.cache instanceof Map) reader.cache.clear();
    },
  };
}
