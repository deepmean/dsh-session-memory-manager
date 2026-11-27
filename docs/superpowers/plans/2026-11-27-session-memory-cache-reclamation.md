# Session Memory Cache Reclamation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task in the current worktree. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release inactive prepared-session object graphs and idle PTC reader indexes after their final consumer, without changing durable session logs or disrupting active readers.

**Architecture:** Add a lease-aware idle cache owner for both alpha4 presentation and native full Query readers. After the last wrapped lease is disposed, an unref timer removes only the exact unchanged, unpinned entry. Separately, the presentation worker expires idle `DiskHistoryReader` indexes; it retains bounded PTC marker metadata so a later page request can rebuild the index from the original log.

**Tech Stack:** Node.js ESM, DSH `0.2.3-alpha.2`, Cordis, Worker Threads, `node:test`, fake clocks for Query timers and bounded condition polling for worker timers.

**Spec:** `docs/superpowers/specs/2026-11-27-session-memory-cache-reclamation-design.md`

**Execution:** Native implementation in this session, as requested. Implementation starts after review of this plan.

## Global Constraints

- DSH compatibility floor remains `>=0.2.2-rc.5`; unknown cache/reader shapes fail safe and skip eviction.
- Query idle grace: `30,000 ms`; worker source/index idle TTL: `60,000 ms`.
- Never evict an observation entry while any lease is active; never close a worker reader during scan/read.
- Never delete, truncate, rewrite, or externalize session logs; never force GC.
- Preserve PTC marker verification, pagination output, native V4 validation, and full-read fidelity.
- Upgrade the local bundle from `0.1.0-alpha.4` to `0.1.0-alpha.5`; do not modify profile manifests or restart/HMR the current Host.
- Push only the reviewed branch to `private-trial` (`deepmean/dsh-session-memory-manager`); do not use the unrelated `origin` remote.

## Review Focus

1. Final-lease disposal versus nested `retain()` and duplicate disposal; assert no early eviction and exactly one final eviction in Task 1/2.
2. Idle timer racing a new read or a newer persistence revision; assert the old timer cannot delete the replacement entry in Task 1/2.
3. Legacy `reader.inspect()` and modern read-based inspect both dispose leases and eventually evict; test both paths in Task 2.
4. Worker TTL racing an active scan/detail read; test no interruption and eventual source/index cleanup in Task 3.
5. PTC marker paging after worker index expiry; assert exact page content and unchanged source SHA-256 in Task 3.

---

### Task 1: Build the lease-aware observation cache helper

**Files:**
- Create: `lib/idle-observation-cache.js`
- Create: `test/idle-observation-cache.test.js`

**Interfaces:**
- `createIdleObservationCache(reader, options = {})` consumes a DSH-shaped reader with `cache: Map`.
- Options: `{ idleMs = 30_000, setTimer = setTimeout, clearTimer = clearTimeout, onEviction = noop, onIncompatibleShape = noop }`.
- Returns `{ wrap(sessionId, lease), afterInspect(sessionId), metrics(), clear() }`.
- `wrap()` preserves observation properties and wraps `retain()`/`Symbol.dispose`; `metrics()` returns counts only: `{ entries, retainedEvents, activeLeases, pendingEvictions, evictions }`.

- [ ] **Step 1: Write failing helper tests**

Add tests named:

- `evicts an unpinned prepared entry after the idle grace`
- `keeps a cache entry until every retained lease is disposed`
- `a new read cancels the prior idle timer`
- `a stale timer cannot delete a replacement revision`
- `an incompatible entry shape fails safe without deletion`
- `clear cancels timers and leaves borrowed leases usable`

Use a fake clock and a DSH-shaped fixture cache entry with `revision`, `events`, and `refs`. Assert cache identity/size and lease behavior, never process RSS.

- [ ] **Step 2: Run helper tests to verify they fail**

Run: `node --test test/idle-observation-cache.test.js`
Expected: FAIL because the helper module/export is absent.

- [ ] **Step 3: Implement `createIdleObservationCache()`**

