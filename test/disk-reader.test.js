import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, rm, writeFile, appendFile, readdir, stat, utimes, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync, constants } from 'node:zlib';

// All fixtures are synthetic. No test opens an installed/user session.
const HEADER = { type: 'session', version: 4, id: 'fixture-session', createdAt: 123,
  isSeeded: false, delegationDepth: 0 };
const row = (seq, data = {}) => ({ type: 'tool/ptc-dispatch', seq, time: 123 + seq,
  data: { name: 'read', ...data } });
const jsonl = value => Buffer.from(JSON.stringify(value) + '\n');
const pack = bytes => zstdCompressSync(bytes, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
async function Reader() {
  const module = await import('../lib/disk-reader.js').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return {};
  });
  assert.equal(typeof module.DiskHistoryReader, 'function', 'DiskHistoryReader export must exist');
  return module.DiskHistoryReader;
}
async function fixture(t, chunks, { header = HEADER, packed = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-disk-reader-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'session.v4.jsonl.zstd');
  const frames = [pack(jsonl(header)), ...chunks.map(chunk => packed ? chunk : pack(chunk))];
  await writeFile(file, Buffer.concat(frames));
  return { dir, file, frames };
}

// Removing structural boundaries, retaining callback rows, or normalizing sourceEventSeqs breaks this contract.
test('streams rows with exact physical locators, awaits callbacks, and preserves physical JSON', async t => {
  const DiskHistoryReader = await Reader();
  const first = row(0, { meta: { lines: [{ number: 7, text: 'literal (µ/ý and \\uFD2FB528' }] } });
  const second = { ...row(1, { meta: { lines: [{ number: 1, text: '字'.repeat(1000000) }] } }), sourceEventSeqs: [0] };
  const { file, dir, frames } = await fixture(t, [Buffer.concat([jsonl(first), jsonl(second)]), jsonl(row(2))]);
  const reader = new DiskHistoryReader(file);
  let busy = false, count = 0, headerCount = 0;
  const locations = [];
  const result = await reader.scan({ onHeader(header) { assert.deepEqual(header, HEADER); headerCount++; },
    async onEvent(event, locator) {
      assert.equal(busy, false); busy = true;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(event.seq, count++);
      if (event.seq === 1) assert.equal(event.data.meta.lines[0].text.length, 1000000);
      locations.push(locator); busy = false;
    } });
  assert.equal(headerCount, 1); assert.equal(count, 3);
  assert.equal(result.id, 'fixture-session'); assert.equal(result.events, 3); assert.equal(result.indexEntries, 3);
  assert.equal(result.compressedBytes, frames.reduce((n, frame) => n + frame.length, 0));
  assert.equal(result.expandedBytes, jsonl(HEADER).length + jsonl(first).length + jsonl(second).length + jsonl(row(2)).length);
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  assert.equal(result.compressedSha256, createHash('sha256').update(Buffer.concat(frames)).digest('hex'));
  assert.deepEqual(locations[0], { seq: 0, frameOffset: frames[0].length, frameLength: frames[1].length,
    endFrameOffset: frames[0].length, endFrameLength: frames[1].length, lineOffset: 0, lineBytes: jsonl(first).length - 1 });
  assert.equal(locations[1].lineOffset, jsonl(first).length);
  // Caller mutations must not change the reader's private index or snapshot.
  locations[0].frameOffset = 0;
  assert.deepEqual(await reader.readEvent(0, { revision: result.revision }), first);
  const event = await reader.readEvent(1); assert.deepEqual(event.sourceEventSeqs, [0]);
  event.data.meta.lines[0].text = 'caller changed this';
  assert.equal((await reader.readEvent(1)).data.meta.lines[0].text.length, 1000000);
  assert.deepEqual(await readdir(dir), ['session.v4.jsonl.zstd']);
  reader.close();
});

