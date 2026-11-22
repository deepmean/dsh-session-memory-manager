import assert from 'node:assert/strict';
import test from 'node:test';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

// Missing production code fails as an assertion, rather than a module-load error.
let createBackendClass;
try { ({ createBackendClass } = await import('../lib/backend-adapter.js')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const header = { version: 4, id: 'owner', createdAt: 1, isSeeded: false };
const sourceEvent = {
  type: 'tool/ptc-dispatch', seq: 0, time: 1,
  data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:0', name: 'read',
    arguments: { file_path: 'fixture.txt' }, isError: false, content: [],
    meta: { path: 'fixture.txt', offset: 1, lines: [{ number: 1, text: 'original text' }], totalLines: 1 } },
};
const previewEvent = { ...sourceEvent, data: { ...sourceEvent.data, meta: { ...sourceEvent.data.meta,
  lines: [], locator: { file: 'fixture', seq: 0 } } } };
const clone = value => structuredClone(value);
const catalog = {
  encodeCurrentHeader(value, cut) {
    assert.equal(cut, 0);
    assert.equal(value.delegationDepth, 0);
    return { type: 'session', ...value };
  },
  encodeCurrentEvent(value) { return value; },
};
const compressFrame = input => zstdCompressSync(input, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });

class FixtureBackend {
  constructor({ compression = 'zstd', decodeGate, openGate, readGate } = {}) {
    this.compression = compression;
    this.coldLogMemo = new Map();
    this.writes = [];
    this.decodeGate = decodeGate;
    this.openGate = openGate;
    this.readGate = readGate;
    this.validationRuns = 0;
    this.cursor = 0;
  }
  async open(id, access, options) {
    await this.openGate?.(id);
    const backend = this;
    return {
      id, access, marker: Symbol('handle'), closed: false,
      async read() {
        assert.equal(this.id, id);
        await backend.readGate?.(id);
        const hit = backend.coldLogMemo.get(id);
        if (hit) return hit;
        return backend.decodeStoredLog('fixture', id, Buffer.from('fixture'), 'revision-1', options?.signal);
      },
      async append(events) {
        assert.equal(this.id, id);
        await backend.persistBatch({ ...header, id }, events, backend.writes.length > 0, 0);
        backend.cursor += events.length;
      },
      async close() { assert.equal(this.id, id); this.closed = true; },
    };
  }
  async decodeStoredLog(file, id, buffer, revision, signal) {
    await this.decodeGate?.();
    const parsed = await this.readZstdPrefix(buffer, signal);
    this.validationRuns++;
    if (parsed.meta.id !== id) throw new Error('official stored identity refusal');
    if (parsed.events.some(event => event.seq !== 0)) throw new Error('official sequence refusal');
    const result = Object.freeze({ ...parsed, events: Object.freeze(parsed.events), eventState: 'shared-frozen' });
    this.coldLogMemo.set(id, result);
    return result;
  }
  async readZstdPrefix() {
    return { meta: clone(header), inheritedEventCount: 0, events: [clone(sourceEvent)],
      recoveredTail: [], tornTruncateTo: undefined };
  }
  async persistBatch(meta, events, materialized, inherited) {
    const bytes = materialized ? await this.encodeEventBatch(events)
      : await this.encodeMaterialization(meta, inherited, events);
    this.writes.push(Buffer.from(bytes));
    this.coldLogMemo.delete(meta.id);
  }
}

function setup(options = {}, backendOptions = {}) {
  assert.equal(typeof createBackendClass, 'function', 'createBackendClass must implement the backend adapter');
  const restoredOwners = [];
  const reported = [];
  const controller = {
    async readStoredPrefix({ file, id, revision, buffer, signal }) {
      assert.equal(file, 'fixture'); assert.equal(revision, 'revision-1');
      assert.equal(buffer.toString(), 'fixture'); signal?.throwIfAborted();
      return { meta: { ...clone(header), id }, inheritedEventCount: 0, events: [clone(previewEvent)],
        recoveredTail: [], tornTruncateTo: undefined };
    },
    async restoreEvent(event, { ownerId, signal } = {}) {
      signal?.throwIfAborted(); restoredOwners.push(ownerId);
      return event.data?.meta?.locator ? { ...clone(sourceEvent), seq: event.seq } : event;
    },
    async persisted() {},
    reportError(error) { reported.push(error); },
    ...options.controller,
  };
  const Backend = createBackendClass(FixtureBackend, controller, { catalog, compressFrame, ...options });
  return { backend: new Backend(backendOptions), controller, restoredOwners, reported };
}

