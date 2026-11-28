/**
 * Consumer adapters for the pinned rc.5 native classes. Generic observations,
 * inspection, metadata queries and readSession intentionally return presentation
 * events: opaque read metadata may contain bounded previews and disk locators.
 * Model-facing messages and call identities remain unchanged. Use
 * observeFullSession for an explicitly hydrated event snapshot, or persistence's
 * ordinary full read for an authoritative export.
 */

import {createIdleObservationCache} from './idle-observation-cache.js';

/** Preserve the native resume ownership/cancellation protocol, changing only its handle source. */
export function createAgentLoopClass(Base) {
  if (typeof Base?.prototype?.resumeWith !== 'function') {
    throw new TypeError('native AgentLoop.resumeWith is unavailable');
  }
  return class PresentationAgentLoop extends Base {
    resumeWith(ownerCtx, persistence, options) {
      if (typeof persistence?.openPresentation !== 'function') {
        return super.resumeWith(ownerCtx, persistence, options);
      }
      const methods = new Map();
      const proxy = new Proxy(persistence, {
        get(target, property) {
          const value = Reflect.get(target, property === 'open' ? 'openPresentation' : property, target);
          if (typeof value !== 'function') return value;
          const cached = methods.get(property);
          if (cached?.original === value) return cached.bound;
          const bound = value.bind(target);
          methods.set(property, { original: value, bound });
          return bound;
        },
      });
      return super.resumeWith(ownerCtx, proxy, options);
    }
  };
}

/** A wrapper retains the exact hydrated cut; retaining never rehydrates or changes it. */
function hydratedLease(source, events) {
  let disposed = false;
  return {
    ...source,
    events,
    retain() {
      if (disposed) throw new Error('full session observation is disposed');
      const retained = source.retain();
      try { return hydratedLease(retained, events); }
      catch (error) { retained[Symbol.dispose](); throw error; }
    },
    [Symbol.dispose]() {
      if (disposed) return;
      disposed = true;
      source[Symbol.dispose]();
    },
  };
}

/**
 * Keep native SQLite lifecycle, schema and original full observation cache intact.
 * The separate presentation reader owns its own cache and no borrowed leases.
 */