test('reassembles a JSONL row and a UTF8 scalar split across physical frames', async t => {
  const DiskHistoryReader = await Reader();
  const event = row(0, { meta: { lines: [{ number: 1, text: '前😀后' }] } });
  const bytes = jsonl(event), split = bytes.indexOf(Buffer.from('😀')) + 2;
  const { file, frames } = await fixture(t, [bytes.subarray(0, split), bytes.subarray(split, split + 1), bytes.subarray(split + 1), jsonl(row(1))]);
  const reader = new DiskHistoryReader(file); let locator;
  await reader.scan({ onEvent(event, location) { if (event.seq === 0) locator = location; } });
  assert.equal(locator.frameOffset, frames[0].length);
  assert.equal(locator.endFrameOffset, frames[0].length + frames[1].length + frames[2].length);
  assert.equal(locator.endFrameLength, frames[3].length);
  assert.deepEqual(await reader.readEvent(0), event);
  reader.close();
});

test('paginates huge Unicode and escaped lines within the exact serialized JSON byte cap', async t => {
  const DiskHistoryReader = await Reader();
  const lines = [{ number: 1, text: '😀汉\\\"\n\u0000é'.repeat(2200) }, { number: 2, text: '' },
    { number: 900, text: '末行🧑‍💻' }, { number: 901, text: '\ud800 ends' }];
  const { file } = await fixture(t, [jsonl(row(0, { meta: { lines } }))]);
  const reader = new DiskHistoryReader(file); const { revision } = await reader.scan();
  const reconstructed = new Map(); let offset = 0, textOffset = 0, pages = 0;
  for (;;) {
    const page = await reader.readPtcLines(0, { revision, offset, textOffset, limit: 2, maxBytes: 1024 });
    assert.equal(Buffer.byteLength(JSON.stringify(page)) <= 1024, true);
    assert.deepEqual(JSON.parse(JSON.stringify(page)), page);
    assert.equal(page.seq, 0); assert.equal(page.revision, revision);
    assert.ok(page.lines.length > 0); assert.ok(page.lines.length <= 2);
    for (const fragment of page.lines) {
      assert.equal(typeof fragment.continued, 'boolean');
      const previous = reconstructed.get(fragment.number) ?? '';
      assert.equal(fragment.textOffset, previous.length);
      assert.equal(fragment.text.isWellFormed() || fragment.text.includes('\ud800'), true);
      reconstructed.set(fragment.number, previous + fragment.text);
    }
    if (!page.hasMore) { assert.equal(page.nextOffset, lines.length); assert.equal(page.nextTextOffset, 0); break; }
    assert.ok(page.nextOffset > offset || page.nextTextOffset > textOffset);
    offset = page.nextOffset; textOffset = page.nextTextOffset;
    assert.ok(++pages < 1000);
  }
  assert.deepEqual([...reconstructed].map(([number, text]) => ({ number, text })), lines);
  const end = await reader.readPtcLines(0, { offset: lines.length });
  assert.deepEqual(end.lines, []); assert.equal(end.hasMore, false);
  for (const options of [{ maxBytes: 1023 }, { maxBytes: 1048577 }, { limit: 0 }, { offset: -1 }, { textOffset: 1.5 }]) {
    await assert.rejects(reader.readPtcLines(0, options), /maxBytes|limit|offset|textOffset/);
  }
  await assert.rejects(reader.readPtcLines(0, { textOffset: 1 }), /surrogate|textOffset/);
  reader.close();
});

test('rejects non-read details and malformed meta.lines instead of coercing them', async t => {
  const DiskHistoryReader = await Reader();
  const { file } = await fixture(t, [Buffer.concat([jsonl(row(0, { name: 'write', meta: { lines: [] } })),
    jsonl(row(1, { meta: { lines: [{ number: 1, text: 123 }] } })), jsonl(row(2, { meta: { lines: [] } }))])]);
  const reader = new DiskHistoryReader(file); await reader.scan();
  await assert.rejects(reader.readPtcLines(0), /read|ptc/);
  await assert.rejects(reader.readPtcLines(1), /meta|lines|text/);
  assert.equal((await reader.readPtcLines(2)).hasMore, false); reader.close();
});

