# Task 1 Report: Idle Agent Manager State Machine

## Outcome

Implemented `lib/idle-agent-manager.js` as a pure per-session idle Agent manager with injected timer functions. Added deterministic Node tests in `test/idle-agent-manager.test.js`. No DSH profile, real session files, persistence, garbage collection, or `ctx.agents` enumeration was accessed. No Agent object is disposed directly; eligible eviction calls only the exact tracked AgentHandle's `dispose()` method.

## Behavior

- Tracks exact Agent and AgentHandle identities, ownership provenance, viewer count, generation, one timer, and one pending eviction promise per session.
- Viewer leases are recorded independently of Agent records. A passive viewer opened before the first `track()` is inherited; its last release starts one full idle grace interval.
- `viewerClosed()` updates the same independently maintained count and arms the grace interval after the last counted close.
- Configured and subagent provenance is excluded. Controller ownership additionally requires `handle.agent === agent` and a callable `handle.dispose`.
- Scheduling and final eviction both check idle status, both empty inbox arrays, zero viewers, record/Agent/handle identity, generation, and ownership.
- Activity, status/inbox changes, viewer reopen, and manager disposal invalidate/cancel stale timers. If activity invalidates an in-flight timer callback before disposal starts, completion clears the old pending marker and re-evaluates eligibility to re-arm the grace timer.
- Canceled timer callbacks cannot clear the handle for a newer timer.
- `idleMs === 0` disables scheduling. A rejected handle disposal is reported through `onError`, remains observable through `waitUntilAvailable()`, and preserves the tracked record for a later retry.

## Test-First Evidence

The initial specified test file failed before implementation with `ERR_MODULE_NOT_FOUND` for `lib/idle-agent-manager.js`, as expected for the missing manager.

For the two reported lifecycle boundaries, the new tests were run before their fixes and failed for the expected behavior:

- `viewer opened before track is inherited by the tracked Agent`: failed because no timer was armed after the lease released; untracked opens had been discarded.
- `rearms after activity invalidates an in-flight timer callback`: failed because `finally` cleared the stale pending promise without scheduling a fresh timer.

A self-review identified a related stale-callback bug: a canceled callback could clear a newer timer's record reference. An assertion was added first and failed because the newer timer remained uncanceled after viewer reopen; storing and checking each callback's timer identity fixed it.

## Verification

- `node --test test/idle-agent-manager.test.js`: 10 passed, 0 failed.
- `npm test`: 102 passed, 0 failed.
- `npm run check`: passed (`runtime syntax, explicit exports, API baseline, locale metadata and self-contained SVG`).

## Scope and Concerns

Changes are limited to the manager implementation, its focused test file, and this report. The worktree had unrelated pre-existing modifications and untracked files; they were not modified or included in the Task 1 commit. No known Task 1 concerns remain.

## Commit

The implementation, tests, and this report are included together in the Task 1 commit.
