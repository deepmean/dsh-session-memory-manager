import { AsyncLocalStorage } from 'node:async_hooks';

const ROW_BATCH_BYTES = 1024 * 1024;
const DEFAULT_MAX_ENCODED_BYTES = 128 * 1024 * 1024;

/**
 * Adapt the pinned native JSONL implementation without replacing its validation,
 * leases, atomic publication, or mutation ordering. The caller owns the controller
 * lifecycle and must keep recovered torn-tail events complete until native repair.
 *
 * Default open/read remains full fidelity. Only explicit presentation operations
 * receive controller-produced views; no property accessor performs disk reads.
 */
export function createBackendClass(Base, controller, {
  catalog,
  compressFrame,
  maxEncodedBytes = DEFAULT_MAX_ENCODED_BYTES,
} = {}) {
  if (typeof Base !== 'function'
    || typeof controller?.readStoredPrefix !== 'function'
    || typeof controller?.restoreEvent !== 'function'
    || typeof catalog?.encodeCurrentHeader !== 'function'
    || typeof catalog?.encodeCurrentEvent !== 'function'
    || typeof compressFrame !== 'function') {
    throw new TypeError('backend adapter requires Base, controller, catalog and compressFrame');
  }
  if (!Number.isSafeInteger(maxEncodedBytes) || maxEncodedBytes <= 0) {
    throw new TypeError('maxEncodedBytes must be a positive safe integer');
  }

  const readMode = new AsyncLocalStorage();
  const decoding = new AsyncLocalStorage();
  const writing = new AsyncLocalStorage();
  // Native open only returns a lazy handle; whole-log buffers are allocated
  // later by handle.read. Serialize presentation reads at that boundary.
  let presentationReadTail = Promise.resolve();
  const serializedPresentationRead = operation => {
    const current = presentationReadTail.then(operation, operation);
    presentationReadTail = current.then(() => undefined, () => undefined);
    return current;
  };

  // Native LRU delete/set operations may evict the other mode unnecessarily,
  // which is safe. Mutation invalidation must always clear both representations.
  function modeMemo(original) {
    const full = original;
    const presentation = new Map();
    const active = () => readMode.getStore() === 'presentation' ? presentation : full;
    let proxy;
    proxy = new Proxy(original, {
      get(_target, property) {
        if (property === 'delete') return key => {
          const existedFull = full.delete(key);
          const existedPresentation = presentation.delete(key);
          return existedFull || existedPresentation;
        };
        if (property === 'clear') return () => { full.clear(); presentation.clear(); };
        if (property === 'set') return (key, value) => { active().set(key, value); return proxy; };
        const map = active();
        const value = Reflect.get(map, property, map);
        return typeof value === 'function' ? value.bind(map) : value;
      },
    });
    return proxy;
  }

  function presentationHandle(handle) {
    const methods = new Map();
    return new Proxy(handle, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        const known = methods.get(property);
        if (known?.original === value) return known.bound;
        const invoke = (...args) => readMode.run('presentation', () => value.apply(target, args));
        const bound = property === 'read'
          ? (...args) => serializedPresentationRead(() => invoke(...args))
          : invoke;
        methods.set(property, { original: value, bound });
        return bound;
      },
    });
  }

  return class PresentationJsonlBackend extends Base {
    constructor(...args) {
      super(...args);
      if (!(this.coldLogMemo instanceof Map)) {
        throw new TypeError('pinned native backend coldLogMemo is not a Map');
      }
      this.coldLogMemo = modeMemo(this.coldLogMemo);
      /** Notification failures after durable success; never a failed append. */
      this.postCommitErrors = [];
    }

    runPresentation(operation) {
      return readMode.run('presentation', operation);
    }

    runFull(operation) {
      return readMode.run('full', operation);
    }

    async openPresentation(id, access, options) {
      return readMode.run('presentation', async () =>
        presentationHandle(await this.open(id, access, options)));
    }

    async decodeStoredLog(file, id, buffer, revision, signal) {
      if (readMode.getStore() !== 'presentation') {
        return super.decodeStoredLog(file, id, buffer, revision, signal);
      }
      return decoding.run({ file, id, buffer, revision }, () =>
        super.decodeStoredLog(file, id, buffer, revision, signal));
    }

    async readZstdPrefix(buffer, signal) {
      const source = decoding.getStore();
      if (readMode.getStore() !== 'presentation' || source === undefined) {
        return super.readZstdPrefix(buffer, signal);
      }
      signal?.throwIfAborted();
      return controller.readStoredPrefix({ ...source, buffer, signal });
    }

    async persistBatch(header, events, ...args) {
      // The native method's return is the durable commit boundary. Do not make
      // that successful write reject when a later relocation notification fails:
      // JsonlSessionHandle advances its cursor only after this method resolves.
      const result = await writing.run({ ownerId: header.id }, () =>
        super.persistBatch(header, events, ...args));
      try {
        await controller.persisted?.(header, events);
      } catch (error) {
        this.recordPostCommitError(error, header.id);
      }
      return result;
    }

    recordPostCommitError(error, ownerId) {
      const append = (failure, operation) => {
        this.postCommitErrors.push({ error: failure, ownerId, operation });
        if (this.postCommitErrors.length > 16) this.postCommitErrors.shift();
      };
      append(error, 'persisted');
      if (typeof controller.reportError !== 'function') return;
      try {
        // Reporting must not hold the native mutation chain open indefinitely.
        Promise.resolve(controller.reportError(error, { ownerId, operation: 'persisted' }))
          .catch(failure => append(failure, 'reportError'));
      } catch (failure) {
        append(failure, 'reportError');
      }
    }

    async encodeMaterialization(meta, inheritedEventCount, events) {
      if (meta.isSeeded && inheritedEventCount === undefined) {
        throw new Error('seeded session header requires an inherited event count');
      }
      const cut = inheritedEventCount ?? 0;
      if (!Number.isSafeInteger(cut) || cut < 0 || Object.is(cut, -0)) {
        throw new TypeError('inherited event count must be a non-negative safe integer');
      }
      if (!meta.isSeeded && cut !== 0) {
        throw new Error('unseeded session header inherited event count must be 0');
      }
      const encodedHeader = catalog.encodeCurrentHeader({
        ...meta, delegationDepth: meta.delegationDepth ?? 0,
      }, cut);
      return this.encodeRestoredRows(events, `${JSON.stringify(encodedHeader)}\n`, meta.id);
    }

    async encodeEventBatch(events) {
      return this.encodeRestoredRows(events, undefined, writing.getStore()?.ownerId);
    }

    async encodeRestoredRows(events, headerLine, ownerId) {
      const compression = this.compression ?? this.config?.compression ?? 'zstd';
      if (compression !== 'none' && compression !== 'zstd') {
        throw new TypeError(`unsupported native compression: ${String(compression)}`);
      }
      const parts = [];
      let encodedBytes = 0;
      const addPart = async text => {
        const raw = Buffer.from(text, 'utf8');
        const part = compression === 'zstd' ? Buffer.from(await compressFrame(raw)) : raw;
        if (part.byteLength > maxEncodedBytes - encodedBytes) {
          throw new RangeError(`encoded session batch exceeds encoded byte limit ${maxEncodedBytes}`);
        }
        encodedBytes += part.byteLength;
        parts.push(part);
      };
      // A standalone, newline-terminated header frame is required by the native
      // reader. Body rows never share that frame, including an empty creation.
      if (headerLine !== undefined) await addPart(headerLine);
      let rows = [];
      let rowBytes = 0;
      for (const event of events) {
        const restored = await controller.restoreEvent(event, { ownerId });
        if(restored?.data?.meta&&Object.hasOwn(restored.data.meta,'__dshDiskPtc'))throw new Error('disk presentation marker must be restored before durable encoding');
        const line = `${JSON.stringify(catalog.encodeCurrentEvent(restored))}\n`;
        const bytes = Buffer.byteLength(line, 'utf8');
        if (rowBytes > 0 && rowBytes + bytes > ROW_BATCH_BYTES) {
          await addPart(rows.join(''));
          rows = [];
          rowBytes = 0;
        }
        rows.push(line);
        rowBytes += bytes;
        // One exceptional row can exceed the working budget; flush it now so
        // its restored object never overlaps with another exceptional row.
        if (rowBytes >= ROW_BATCH_BYTES) {
          await addPart(rows.join(''));
          rows = [];
          rowBytes = 0;
        }
      }
      if (rowBytes > 0) await addPart(rows.join(''));
      return Buffer.concat(parts, encodedBytes);
    }
  };
}