// A tiny fixed 7-bit Huffman alphabet encodes ASCII independently of our reader.
// Flipping four entropy bytes gives valid JSON text while placing real zstd magic
// inside the compressed block (not merely a Unicode spelling of those bytes).
function magicPayloadFrame() {
  const input = jsonl({ type: 'x', seq: 0, time: 1, data: { text: 'a'.repeat(800) } });
  let bits = 0n, bitCount = 0n;
  for (let i = input.length - 1; i >= 0; i--) { bits |= BigInt(input[i]) << bitCount; bitCount += 7n; }
  bits |= 1n << bitCount;
  const entropy = Buffer.alloc(Number(bitCount / 8n) + 1);
  for (let i = 0; i < entropy.length; i++) entropy[i] = Number(bits >> BigInt(i * 8) & 255n);
  const weights = Buffer.concat([Buffer.from([254]), Buffer.alloc(64, 0x11)]); weights[64] = 0x10;
  const payload = Buffer.concat([weights, entropy]);
  const literals = Buffer.alloc(3); literals.writeUIntLE((payload.length << 14) | (input.length << 4) | 2, 0, 3);
  const block = Buffer.concat([literals, payload, Buffer.from([0])]); // zero sequences
  const blockHeader = Buffer.alloc(3); blockHeader.writeUIntLE((block.length << 3) | 5, 0, 3);
  const frameHeader = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x60, 0, 0]); frameHeader.writeUInt16LE(input.length - 256, 5);
  const packed = Buffer.concat([frameHeader, blockHeader, block]);
  Buffer.from([0x28, 0xb5, 0x2f, 0xfd]).copy(packed, 106);
  return packed;
}

test('reads valid JSON despite physical magic bytes inside compressed entropy', async t => {
  const DiskHistoryReader = await Reader();
  const packed = magicPayloadFrame();
  assert.equal(packed.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), 4), 106);
  const { file } = await fixture(t, [packed, pack(jsonl(row(1)))], { packed: true });
  const reader = new DiskHistoryReader(file); const { events } = await reader.scan();
  assert.equal(events, 2);
  assert.deepEqual(await reader.readEvent(0), { type: 'x', seq: 0, time: 1,
    data: { text: 'a'.repeat(767) + 'oi>j(' + 'a'.repeat(28) } });
  assert.deepEqual(await reader.readEvent(1), row(1)); reader.close();
});

test('reads only the header proof and exact containing frames, without a whole-log re-read', async t => {
  const DiskHistoryReader = await Reader();
  const event = row(1, { meta: { lines: [{ number: 1, text: 'target' }] } });
  const bytes = jsonl(event);
  const { file, frames } = await fixture(t, [jsonl(row(0)), bytes.subarray(0, 30), bytes.subarray(30), jsonl(row(2))]);
  const reader = new DiskHistoryReader(file); await reader.scan();
  const actualOpen = fs.open, reads = [];
  // Record real OS reads; this spy delegates every operation to the real fd.
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await actualOpen(...args), actualRead = handle.read.bind(handle);
    handle.read = async (buffer, offset, length, position) => {
      reads.push({ position, length }); return actualRead(buffer, offset, length, position);
    };
    return handle;
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await reader.readEvent(1), event);
    const begin = frames[0].length + frames[1].length;
    const end = begin + frames[2].length + frames[3].length;
    assert.ok(reads.some(read => read.position === begin && read.length === frames[2].length));
    assert.ok(reads.some(read => read.position === begin + frames[2].length && read.length === frames[3].length));
    for (const read of reads) assert.ok((read.position >= 0 && read.position + read.length <= frames[0].length)
      || (read.position >= begin && read.position + read.length <= end), JSON.stringify(read));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); reader.close(); }
});

// Raw Zstandard blocks keep this performance fixture physically large without
// depending on compressor heuristics; the production structural parser is not used.
function rawBlockFrame(bytes) {
  const header = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xa0, 0, 0, 0, 0]);
  header.writeUInt32LE(bytes.length, 5);
  const chunks = [header];
  for (let at = 0; at < bytes.length; at += 131072) {
    const length = Math.min(131072, bytes.length - at), block = Buffer.alloc(3);
    block.writeUIntLE((length << 3) | (at + length === bytes.length ? 1 : 0), 0, 3);
    chunks.push(block, bytes.subarray(at, at + length));
  }
  return Buffer.concat(chunks);
}