const plain = bytes => zstdDecompressSync(bytes).toString('utf8').trimEnd().split('\n').map(JSON.parse);

test('concurrent presentation and full reads never reuse the other mode memo', async () => {
  let waiting = 0;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const { backend } = setup({}, { decodeGate: async () => { if (++waiting === 2) release(); await barrier; } });
  const presentation = await backend.openPresentation('owner', 'read');
  const full = await backend.open('owner', 'read');
  const [preview, original] = await Promise.all([presentation.read(), full.read()]);
  assert.equal(preview.events[0].data.meta.lines.length, 0);
  assert.equal(original.events[0].data.meta.lines[0].text, 'original text');
  assert.equal((await presentation.read()).events[0].data.meta.lines.length, 0);
  assert.equal((await full.read()).events[0].data.meta.lines[0].text, 'original text');
  assert.equal(backend.validationRuns, 2);
});

test('presentation cold opens are serialized before native read allocates whole-log buffers', async () => {
  let active=0,maximum=0,releaseFirst,startedFirst;
  const firstStarted=new Promise(resolve=>{startedFirst=resolve;});
  const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
  const {backend}=setup({}, {readGate:async id=>{
    active++;maximum=Math.max(maximum,active);
    if(id==='first'){startedFirst();await firstGate;}
    active--;
  }});
  const first=await backend.openPresentation('first','read');
  const second=await backend.openPresentation('second','read');
  const readFirst=first.read();
  await firstStarted;
  const readSecond=second.read();
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(active,1,'the second presentation read must wait before native read allocates the whole log');
  releaseFirst();
  await Promise.all([readFirst,readSecond]);
  assert.equal(maximum,1);
  const full=await backend.open('owner','read');
  await full.read();
  assert.equal(active,0,'the full-fidelity path may proceed after serialized presentations');
  await full.close();
});

test('presentation handle methods preserve this and presentation mode after opening', async () => {
  const { backend } = setup();
  const handle = await backend.openPresentation('owner', 'write');
  assert.equal((await handle.read()).events[0].data.meta.lines.length, 0);
  await handle.append([clone(previewEvent)]);
  assert.equal(backend.cursor, 1);
  assert.equal(plain(backend.writes[0])[1].data.meta.lines[0].text, 'original text');
  assert.equal((await handle.read()).events[0].data.meta.lines.length, 0);
  await handle.close();
  assert.equal(handle.closed, true);
});

test('controller decoding retains native validation and never silently falls back', async () => {
  const failure = new Error('official sequence refusal');
  const { backend } = setup({ controller: { async readStoredPrefix() {
    return { meta: clone(header), events: [{ ...clone(previewEvent), seq: 9 }] };
  } } });
  await assert.rejects(async () => (await backend.openPresentation('owner', 'read')).read(), { message: failure.message });
  assert.equal(backend.validationRuns, 1);
  const broken = setup({ controller: { async readStoredPrefix() { throw new Error('controller corruption'); } } });
  await assert.rejects(async () => (await broken.backend.openPresentation('owner', 'read')).read(), /controller corruption/);
  assert.equal(broken.backend.validationRuns, 0);
});

test('scope helpers isolate memo entries and mutation invalidates both modes', async () => {
  const { backend } = setup();
  backend.runPresentation(() => backend.coldLogMemo.set('owner', 'preview'));
  backend.runFull(() => backend.coldLogMemo.set('owner', 'full'));
  assert.equal(backend.runPresentation(() => backend.coldLogMemo.get('owner')), 'preview');
  assert.equal(backend.runFull(() => backend.coldLogMemo.get('owner')), 'full');
  backend.coldLogMemo.delete('owner');
  assert.equal(backend.runPresentation(() => backend.coldLogMemo.size), 0);
  assert.equal(backend.runFull(() => backend.coldLogMemo.size), 0);
});

