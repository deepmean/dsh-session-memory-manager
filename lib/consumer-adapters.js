/**
 * Consumer adapters for the pinned rc.5 native classes. Generic observations,
 * inspection, metadata queries and readSession intentionally return presentation
 * events: opaque read metadata may contain bounded previews and disk locators.
 * Model-facing messages and call identities remain unchanged. Use
 * observeFullSession for an explicitly hydrated event snapshot, or persistence's
 * ordinary full read for an authoritative export.
 */

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
export function createQueryClass(Base) {
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
      const state = { ctx, reader, closed: false };
      Object.defineProperty(this, STATE, { value: state });
      ctx.effect(() => () => {
        state.closed = true;
        // Active leases own their entries independently. Clearing this map drops
        // only our cache references, never decrements another consumer's refs.
        state.reader.cache.clear();
      }, 'sessionQuery.presentation-observer');
    }

    async observeSession(sessionId, options = {}) {
      const state = stateOf(this);
      const persistence = persistenceOf(this);
      const source = typeof persistence?.runPresentation === 'function'
        ? await persistence.runPresentation(() => state.reader.read(sessionId, options))
        : await super.observeSession(sessionId, options);
      if (state.closed) {
        source[Symbol.dispose]();
        clearIfClosed(state);
        throw new Error('presentation query consumer is closed');
      }
      return source;
    }

    async inspectSession(sessionId, read, signal) {
      const state = stateOf(this);
      const persistence = persistenceOf(this);
      // The reader invokes the domain getter synchronously. Check closure again
      // there, after any asynchronous preparation, before running user code.
      const guardedRead = session => { stateOf(this); return read(session); };
      try {
        const inspect = typeof state.reader.inspect === 'function'
          ? () => state.reader.inspect(sessionId, guardedRead, signal)
          : async () => {
            const source = await state.reader.read(sessionId, { signal });
            try {
              return guardedRead({ ...source, id: source.header?.id ?? sessionId });
            } finally { source[Symbol.dispose](); }
          };
        return typeof persistence?.runPresentation === 'function'
          ? await persistence.runPresentation(inspect)
          : typeof state.reader.inspect === 'function'
            ? await super.inspectSession(sessionId, guardedRead, signal)
            : await inspect();
      } finally { clearIfClosed(state); }
    }

    async observeFullSession(sessionId, options = {}) {
      const state = stateOf(this);
      const persistence = persistenceOf(this);
      const source = typeof persistence?.runFull === 'function'
        ? await persistence.runFull(() => super.observeSession(sessionId, options))
        : await super.observeSession(sessionId, options);
      try {
        stateOf(this);
        options.signal?.throwIfAborted();
        const controller = persistence?.diskController;
        if (typeof controller?.restoreEvent !== 'function') {
          if (typeof persistence?.runPresentation === 'function') {
            throw new Error('full session hydration requires backend.diskController.restoreEvent');
          }
          return source;
        }
        const events = [];
        for (const event of source.events) {
          options.signal?.throwIfAborted();
          stateOf(this);
          events.push(await controller.restoreEvent(event, { ownerId: source.header.id, signal: options.signal }));
        }
        options.signal?.throwIfAborted();
        stateOf(this);
        return hydratedLease(source, Object.freeze(events));
      } catch (error) {
        source[Symbol.dispose]();
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
