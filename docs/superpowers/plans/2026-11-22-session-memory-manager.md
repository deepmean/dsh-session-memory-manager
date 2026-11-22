# DSH Session Memory Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Combine alpha2 PTC disk-history presentation with passive history reads and safe idle disposal of controller-owned Web Agents.

**Architecture:** Keep one bundle, renamed `@local/dsh-session-memory-manager`. A version-checked runtime adapter over the installed `@deepseek-ai/dsh-api-session-controller` owns history-viewer leases and the exact `AgentHandle`s it creates. It opens old history passively; first real prompt still resumes through the built-in command flow. Once the final viewer closes, a one-shot Cordis-owned timer may dispose only a revalidated idle, empty-inbox, still-controller-owned AgentHandle.

**Tech Stack:** Node.js 27 / ESM, DSH 0.2.2-rc.5 plugin bundles, Cordis effects/services, Typert Remote descriptors, Node worker threads, `node:test`, GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-11-22-session-memory-manager-design.md`

## Global Constraints

- Preserve one original `.jsonl.zstd` per Session; never externalize, truncate, rewrite, or delete source history.
- Keep normal DSH `deriveMessages()` behavior and PTC `tool/result`, arguments, content, event identity unchanged.
- Never reclaim configured-startup Agents, subagents, foreign/unowned handles, running Agents, Agents with inbox entries, or Agents with an active follow viewer.
- Default `idleReclaimMinutes` is 5; accepted values are 0 (disabled), 1, 5, 15.
- Use the exact retained `AgentHandle.dispose()`; never force GC or clear shared `ctx.sessions` state directly.
- All timers and remote viewers are Fiber-owned; disposal cancels timers and drains active callbacks.
- Cold-only provider replacement requires Host restart; no HMR enable/disable during verification.
- Unknown DSH or session-controller structure fails closed before replacing native services.
- Runtime GUI configuration is edited through DSH Plugin Manager/config editor, not direct profile-file rewriting.

## File Map

- `package.json`: rename package/repository to `@local/dsh-session-memory-manager` / the new GitHub repo; bump alpha version, retain DSH peer baseline.
- `cordis.patch.yml`: keep the native `session-controller` row enabled with `inject: [dshSessionMemoryNativeFallback]` so the native browser package and Typert sidecars remain in the Client roster; insert one `session-memory-controller` row that supplies the replacement service and only releases the fallback token after compatibility/init. Disable only the alpha2-replaced persistence/agent-loop/query rows; keep explicit cold-start-only behavior.
- `lib/session-controller-adapter.js`: subclass the installed SessionController; extend its Config; in Cordis `Service.init` create a child Context with a proxy around only the session-controller-owned `agents` service; capture exact handles returned by its `create`/`resume` calls; override `follow` to hold viewer leases and force passive browsing.
- `lib/idle-agent-manager.js`: pure per-session state machine for owner handles, viewer refs, busy/inbox checks, generation tokens, one-shot timers, and disposal results.
- `lib/plugin.js`: preserve the existing owner-only PTC detail route; it does not own Agent lifecycle.
- `locale/zh.json`, `locale/en.json`: bundle configuration labels and safeguards.
- `test/idle-agent-manager.test.js`: deterministic fake-clock state-machine tests.
- `test/session-controller-adapter.test.js`: test public Remote marker parity, cold follow passive behavior, first-prompt restoration, owner provenance, viewer cleanup.
- `test/native-resume.test.js`, `test/native-backend.test.js`: extend actual-isolated-DSH integration coverage for lossless restore/disposal.
- `README.md`, `DEVELOPMENT.md`, `THIRD_PARTY_NOTICES.md`: rename, lifecycle contract, GUI choices, cleanup behavior, limitations, licensing.

## Review Focus

- Viewer disconnect during snapshot, stream abort, thrown transport, or normal `for await` completion releases exactly one viewer lease; no timer is scheduled while any viewer remains. Test each exit path in `session-controller-adapter.test.js`.
- A 5-minute expiry racing a prompt, queue edit, follow reopen, status transition to running, or inbox append must cancel by generation and recheck immediately before dispose. Test stale timer callback cannot dispose a new generation.
- User prompt after passive open must resume the same durable Session once, commit exactly one user message, and preserve retries/idempotence. Test in native integration.
- Agent ownership conflicts, preset-configured startup agents, subagents, and foreign Agent handles are never tracked or disposed. Test provenance cases.
- Timer cancellation/plugin unload and disposal rejection leave source log intact and manager state recoverable. Test teardown and subsequent resume.

---

### Task 1: Idle Agent Manager State Machine

**Files:**
- Create: `lib/idle-agent-manager.js`
- Create: `test/idle-agent-manager.test.js`

**Interfaces:**
- Produces `createIdleAgentManager({ idleMs, setTimer, clearTimer, isCurrent, onError })` with `track({ sessionId, agent, handle, provenance })`, `viewerOpened(sessionId) -> release`, `viewerClosed(sessionId)`, `beginActivity(sessionId) -> release`, `noteActivity(sessionId)`, `statusChanged(agent)`, `inboxChanged(agent)`, `forget({ sessionId, agent })`, `isEvicting(sessionId)`, `waitUntilAvailable(sessionId)`, `setIdleMs(ms)`, and awaitable `dispose()`.
- A tracked record contains exact AgentHandle identity, viewer count, monotonic generation, one timer, and one pending eviction promise. Untracked session ids still retain a viewer count while one or more follow leases exist; `track()` inherits that count. The manager never discovers Agents by enumerating `ctx.agents` and never calls `Agent.dispose()`.

- [ ] **Step 1: Write failing tests** named `does not schedule while a viewer is attached`, `viewer opened before track is inherited by the tracked Agent`, `releases once after last viewer and full idle grace`, `never releases running or nonempty inbox agent`, `cancels stale timeout after prompt or viewer reopen`, `rearms after activity invalidates an in-flight timer callback`, `ignores unowned configured agents and subagents`, `dispose cancels all timers`.
- [ ] **Step 2: Run red tests** with `node --test test/idle-agent-manager.test.js`; expected failures are missing manager behavior.
- [ ] **Step 3: Implement manager** using injected clock functions, `agent.status === 'idle'`, both `agent.inbox.nextTurn` and `nextStep` empty, exact handle identity, and a final generation/viewer/ownership recheck. `idleMs === 0` disables scheduling.
- [ ] **Step 4: Run focused tests**; expected all manager cases pass, including disposal rejecting without losing retryability.

### Task 2: Version-Checked Controller Adapter and Passive Follow

**Files:**
- Modify: `lib/session-controller-adapter.js`, `test/session-controller-adapter.test.js`

**Interfaces:**
- `createSessionControllerAdapter(Base, cordis)` returns a subclass. Installed decorators define Remote metadata on the concrete instance prototype during `super()`; verify the exact 25 markers there without mutating `Base.prototype` or introducing new Remote methods.
- `static Config` clones `Base.Config` (`new Schemastery(Base.Config.toJSON())`) before adding a volatile `idleReclaimMinutes` enum with default 5. Never call `.set()` on the shared upstream schema; it mutates in place.
- The subclass constructor calls `super(ctx, config, internals)` unchanged and stores `config.idleReclaimMinutes`. Its override of `[cordis.Service.init]()` creates the manager and a child `ctx.extend({agents: proxy})`, temporarily sets the inherited `ctx` to that child while invoking `super[cordis.Service.init]()`, and restores the original service context in `finally` after upstream initialization has captured its dependent controllers.
- The scoped AgentRegistry proxy wraps `create`/`resume` results only long enough to give the exact original handle to `manager.track`; it returns the original handle unchanged. `get` returns undefined while the same id is being evicted, otherwise it calls `noteActivity` for already tracked Agents. `resume` awaits `manager.waitUntilAvailable(id)` before invoking the original method. Other service methods and receivers are forwarded unchanged. Agents with `header.origin === 'subagent'` are rejected by the manager.
- `follow(request, signal)` opens a viewer lease before waiting for an in-flight eviction, races that wait against signal abort, and releases in `finally`; it delegates to `super.follow({...request, activate:false}, signal)`, preserving frames without activating an Agent just to browse history.
- Agent-mutating commands acquire activity leases around complete async calls (synchronous `cancel` holds one only for its sync call). Native status/inbox listeners invalidate timers. The per-instance native `ApiSessionAgentController.resolveAgent` wrapper holds a lease while resolving and forgets the exact Agent after an external borrow; controller work marked by the private AsyncLocalStorage owner remains tracked.
- Cordis cleanup and lifecycle listeners are registered before `super[cordis.Service.init]()` so an upstream initialization failure still drains the manager. On plugin teardown, the manager cancels timers and awaits any committed exact-handle disposal.
- The Web `session-controller` Loader entry stays enabled, waiting on the fallback gate so its browser entry and Typert sidecar remain available. The single distinct `session-memory-controller` entry owns the replacement. If initialization fails, wait for the partial child to dispose before releasing the gate. This is a cold-start switch, not a hot-swap protocol.
- The adapter verifies the installed class constructor, all Remote method markers, dependency keys and config schema against the current DSH before mounting. Any missing/extra required shape prevents activation.

- [ ] **Step 1: Write failing adapter tests** for Remote marker parity, upstream Config fields plus idle enum/default, child-context proxy capturing exact create/resume handles, passive follow with unchanged frames, viewer lease release, and resume waiting for eviction.
- [ ] **Step 2: Run red** with `node --test test/session-controller-adapter.test.js`; assert failures are behavior assertions, not import/fixture errors.
- [ ] **Step 3: Implement the subclass adapter** using the Cordis `Service.init` symbol and a scoped child context; do not copy the upstream controller bundle or mutate its prototype.
- [ ] **Step 4: Verify adapter integration** in an isolated Cordis tree: Remote descriptors/config match, upstream Service.init completes with the managed child context, and only one `sessionController` provider exists.

### Task 3: Session Controller Agent Ownership and Idle Integration

**Files:**
- Modify: `lib/session-controller-adapter.js`
- Modify: `lib/idle-agent-manager.js`
- Modify: `test/session-controller-adapter.test.js`, `test/idle-agent-manager.test.js`, `test/native-resume.test.js`

**Interfaces:**
- Controller config: `idleReclaimMinutes: 0 | 1 | 5 | 15`, default 5.
- `createIdleAgentManager({idleMs, setTimer, clearTimer, isCurrent, onError})` exposes `track({sessionId, handle, agent, provenance})`, `viewerOpened(sessionId) -> release`, `viewerClosed(sessionId)`, `beginActivity(sessionId) -> release`, `noteActivity(sessionId)`, `statusChanged(agent)`, `inboxChanged(agent)`, `forget({sessionId, agent})`, `isEvicting(sessionId)`, `waitUntilAvailable(sessionId)`, `setIdleMs(ms)`, and awaitable `dispose()`.
- Only the session-controller child context's AgentRegistry `create`/`resume` proxy registers handles; this is the ownership proof. Configured AgentLoop and subagent contexts are not proxied. A `get(sessionId)` for a tracked Agent invalidates its timer; while its exact handle is disposing it returns `undefined`, and a subsequent `resume` waits for disposal to settle.

- [ ] **Step 1: Add failing race tests** for final viewer leaving, reopen before timeout, prompt admission at timeout, busy status, nonempty inbox, subagent ownership, and controller unload.
- [ ] **Step 2: Run red** on those named tests and verify the current adapter leaks the passive-resumed handle / lacks timeout cleanup.
- [ ] **Step 3: Implement ownership transitions**: `cold -> viewed-passive -> user-resumed-owned -> idle-pending -> disposed`; cancel timer on every new viewer/activity, and recheck all guards inside the timer callback before calling the exact handle disposer.
- [ ] **Step 4: Test preservation** by reopening the disposed Session from native JSONL and comparing its `deriveMessages()` to the pre-disposal baseline; assert original artifact SHA/size unchanged.
- [ ] **Step 5: Run focused integration tests** for controller plus native AgentLoop, with no model API call.

### Task 4: Plugin Configuration GUI and Bundle Rename

**Files:**
- Modify: `cordis.patch.yml` to keep native `session-controller` enabled behind `dshSessionMemoryNativeFallback`, insert `session-memory-controller`, and disable only the alpha2-replaced persistence/AgentLoop/query rows; preserve native Client and Typert sidecars.
- Create: `lib/session-controller-plugin.js` for the version-gated child adapter and native fallback rollback.
- Delete: obsolete alpha1/lazy-viewer runtime, panel, tests, design note and publish workflow; retain upstream provenance in `THIRD_PARTY_NOTICES.md` and `LICENSE`.

- Modify: `lib/plugin.js`, `lib/persistence-plugin.js`, `README.md`, `DEVELOPMENT.md`, `THIRD_PARTY_NOTICES.md`
- Test: `test/native-loader.test.js`, `test/client.test.js`, `scripts/check.mjs`

**Interfaces:**
- New package name: `@local/dsh-session-memory-manager`; all loader/client IDs and route namespaces use this name.
- `Config` exposes `idleReclaimMinutes`; localized UI labels include the safe eligibility rules. GUI choices are 0/1/5/15 minutes, default 5.
- Config writes use the DSH Plugin Manager bundle configuration editor; no direct manifest editing is added.

- [ ] **Step 1: Write failing config/UI tests** for default 5, valid 0/1/5/15, invalid values, and locale text accurately describing owner-only idle cleanup.
- [ ] **Step 2: Run red** with the relevant test files.
- [ ] **Step 3: Rename exports and bundle rows** and wire the session-controller adapter as one bundle capability; preserve PTC detail pagination.
- [ ] **Step 4: Verify** the bundle manifest, exports, local client registration ID, no stale alpha2 package IDs, and localized config metadata.

### Task 5: Full Verification and Private Trial Readiness

**Files:**
- Modify: `README.md`, `DEVELOPMENT.md`
- Test: all `test/*.test.js`, `scripts/check.mjs`

- [ ] **Step 1: Run full tests** with `$env:DSH_INSTALL_DIR='C:\softwares\node-arm64\node_modules\@deepseek-ai\dsh'; node --test 'test/*.test.js'; node scripts/check.mjs`; expected all pass.
- [ ] **Step 2: Run isolated real-log cold scan** on a stopped stable source with worker limit 192 MiB and 1 GiB diagnostic main heap; record SHA-256 and length before/after; no source mutation permitted.
- [ ] **Step 3: Check package manifest and plugin-manager config metadata**; verify no install lifecycle scripts, no unrelated profile state edits, and no legacy bundle remains.
- [ ] **Step 4: Update docs** with measured scope and memory caveat; do not claim RSS immediately falls after Agent disposal.
- [ ] **Step 5: Commit task** with message `feat: add safe idle session reclamation`.

### Task 6: Cold-Start Host Acceptance

**Files:**
- No user session files may be edited or migrated.

- [ ] **Step 1: Confirm all DSH Hosts are stopped** before replacing session/persistence providers; never HMR-switch this bundle.
- [ ] **Step 2: Install/select the renamed private bundle** using Plugin Manager while startup-only/no-HMR state is in effect; confirm manager returns `restart-required` if applicable.
- [ ] **Step 3: Start a fresh Host**; verify session-controller adapter, persistence, AgentLoop, query, tool and Client rows are all active.
- [ ] **Step 4: Open a stable existing history**; confirm no Agent resumes until a user action.
- [ ] **Step 5: Send a user message**; confirm same Session resumes and logs one prompt.
- [ ] **Step 6: Close the last viewer; before configured grace, confirm Agent remains. After grace, confirm exact owned handle disposed, Session absent from live registry and durable log unchanged.
- [ ] **Step 7: Confirm active/busy/inbox-nonempty/subagent/configured Agents are not reclaimed; reopen the Session and verify lossless recovery.
- [ ] **Step 8: Collect one current memory sample**; report live-Agent counts, RSS/private bytes, and GC caveat without promising immediate OS memory return.