Track the exact entry and each wrapped lease. Cancel its timer on a new wrapped lease. On final wrapped dispose, schedule an unref idle timer. The timer rechecks that `reader.cache.get(sessionId)` is the same entry/revision and `entry.refs === 0` before deletion. `afterInspect()` applies the same check after a legacy `inspect()` which disposes internally. Shape mismatch invokes one bounded callback and leaves the entry intact. `clear()` cancels all timers and counters without disposing active lease values.

- [ ] **Step 4: Run helper tests to verify they pass**

Run: `node --test test/idle-observation-cache.test.js`
Expected: all six helper tests pass.

- [ ] **Step 5: Commit helper and tests**

```powershell
git add lib/idle-observation-cache.js test/idle-observation-cache.test.js
git commit -m "feat: add lease-aware idle observation cache"
```

### Task 2: Apply eviction to presentation and full Query paths

**Files:**
- Modify: `lib/consumer-adapters.js`
- Modify: `test/consumer-adapters.test.js`
- Modify: `test/native-consumers.test.js`

**Interfaces:**
- `createQueryClass(Base, options = {})` accepts `{ idleMs, setTimer, clearTimer, onIncompatibleShape }` for deterministic tests; production default is 30,000 ms.
- Each Query instance owns one helper for its cloned presentation reader and one for `this._observations`, the native full reader.
- Add non-Remote `memoryMetrics()` returning aggregate Query cache counts only; no session IDs/event contents.

- [ ] **Step 1: Write failing adapter regression tests**

Add tests proving:

- `observeSession()` keeps the cache entry before TTL and deletes it after the final lease.
- Two concurrent leases and nested `retain()` keep the entry until the final release.
- `inspectSession()` evicts after both the modern read-based path and legacy `reader.inspect()` path.
- `observeFullSession()` retains the native-reader cache while a hydrated lease is open, then evicts after the last retained lease.
- Reopening before expiry cancels the old timer; replacing the revision makes a stale timer harmless.
- Query teardown clears timer queues but a borrowed lease remains readable until disposal.
- A real alpha2 `SqliteSessionQueryEngine` wrapped by `createQueryClass()` accepts an injected fake clock. In `test/native-consumers.test.js`, load the installed `SqliteSessionQueryEngine` through `f.libs.hostImport()`, construct the adapter with fake timers, and assert that after the last presentation/full observation lease is disposed and 30,000 ms elapse both underlying reader caches are empty; reopening must preserve list metadata and full event fidelity.

- [ ] **Step 2: Run `test/consumer-adapters.test.js` and verify the new assertions fail**

Run: `node --test test/consumer-adapters.test.js test/native-consumers.test.js`
Expected: failing cache-retention assertions; existing presentation/full isolation and native list behavior remain intact.

- [ ] **Step 3: Integrate helper into `createQueryClass()`**

Wrap every presentation `observeSession()` lease before returning it. Route the modern inspect fallback through the wrapped lease and call `afterInspect()` for legacy inspect. Wrap the native source lease before `hydratedLease()` so disposal/retain of the full observation reaches the native cache helper too. Clear both helper timer sets during Query fiber teardown. `memoryMetrics()` reports only counts from both helpers.

- [ ] **Step 4: Run focused Query tests**

Run: `node --test test/idle-observation-cache.test.js test/consumer-adapters.test.js test/native-consumers.test.js`
Expected: all helper and adapter cases pass, with no leaked fixture leases; the alpha2 fixture reopens the same persisted session after eviction.

- [ ] **Step 5: Commit Query integration**

```powershell
git add lib/consumer-adapters.js test/consumer-adapters.test.js
git commit -m "fix: evict inactive prepared query sessions"
```

### Task 3: Expire worker source indexes while retaining PTC tokens

**Files:**
- Modify: `lib/presentation-runtime.js`
- Modify: `lib/presentation-worker.js`
- Modify: `test/presentation-runtime.test.js`

