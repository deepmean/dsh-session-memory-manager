/**
 * Read-only, bounded access to one stable session.v4.jsonl.zstd generation.
 *
 * Frame structure follows the installed DSH session-persistence-jsonl/src/zstd.ts
 * (0.2.2-rc.5), adapted to positional, bounded file reads. No magic search and no
 * dependency on the upstream lazy-view frame scanner or DSH runtime is used.
 *
 * MIT License — Copyright (c) 2026 DeepSeek
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { open, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { zstdDecompressSync, constants } from 'node:zlib';

const MiB = 1024 * 1024;
const MAGIC = 0xfd2fb528;

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function count(value) { return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0); }
function integer(value, label, minimum = 0) {
  if (!count(value) || value < minimum) throw new RangeError(`${label} must be a safe integer >= ${minimum}`);
  return value;
}
function byteLimit(value, label) {
  if (!Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(Math.floor(value * MiB)) || value * MiB < 1) {
    throw new RangeError(`${label} must be a positive finite MiB limit`);
  }
  return Math.floor(value * MiB);
}
function checkAbort(signal) {
  if (signal?.aborted) {
    const error = new Error('disk history read aborted', { cause: signal.reason });
    error.name = 'AbortError'; throw error;
  }
}
function signature(info) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.birthtimeNs].join(':');
}
async function readExact(handle, length, position, size, check) {
  check();
  if (position + length > size) throw new Error(`truncated Zstandard frame at byte ${position}`);
  const buffer = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    check();
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (!bytesRead) throw new Error(`truncated Zstandard frame at byte ${position + done}`);
    done += bytesRead;
  }
  check(); return buffer;
}

/**
 * Scan-local compressed read-ahead. Structural headers and packed frame reads
 * share one reusable <=4MiB buffer, so tiny headers do not each issue an OS read.
 * Large packed reads are served in pieces through readExact's existing loop.
 * This object never wraps stat/close, never survives scan(), and is deliberately
 * not used by readEvent or the independent second-pass file hash.
 */
function scanReadWindow(handle, size, check) {
  const window = Buffer.allocUnsafe(Math.min(4 * MiB, size));
  let start = 0, available = 0;
  return {
    async read(buffer, offset, length, position) {
      check();
      if (position < start || position >= start + available) {
        start = position;
        const requested = Math.min(window.length, size - position);
        const result = await handle.read(window, 0, requested, position);
        available = result.bytesRead;
        check();
        if (!available) return { bytesRead: 0 };
      }
      const bytesRead = Math.min(length, start + available - position);
      window.copy(buffer, offset, position - start, position - start + bytesRead);
      check();
      return { bytesRead };
    },
  };
}