export function createQueryClass(Base, idleOptions = {}) {
  if (typeof Base?.prototype?.observeSession !== 'function') {
    throw new TypeError('native query observation method is unavailable');
  }
  const STATE = Symbol('ptc-disk-history.query-state');
  const stateOf = instance => {
    const state = instance[STATE];
    if (!state || state.closed) throw new Error('presentation query consumer is closed');
    return state;
  };
  const persistenceOf = instance => stateOf(instance).ctx.get('sessionPersistence');
  const clearIfClosed = state => {
    if (state.closed) state.reader.cache.clear();
  };

  class PresentationSessionQuery extends Base {
    constructor(ctx, config) {
      super(ctx, config);
      const original = this._observations;
      if (!original || original.ctx === undefined
        || !Number.isSafeInteger(original.cacheCapacity) || original.cacheCapacity < 1
        || !(original.cache instanceof Map)
        || typeof original.read !== 'function'
        || (original.inspect !== undefined && typeof original.inspect !== 'function')
        || typeof original.constructor !== 'function' || original.constructor === Object) {
        throw new TypeError('native observation reader shape is incompatible');
      }
      const reader = new original.constructor(original.ctx, Math.min(original.cacheCapacity, 1));
      if (!(reader.cache instanceof Map) || reader.cache === original.cache) {
        throw new TypeError('presentation observation reader requires an independent cache');
      }
      const options = {
        idleMs: config?.idleObservationCacheMs ?? idleOptions.idleMs ?? 30_000,
        setTimer: idleOptions.setTimer,
        clearTimer: idleOptions.clearTimer,
        onIncompatibleShape: () => idleOptions.onIncompatibleShape?.(),
      };
      const presentationCache = createIdleObservationCache(reader, options);
      const fullCache = createIdleObservationCache(original, options);
      const state = { ctx, reader, presentationCache, fullCache, closed: false };
      Object.defineProperty(this, STATE, { value: state });
      ctx.effect(() => () => {
        state.closed = true;
        state.presentationCache.clear();
        state.fullCache.clear();
      }, 'sessionQuery.presentation-observer');
    }

    memoryMetrics() {
      const state = this[STATE];
      if (!state || state.closed) throw new Error('presentation query consumer is closed');
      return { presentation: state.presentationCache.metrics(), full: state.fullCache.metrics() };
    }

    async observeSession(sessionId, options = {}) {
      const state = stateOf(this);
      const persistence = persistenceOf(this);
      const presentation = typeof persistence?.runPresentation === 'function';
      const cache = presentation ? state.presentationCache : state.fullCache;
      const finishRead = cache.beginRead(sessionId);
      try {
        const source = presentation
          ? await persistence.runPresentation(() => state.reader.read(sessionId, options))
          : await super.observeSession(sessionId, options);
        if (state.closed) {
          source[Symbol.dispose]();
          clearIfClosed(state);
          throw new Error('presentation query consumer is closed');
        }
        return cache.wrap(sessionId, source);
      } finally { finishRead(); }
    }

    async inspectSession(sessionId, read, signal) {
      const state = stateOf(this);
      const persistence = persistenceOf(this);
      const presentation = typeof persistence?.runPresentation === 'function';
      const cache = presentation ? state.presentationCache : state.fullCache;
      const reader = presentation ? state.reader : this._observations;
      const finishRead = cache.beginRead(sessionId);
      const guardedRead = session => { stateOf(this); return read(session); };
      try {
        const inspect = typeof reader.inspect === 'function'
          ? () => presentation
            ? reader.inspect(sessionId, guardedRead, signal)
            : super.inspectSession(sessionId, guardedRead, signal)
          : async () => {
            const source = await reader.read(sessionId, { signal });
            const lease = cache.wrap(sessionId, source);
            try { return guardedRead({ ...lease, id: lease.header?.id ?? sessionId }); }
            finally { lease[Symbol.dispose](); }
          };
        const result = presentation
          ? await persistence.runPresentation(inspect)
          : typeof persistence?.runFull === 'function'
            ? await persistence.runFull(inspect)
            : await inspect();
        return result;
      } finally {
        if (typeof reader.inspect === 'function') cache.afterInspect(sessionId);
        finishRead();
        clearIfClosed(state);
      }
    }

    async observeFullSession(sessionId, options = {}) {
      const state = stateOf(this);
      const persistence = persistenceOf(this);
      const finishRead = state.fullCache.beginRead(sessionId);
      let source;
      let lease;
      try {
        source = typeof persistence?.runFull === 'function'
          ? await persistence.runFull(() => super.observeSession(sessionId, options))
          : await super.observeSession(sessionId, options);
        lease = state.fullCache.wrap(sessionId, source);
      } catch (error) {
        finishRead();
        throw error;
      }
      finishRead();
      try {
        stateOf(this);
        options.signal?.throwIfAborted();
        const controller = persistence?.diskController;
        if (typeof controller?.restoreEvent !== 'function') {
          if (typeof persistence?.runPresentation === 'function') {
            throw new Error('full session hydration requires backend.diskController.restoreEvent');
          }
          return lease;
        }
        const events = [];
        for (const event of lease.events) {
          options.signal?.throwIfAborted();
          stateOf(this);
          events.push(await controller.restoreEvent(event, { ownerId: lease.header.id, signal: options.signal }));
        }
        options.signal?.throwIfAborted();
        stateOf(this);
        return hydratedLease(lease, Object.freeze(events));
      } catch (error) {
        lease[Symbol.dispose]();
        throw error;
      }
    }
  }

  // Explicit list from installed SessionQueryEngine/SqliteSessionQueryEngine.
  // Each descriptor captures the original native method, never looks up this
  // method recursively, and never temporarily swaps the shared _observations.
  const presentationMethods = [
    'listSessions', 'readSession', 'filterSessions',
    'readTitle', 'readTitleSnapshot', 'readTitleSnapshots',
    'listEvents', 'filterEvents', 'readEvent', 'readSurface', 'traceSession', 'traceEvent',
    'searchSessions', 'searchEvents',
  ];
  for (const name of presentationMethods) {
    const nativeMethod = Base.prototype[name];
    if (typeof nativeMethod !== 'function') continue;
    Object.defineProperty(PresentationSessionQuery.prototype, name, {
      configurable: true, writable: true,
      value: function (...args) {
        const persistence = persistenceOf(this);
        return typeof persistence?.runPresentation === 'function'
          ? persistence.runPresentation(() => nativeMethod.apply(this, args))
          : nativeMethod.apply(this, args);
      },
    });
  }
  return PresentationSessionQuery;
}
