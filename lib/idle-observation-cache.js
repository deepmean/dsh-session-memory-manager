import assert from 'node:assert/strict';

const noop = () => {};
const validEntry = entry => !!entry && typeof entry === 'object'
  && typeof entry.revision === 'string'
  && Array.isArray(entry.events)
  && Number.isSafeInteger(entry.refs) && entry.refs >= 0;

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
    if (!validEntry(entry)) {
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

  function schedule(state) {
    if (cleared || state.activeLeases !== 0 || state.entry.refs !== 0 || !current(state)) return;
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
    if (!current(state) || state.activeLeases !== 0 || state.entry.refs !== 0) return;
    reader.cache.delete(state.sessionId);
    states.delete(state.sessionId);
    allStates.delete(state);
    evictions++;
    try { onEviction(); } catch {}
  }

  function stateFor(sessionId, entry) {
    let state = states.get(sessionId);
    if (state?.entry === entry && state.revision === entry.revision) {
      cancelTimer(state);
      return state;
    }
    if (state) {
      cancelTimer(state);
      states.delete(sessionId);
      allStates.delete(state);
    }
    state = { sessionId, entry, revision: entry.revision, activeLeases: 0, timer: undefined };
    states.set(sessionId, state);
    allStates.add(state);
    return state;
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
    wrap(sessionId, lease) {
      const entry = entryFor(sessionId);
      if (entry === undefined) return lease;
      if (entry.refs < 1) {
        reportIncompatible();
        return lease;
      }
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
      for (const entry of reader?.cache instanceof Map ? reader.cache.values() : []) {
        if (validEntry(entry)) retainedEvents += entry.events.length;
      }
      let activeLeases = 0;
      let pendingEvictions = 0;
      for (const state of allStates) {
        activeLeases += state.activeLeases;
        if (state.timer !== undefined) pendingEvictions++;
      }
      return {
        entries: reader?.cache instanceof Map ? reader.cache.size : 0,
        retainedEvents,
        activeLeases,
        pendingEvictions,
        evictions,
      };
    },
    clear() {
      if (cleared) return;
      cleared = true;
      for (const state of allStates) cancelTimer(state);
      states.clear();
      allStates.clear();
      if (reader?.cache instanceof Map) reader.cache.clear();
    },
  };
}