/** Walk descriptor and block sizes. Payload magic is ordinary data. */
async function readFrame(handle, start, size, maxBytes, check) {
  const head = await readExact(handle, 5, start, size, check);
  if (head.readUInt32LE(0) !== MAGIC) throw new Error(`invalid Zstandard frame magic at byte ${start}`);
  const descriptor = head[4];
  if (descriptor & 0x18) throw new Error('reserved Zstandard frame-header bits');
  const flag = descriptor >>> 6, single = Boolean(descriptor & 0x20);
  const dictionaryFlag = descriptor & 3, dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentSizeBytes = flag === 0 ? (single ? 1 : 0) : 1 << flag;
  const fields = await readExact(handle, (single ? 0 : 1) + dictionaryBytes + contentSizeBytes, start + 5, size, check);
  if (!single) {
    const base = 2 ** (10 + (fields[0] >>> 3));
    const window = base + base / 8 * (fields[0] & 7);
    if (window > maxBytes) throw new Error('Zstandard frame window exceeds maxFrameMiB');
  }
  if (contentSizeBytes) {
    const at = (single ? 0 : 1) + dictionaryBytes;
    const value = contentSizeBytes === 8 ? fields.readBigUInt64LE(at) : BigInt(fields.readUIntLE(at, contentSizeBytes));
    if (value + (contentSizeBytes === 2 ? 256n : 0n) > BigInt(maxBytes)) {
      throw new Error('expanded frame exceeds maxFrameMiB');
    }
  }
  let position = start + 5 + fields.length;
  for (;;) {
    const block = await readExact(handle, 3, position, size, check);
    position += 3;
    const value = block.readUIntLE(0, 3), type = (value >>> 1) & 3, bytes = value >>> 3;
    if (type === 3) throw new Error('reserved Zstandard block type');
    if (bytes > 131072) throw new Error('oversized Zstandard block');
    position += type === 1 ? 1 : bytes;
    if (position > size) throw new Error('truncated Zstandard block');
    if (position - start > maxBytes) throw new Error('compressed frame exceeds maxFrameMiB');
    if (value & 1) break;
  }
  if (descriptor & 4) position += 4;
  if (position - start > maxBytes) throw new Error('compressed frame exceeds maxFrameMiB');
  const packed = await readExact(handle, position - start, start, size, check);
  let plain;
  try {
    plain = zstdDecompressSync(packed, {
      maxOutputLength: maxBytes,
      params: { [constants.ZSTD_d_windowLogMax]: Math.max(10, Math.ceil(Math.log2(maxBytes))) },
    });
  } catch (cause) { throw new Error(`corrupt Zstandard frame/checksum at byte ${start}: ${cause.message}`, { cause }); }
  check(); return { offset: start, length: packed.length, packed, plain };
}
function parseRow(bytes) {
  if (!bytes.length) throw new Error('empty JSONL row');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch (cause) { throw new Error('invalid UTF8 in JSONL row', { cause }); }
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSONL row must be an object');
  return value;
}
function validateHeader(header) {
  const allowed = ['type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth', 'cwd', 'parentSession', 'origin', 'agentPreset'];
  if (header.type !== 'session' || header.version !== 4 || typeof header.id !== 'string'
    || !count(header.createdAt) || !count(header.delegationDepth) || typeof header.isSeeded !== 'boolean'
    || Object.keys(header).some(key => !allowed.includes(key))
    || (header.cwd !== undefined && (typeof header.cwd !== 'string' || !isAbsolute(header.cwd)))
    || ['parentSession', 'agentPreset'].some(key => header[key] !== undefined && typeof header[key] !== 'string')
    || (header.origin !== undefined && header.origin !== 'subagent')) {
    throw new Error('invalid native V4 session header');
  }
}
function validateEvent(row, seq) {
  if (row.type === 'session') throw new Error('session header may appear only in the first frame');
  if (typeof row.type !== 'string' || row.type.length === 0) throw new Error('JSONL event requires a type');
  if (!count(row.seq) || row.seq !== seq) throw new Error(`invalid event seq: expected ${seq}, got ${String(row.seq)}`);
}

/**
 * Holds only a bounded seq -> locator/hash index and snapshot identity.
 * Locators contain compressed frame spans, a first-frame expanded byte offset,
 * and the raw JSONL byte length excluding LF. Callback locators are detached.
 * scan() is atomic with respect to this index: callbacks are provisional until
 * it resolves. Callers must discard their own callback output if scan rejects.
 */
export class DiskHistoryReader {
  #file; #maxFrame; #maxRow; #maxIndex; #index = new Map(); #snapshot;
  #closed = false; #scanning = false; #reading = 0;