test('scan amortizes multi-block and small-frame reads within bounded compressed windows', async t => {
  const DiskHistoryReader = await Reader();
  const big = row(0, { meta: { lines: [{ number: 1, text: 'x'.repeat(9 * 1024 * 1024) }] } });
  const chunks = [rawBlockFrame(jsonl(big))];
  for (let seq = 1; seq <= 256; seq++) chunks.push(pack(jsonl(row(seq))));
  const { file, dir, frames } = await fixture(t, chunks, { packed: true });
  const size = frames.reduce((sum, frame) => sum + frame.length, 0);
  const reader = new DiskHistoryReader(file, { maxRowMiB: 16 });
  const actualOpen = fs.open, reads = [];
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await actualOpen(...args), actualRead = handle.read.bind(handle);
    handle.read = async (buffer, offset, length, position) => {
      reads.push({ position, length }); return actualRead(buffer, offset, length, position);
    };
    return handle;
  });
  syncBuiltinESMExports();
  try {
    let rows = 0;
    const result = await reader.scan({ onEvent(event) { assert.equal(event.seq, rows++); } });
    assert.equal(rows, 257); assert.equal(result.events, 257);
    assert.equal(result.compressedSha256, createHash('sha256').update(Buffer.concat(frames)).digest('hex'));
    // One structural and one packed pass over a large frame, plus the independent
    // 1MiB verification pass; small frame headers must reuse the same windows.
    const budget = 2 * Math.ceil(size / (4 * 1024 * 1024)) + Math.ceil(size / (1024 * 1024)) + 4;
    t.diagnostic(`${size} compressed bytes, ${reads.length} OS reads, budget ${budget}`);
    assert.ok(reads.length <= budget, `${reads.length} OS reads exceeds page budget ${budget}`);
    for (const read of reads) {
      assert.ok(read.length > 0 && read.length <= 4 * 1024 * 1024, `unbounded read ${read.length}`);
      assert.ok(read.position >= 0 && read.position + read.length <= size, JSON.stringify(read));
    }
    assert.deepEqual(await readdir(dir), ['session.v4.jsonl.zstd']);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); reader.close(); }
});

// The raw block intentionally contains magic bytes but invalid UTF8: the failure must be UTF8, not a false frame split.
test('does not split a physical raw block at embedded zstd magic', async t => {
  const DiskHistoryReader = await Reader();
  const bytes = Buffer.concat([Buffer.from('{"type":"x","seq":0,"time":1,"data":{"text":"'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('"}}\n')]);
  const header = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, bytes.length]);
  const block = Buffer.alloc(3); block.writeUIntLE((bytes.length << 3) | 1, 0, 3);
  const { file } = await fixture(t, [Buffer.concat([header, block, bytes])], { packed: true });
  await assert.rejects(new DiskHistoryReader(file).scan(), /UTF.?8|encoded data/i);
});

test('rejects checksum damage, truncation, unterminated tail, seq gaps, and invalid headers', async t => {
  const DiskHistoryReader = await Reader();
  const damaged = pack(jsonl(row(0))); damaged[damaged.length - 1] ^= 1;
  const cases = [
    { chunks: [damaged], packed: true, error: /checksum|corrupt/i },
    { chunks: [pack(jsonl(row(0))).subarray(0, -1)], packed: true, error: /truncat/i },
    { chunks: [Buffer.from(JSON.stringify(row(0)))], error: /tail|newline|unterminated/i },
    { chunks: [Buffer.concat([jsonl(row(0)), jsonl(row(2))])], error: /seq/i },
    { chunks: [jsonl(row(1))], error: /seq/i },
    { chunks: [Buffer.from('\n')], error: /JSONL|empty/i },
    { chunks: [jsonl(row(0))], header: { ...HEADER, version: 3 }, error: /header|version|V4/i },
    { chunks: [jsonl(row(0))], header: { ...HEADER, createdAt: 'date' }, error: /header/i },
    { chunks: [jsonl(row(0))], header: { ...HEADER, sandboxMode: 'x' }, error: /header/i },
    { chunks: [jsonl({ ...row(0), type: 'session' })], error: /header|session/i },
  ];
  for (const item of cases) {
    const { file } = await fixture(t, item.chunks, item);
    const reader = new DiskHistoryReader(file);
    await assert.rejects(reader.scan(), item.error);
    await assert.rejects(reader.readEvent(0), /scan/i); reader.close();
  }
  const { file } = await fixture(t, []);
  await writeFile(file, pack(Buffer.concat([jsonl(HEADER), jsonl(row(0))])));
  await assert.rejects(new DiskHistoryReader(file).scan(), /first|header/i);
});