test('fork materialization restores each original event and keeps the header frame independent', async () => {
  const parts = [];
  const { backend, restoredOwners } = setup({ compressFrame: async input => {
    parts.push(Buffer.from(input)); return compressFrame(input);
  } });
  const events = [clone(previewEvent), { ...clone(previewEvent), seq: 1 }];
  await backend.persistBatch({ ...header, id: 'child' }, events, false, 0);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].toString().split('\n').length, 2);
  const rows = plain(backend.writes[0]);
  assert.equal(rows[0].id, 'child');
  assert.deepEqual(rows.slice(1).map(row => row.seq), [0, 1]);
  assert.deepEqual(rows[1].data.meta, sourceEvent.data.meta);
  assert.deepEqual(rows[2].data.meta, sourceEvent.data.meta);
  assert.equal(rows.some(row => Object.hasOwn(row.data?.meta ?? {}, 'locator')), false);
  assert.deepEqual(restoredOwners, ['child', 'child']);
});

test('none compression also restores full metadata and canonical header defaults', async () => {
  const { backend } = setup({}, { compression: 'none' });
  await backend.persistBatch(header, [clone(previewEvent)], false, 0);
  const rows = backend.writes[0].toString().trimEnd().split('\n').map(JSON.parse);
  assert.equal(rows[0].delegationDepth, 0);
  assert.deepEqual(rows[1].data.meta, sourceEvent.data.meta);
});

test('restored rows are encoded in bounded batches rather than retaining all full events', async () => {
  let pending = 0;
  const { backend } = setup({ controller: { async restoreEvent(event) {
    pending++;
    if (pending > 2) throw new Error('too many restored rows before compression');
    return { ...event, data: { text: 'x'.repeat(600_000) } };
  } }, compressFrame: async input => { pending = 0; return compressFrame(input); } });
  await backend.persistBatch(header, [0, 1, 2, 3].map(seq => ({ type: 'fixture', seq, time: 1, data: {} })), true, 0);
  assert.equal(plain(backend.writes[0]).length, 4);
});

test('encoded-byte ceiling fails before native write or postcommit notification', async () => {
  let notified = false;
  const { backend } = setup({ maxEncodedBytes: 1, controller: { async persisted() { notified = true; } } });
  await assert.rejects(backend.persistBatch(header, [clone(previewEvent)], false, 0), /encoded.*limit|encoded.*budget/i);
  assert.equal(backend.writes.length, 0);
  assert.equal(notified, false);
});

test('precommit restore failures propagate without writes or notifications', async () => {
  let notified = false;
  const { backend } = setup({ controller: {
    async restoreEvent() { throw new Error('original data unavailable'); },
    async persisted() { notified = true; },
  } });
  await assert.rejects(backend.persistBatch(header, [clone(previewEvent)], false, 0), /original data unavailable/);
  assert.equal(backend.writes.length, 0);
  assert.equal(notified, false);
});

test('native write refusal does not notify persisted', async () => {
  let notified = false;
  const { backend } = setup({ controller: { async persisted() { notified = true; } } });
  backend.encodeMaterialization = async () => { throw new Error('native write refusal'); };
  await assert.rejects(backend.persistBatch(header, [clone(previewEvent)], false, 0), /native write refusal/);
  assert.equal(notified, false);
});

test('postcommit notification failure cannot reject an acknowledged append or stall its cursor', async () => {
  const notificationFailure = new Error('relocation notification failed');
  const { backend, reported } = setup({ controller: { async persisted() { throw notificationFailure; } } });
  const handle = await backend.openPresentation('owner', 'write');
  await handle.append([clone(previewEvent)]);
  assert.equal(backend.cursor, 1);
  assert.equal(backend.writes.length, 1);
  assert.equal(backend.postCommitErrors.length, 1);
  assert.equal(reported[0], notificationFailure);
  for (let i = 0; i < 20; i++) await backend.persistBatch(header, [], true, 0);
  assert.equal(backend.postCommitErrors.length, 16);
});

test('native validation errors preserve their original identity', async () => {
  const refusal = new Error('native identity refusal');
  const { backend } = setup();
  backend.readZstdPrefix = async () => { throw refusal; };
  await assert.rejects(async () => (await backend.open('owner', 'read')).read(), error => error === refusal);
});