**Interfaces:**
- `DiskPresentationController` constructor adds `sourceIdleMs = 60_000` and passes it in `workerData`.
- Worker metrics retain current fields and add `indexEntries` and `sourceEvictions`.

- [ ] **Step 1: Write failing worker expiry regression**

Load a synthetic session and wait until `workerMetrics()` reports one cached reader and nonzero index entries. Configure `sourceIdleMs: 25`; wait with a bounded condition-based helper until `readers === 0` and `indexEntries === 0`. Keep the returned preview marker and request a PTC page after expiry; assert the worker rescans and returns the exact page. Compare source SHA-256 before/after.

- [ ] **Step 2: Run `test/presentation-runtime.test.js` and verify it fails**

Run: `node --test test/presentation-runtime.test.js`
Expected: source reader/index remains cached past the short test TTL.

- [ ] **Step 3: Implement idle source/index expiry**

Track `lastUsedAt` and one unref timer per source. Refresh it on `freshReader()` hits/stores. When the timer fires during an active worker operation, defer it; otherwise close/remove only the exact expired reader and increment `sourceEvictions`. Include sum of cached `summary.indexEntries` in `workerMetrics()`. Preserve `references`/`knownTokens` under the current 50,000 cap so an expired index can be rebuilt for an existing marker. Worker close cancels source timers and clears readers/maps.

- [ ] **Step 4: Run worker tests to verify they pass**

Run: `node --test test/presentation-runtime.test.js`
Expected: idle reader/index counts reach zero, detail page still matches original content, source SHA-256 is unchanged, and active operations finish without interruption.

- [ ] **Step 5: Commit worker expiry**

```powershell
git add lib/presentation-runtime.js lib/presentation-worker.js test/presentation-runtime.test.js
git commit -m "fix: expire idle presentation reader indexes"
```

### Task 4: Release alpha5 integration and documentation

**Files:**
- Modify: `package.json`
- Modify: `scripts/check.mjs`
- Modify: `test/session-memory-bundle.test.js`
- Modify: `README.md`
- Modify: `DEVELOPMENT.md`

- [ ] **Step 1: Add failing alpha5 identity and end-to-end assertions**

Change the existing `alpha4 is a private single bundle with the renamed session controller export` test to `alpha5 is a private single bundle with the renamed session controller export`, and assert `manifest.version === '0.1.0-alpha.5'`. The bundle checker must also reject the current alpha4 identity until the manifest is bumped.

- [ ] **Step 2: Run focused tests and verify the alpha5 assertion fails**

Run: `node --test test/session-memory-bundle.test.js test/native-consumers.test.js`
Expected: failure on alpha4 package identity before the version bump.

- [ ] **Step 3: Bump bundle identity and update user-facing cache semantics**

Set `package.json` and `scripts/check.mjs` to `0.1.0-alpha.5`. Update README/DEVELOPMENT to state that inactive Query/source caches expire after their idle grace, while V8/OS RSS may remain high and cold reopening rescans the unchanged log.

- [ ] **Step 4: Run focused and full validation**

Run the alpha2-focused tests, then:

```powershell
$env:DSH_INSTALL_DIR = '<installed @deepseek-ai/dsh package directory>'
node --test --test-timeout=20000 'test/*.test.js'
node scripts/check.mjs
npm pack --dry-run --offline --ignore-scripts --json
```

Expected: zero test failures; bundle check passes; offline package contains the expected 33 files and no bundled dependencies.

- [ ] **Step 5: Review, commit, and push the alpha5 upgrade**

Run `git diff --check`, verify the private-linked profile points to this worktree, and confirm no profile manifest/session log changes. Commit docs, manifest, tests, and implementation; push only `private-trial feat/session-memory-manager`. Do not restart the current Host; report that a cold restart is required for activation.

## Rollout

The profile is already linked to this worktree, so file changes become the next cold-start code. Do not modify profile files or live Host state. After the user restarts, verify plugin rows are active, cached-entry counters return to zero after the idle grace, PTC pagination still works after source-index expiry, and original session-log hashes are unchanged.