test('bounds compressed frames, expanded frames, JSONL rows, and the retained index', async t => {
  const DiskHistoryReader = await Reader();
  const { file } = await fixture(t, [jsonl(row(0, { text: 'x'.repeat(5000) }))]);
  await assert.rejects(new DiskHistoryReader(file, { maxFrameMiB: 0.001 }).scan(), /frame|output|buffer/i);
  await assert.rejects(new DiskHistoryReader(file, { maxRowMiB: 0.001 }).scan(), /row/i);
  const f2 = await fixture(t, [Buffer.concat([jsonl(row(0)), jsonl(row(1))])]);
  const reader = new DiskHistoryReader(f2.file, { maxIndexEntries: 1 });
  await assert.rejects(reader.scan(), /index/i); await assert.rejects(reader.readEvent(0), /scan/i);
  for (const options of [{ maxFrameMiB: 0 }, { maxRowMiB: Infinity }, { maxIndexEntries: -1 }]) {
    assert.throws(() => new DiskHistoryReader(file, options), /max/);
  }
  reader.close();
});

test('rejects stale revisions after append, timestamp-only changes, and replacement inode', async t => {
  const DiskHistoryReader = await Reader();
  for (const mutation of ['append', 'timestamp', 'replace']) {
    const { file, dir } = await fixture(t, [jsonl(row(0))]);
    const reader = new DiskHistoryReader(file); const { revision } = await reader.scan();
    if (mutation === 'append') await appendFile(file, pack(jsonl(row(1))));
    if (mutation === 'timestamp') { const st = await stat(file); await utimes(file, st.atime, new Date(st.mtimeMs + 5000)); }
    if (mutation === 'replace') { await rename(file, join(dir, 'old')); await writeFile(file, Buffer.concat([pack(jsonl(HEADER)), pack(jsonl(row(0)))])); }
    await assert.rejects(reader.readEvent(0, { revision }), /stale|changed/i);
    await assert.rejects(reader.readPtcLines(0, { revision }), /stale|changed/i);
    reader.close();
  }
});

test('fails snapshots changed during callback and permits a clean retry after scan failure', async t => {
  const DiskHistoryReader = await Reader();
  const { file } = await fixture(t, [jsonl(row(0))]);
  const reader = new DiskHistoryReader(file); let changed = false;
  await assert.rejects(reader.scan({ async onEvent() { if (!changed) { changed = true; await appendFile(file, pack(jsonl(row(1)))); } } }), /changed|stale/i);
  await assert.rejects(reader.readEvent(0), /scan/i);
  const result = await reader.scan(); assert.equal(result.events, 2);
  await assert.rejects(reader.readEvent(0, { revision: 'wrong' }), /revision|stale/i); reader.close();
});

test('honors abort, closed lifecycle, and unknown seq without keeping file descriptors open', async t => {
  const DiskHistoryReader = await Reader();
  const { file, dir } = await fixture(t, [jsonl(row(0))]);
  const reader = new DiskHistoryReader(file);
  await assert.rejects(reader.readEvent(0), /scan/i);
  await assert.rejects(reader.scan({ signal: AbortSignal.abort() }), /abort/i);
  await reader.scan();
  await assert.rejects(reader.readEvent(10), /seq|found|range/i);
  await assert.rejects(reader.readEvent(0, { signal: AbortSignal.abort() }), /abort/i);
  reader.close(); reader.close();
  await assert.rejects(reader.scan(), /closed/i); await assert.rejects(reader.readEvent(0), /closed/i);
  await assert.rejects(reader.readPtcLines(0), /closed/i);
  // Windows permits renaming only when our handles have actually been closed.
  await rename(file, join(dir, 'renamed')); assert.deepEqual(await readdir(dir), ['renamed']);
});