  constructor(file, { maxFrameMiB = 64, maxRowMiB = 8, maxIndexEntries = 200000 } = {}) {
    this.#file = file;
    this.#maxFrame = byteLimit(maxFrameMiB, 'maxFrameMiB');
    this.#maxRow = byteLimit(maxRowMiB, 'maxRowMiB');
    this.#maxIndex = integer(maxIndexEntries, 'maxIndexEntries');
  }
  #check(signal) {
    if (this.#closed) throw new Error('DiskHistoryReader is closed');
    checkAbort(signal);
  }
  async #stable(handle, expected, signal) {
    this.#check(signal);
    const fromHandle = await handle.stat({ bigint: true });
    let fromPath;
    try { fromPath = await stat(this.#file, { bigint: true }); }
    catch (cause) { throw new Error('stale disk history: source path changed', { cause }); }
    if (signature(fromHandle) !== expected || signature(fromPath) !== expected) {
      throw new Error('stale disk history: source file changed');
    }
    this.#check(signal);
  }
  async #hashFile(handle, size, signal) {
    const hash = createHash('sha256');
    for (let position = 0; position < size; position += MiB) {
      hash.update(await readExact(handle, Math.min(MiB, size - position), position, size, () => this.#check(signal)));
    }
    return hash.digest('hex');
  }

  async scan({ onHeader, onEvent, signal } = {}) {
    this.#check(signal);
    if (this.#scanning || this.#reading) throw new Error('cannot scan while a disk history operation is active');
    this.#scanning = true; this.#index.clear(); this.#snapshot = undefined;
    let handle;
    try {
      handle = await open(this.#file, 'r');
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.size === 0n) throw new Error('empty or non-file session source');
      if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('session file is too large for safe physical offsets');
      const size = Number(info.size), proof = signature(info);
      await this.#stable(handle, proof, signal);
      const hash = createHash('sha256');
      const source = scanReadWindow(handle, size, () => this.#check(signal));
      let position = 0, events = 0, expandedBytes = 0, id, headerLength, headerHash;
      let fragments = [], fragmentBytes = 0, first;
      while (position < size) {
        this.#check(signal);
        const frame = await readFrame(source, position, size, this.#maxFrame, () => this.#check(signal));
        hash.update(frame.packed); expandedBytes += frame.plain.length;
        if (!Number.isSafeInteger(expandedBytes)) throw new Error('expanded byte count exceeds safe integer range');
        if (position === 0) {
          if (!frame.plain.length || frame.plain.indexOf(10) !== frame.plain.length - 1) {
            throw new Error('first Zstandard frame must contain only the newline-terminated header');
          }
          if (frame.plain.length - 1 > this.#maxRow) throw new Error('header row exceeds maxRowMiB');
          const header = parseRow(frame.plain.subarray(0, -1)); validateHeader(header);
          id = header.id; headerLength = frame.length; headerHash = digest(frame.packed);
          if (onHeader) await onHeader(header);
          this.#check(signal);
        } else {
          let start = 0;
          for (;;) {
            const end = frame.plain.indexOf(10, start);
            if (end === -1) break;
            const length = fragmentBytes + end - start;
            if (length > this.#maxRow) throw new Error('JSONL row exceeds maxRowMiB');
            const part = frame.plain.subarray(start, end);
            const bytes = fragments.length ? Buffer.concat([...fragments, part], length) : part;
            const event = parseRow(bytes); validateEvent(event, events);
            if (this.#index.size >= this.#maxIndex) throw new Error('index exceeds maxIndexEntries');
            const locator = { seq: events,
              frameOffset: first?.offset ?? frame.offset, frameLength: first?.length ?? frame.length,
              endFrameOffset: frame.offset, endFrameLength: frame.length,
              lineOffset: first?.lineOffset ?? start, lineBytes: length };
            this.#index.set(events, { locator, rowHash: digest(bytes) });
            events++; fragments = []; fragmentBytes = 0; first = undefined;
            if (onEvent) await onEvent(event, { ...locator });
            this.#check(signal); start = end + 1;
          }
          if (start < frame.plain.length) {
            first ??= { offset: frame.offset, length: frame.length, lineOffset: start };
            const part = Buffer.from(frame.plain.subarray(start));
            fragmentBytes += part.length;
            if (fragmentBytes > this.#maxRow) throw new Error('JSONL row exceeds maxRowMiB');
            fragments.push(part);
          }
        }
        position += frame.length;
        await yieldToLoop(); this.#check(signal);
      }
      if (fragmentBytes) throw new Error('unterminated JSONL tail: final row requires a newline');
      const compressedSha256 = hash.digest('hex');
      await this.#stable(handle, proof, signal);
      // A bounded second read proves callback-time rewrites did not mix versions.
      // It never decompresses or stores the complete compressed file.
      if (await this.#hashFile(handle, size, signal) !== compressedSha256) {
        throw new Error('stale disk history: source file hash changed during scan');
      }
      await this.#stable(handle, proof, signal);
      const revision = digest(`${proof}:${compressedSha256}:${headerHash}`);
      this.#snapshot = { id, revision, proof, size, headerLength, headerHash };
      return { id, revision, events, compressedBytes: size, expandedBytes,
        indexEntries: this.#index.size, compressedSha256 };
    } catch (error) {
      this.#index.clear(); this.#snapshot = undefined; throw error;
    } finally {
      if (handle) await handle.close();
      this.#scanning = false;
    }
  }

  async readEvent(seq, { revision, signal } = {}) {
    this.#check(signal);
    if (this.#scanning || !this.#snapshot) throw new Error('scan must complete before readEvent');
    integer(seq, 'seq');
    const snapshot = this.#snapshot;
    if (revision !== undefined && revision !== snapshot.revision) throw new Error('stale disk history revision');
    const entry = this.#index.get(seq);
    if (!entry) throw new RangeError(`event seq ${seq} not found`);
    this.#reading++;
    let handle;
    try {
      handle = await open(this.#file, 'r');
      await this.#stable(handle, snapshot.proof, signal);
      const header = await readExact(handle, snapshot.headerLength, 0, snapshot.size, () => this.#check(signal));
      if (digest(header) !== snapshot.headerHash) throw new Error('stale disk history: header evidence changed');
      const location = entry.locator;
      let position = location.frameOffset, remaining = location.lineBytes;
      const parts = [];
      while (position <= location.endFrameOffset) {
        const frame = await readFrame(handle, position, snapshot.size, this.#maxFrame, () => this.#check(signal));
        if ((position === location.frameOffset && frame.length !== location.frameLength)
          || (position === location.endFrameOffset && frame.length !== location.endFrameLength)
          || position + frame.length > location.endFrameOffset + location.endFrameLength) {
          throw new Error('stale disk history: physical frame span changed');
        }
        const start = position === location.frameOffset ? location.lineOffset : 0;
        const length = Math.min(remaining, frame.plain.length - start);
        if (length < 0) throw new Error('stale disk history: line offset changed');
        if (length) parts.push(Buffer.from(frame.plain.subarray(start, start + length)));
        remaining -= length;
        if (position === location.endFrameOffset && (remaining || frame.plain[start + length] !== 10)) {
          throw new Error('stale disk history: JSONL line span changed');
        }
        position += frame.length;
        await yieldToLoop(); this.#check(signal);
      }
      const bytes = Buffer.concat(parts, location.lineBytes);
      if (remaining || digest(bytes) !== entry.rowHash) throw new Error('stale disk history: event evidence changed');
      const event = parseRow(bytes); validateEvent(event, seq);
      await this.#stable(handle, snapshot.proof, signal);
      if (this.#snapshot !== snapshot) throw new Error('stale disk history snapshot');
      return event;
    } finally {
      if (handle) await handle.close();
      this.#reading--;
    }
  }

  /**
   * Explicit plain-JSON detail page. offset indexes meta.lines; textOffset is a
   * UTF-16 code-unit offset, always at a scalar boundary for paired surrogates.
   * continued means that this same source line has text remaining. The next
   * cursor can be passed verbatim to the next call; no decoded frames survive.
   */
  async readPtcLines(seq, { revision, offset = 0, limit = 100, maxBytes = 65536, textOffset = 0, signal } = {}) {
    this.#check(signal);
    integer(offset, 'offset'); integer(textOffset, 'textOffset'); integer(limit, 'limit', 1);
    integer(maxBytes, 'maxBytes', 1024);
    if (maxBytes > MiB) throw new RangeError('maxBytes must be <= 1 MiB');
    const event = await this.readEvent(seq, { revision, signal });
    const pageRevision = this.#snapshot.revision;
    if (event.type !== 'tool/ptc-dispatch' || event.data?.name !== 'read' || !Array.isArray(event.data?.meta?.lines)) {
      throw new Error('PTC details require tool/ptc-dispatch read with meta.lines');
    }
    const source = event.data.meta.lines;
    for (const line of source) {
      this.#check(signal);
      if (!line || !count(line.number) || typeof line.text !== 'string') throw new Error('invalid meta.lines number/text');
    }
    if (offset > source.length || (offset === source.length && textOffset !== 0)
      || (offset < source.length && textOffset > source[offset].text.length)) throw new RangeError('offset/textOffset outside meta.lines');
    if (offset < source.length && splitsPair(source[offset].text, textOffset)) throw new RangeError('textOffset splits a surrogate pair');
    const lines = [];
    let cursor = offset, at = textOffset;
    const page = (nextOffset, nextTextOffset, added) => ({ seq, revision: pageRevision,
      lines: added ? [...lines, added] : [...lines], nextOffset, nextTextOffset, hasMore: nextOffset < source.length });
    while (cursor < source.length && lines.length < limit) {
      this.#check(signal);
      const original = source[cursor];
      // JSON escaping can only increase a string's byte length; bound the
      // candidate before stringify so even tiny pages avoid huge allocations.
      const maximum = Math.min(original.text.length, at + maxBytes);
      const candidate = end => {
        if (splitsPair(original.text, end)) end--;
        const continued = end < original.text.length;
        const fragment = { number: original.number, text: original.text.slice(at, end), textOffset: at, continued };
        const value = page(continued ? cursor : cursor + 1, continued ? end : 0, fragment);
        return { end, fragment, value, fits: Buffer.byteLength(JSON.stringify(value)) <= maxBytes };
      };
      let low = at, high = maximum;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (candidate(middle).fits) low = middle; else high = middle - 1;
      }
      const choice = candidate(low);
      if (!choice.fits || (choice.end === at && at < original.text.length)) {
        if (!lines.length) throw new RangeError('maxBytes cannot fit a detail fragment');
        break;
      }
      lines.push(choice.fragment);
      if (choice.fragment.continued) { at = choice.end; break; }
      cursor++; at = 0;
    }
    this.#check(signal);
    return page(cursor, at);
  }

  close() {
    this.#closed = true; this.#index.clear(); this.#snapshot = undefined;
  }
}
function splitsPair(text, offset) {
  const before = text.charCodeAt(offset - 1), after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}
