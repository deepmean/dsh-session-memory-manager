# DSH Session Memory Manager Design

Status: proposed implementation specification. User approved the scope, single-plugin name, passive history opening, five-minute idle cleanup, and GUI configurability. Implementation is not approved until this file is reviewed.

## Problem Evidence

A Web history follow currently sends `activate: true` from the Client transport. The Host follow handler retains the prepared observation and promotes it to an Agent asynchronously. Closing the follow stream releases its observation/listeners, but the AgentLoop still owns the AgentHandle and live Session until that handle is disposed or the Host exits. The API session controller currently returns the Agent from `ctx.agents.resume()` and does not retain the AgentHandle. DSH exposes `AgentHandle.dispose()` as the ownership capability; the public `Agent` itself has no dispose operation.

Relevant installed DSH 0.2.2-rc.5 source:

- `dsh-api-session-controller/src/client/transport.ts`: history follow requests `activate: true`.
- `dsh-api-session-controller/src/web/controller.ts`: promotion retains the observation and starts the Agent activation independently of the follow stream lifetime.
- `dsh-api-session-controller/src/agent.ts`: resume returns only the Agent to callers after the AgentHandle has been reduced to `.agent`.
- `dsh-agent-loop/src/index.ts`: the factory retains each AgentHandle disposer until explicit disposal or provider shutdown.
- `dsh-agent/src/index.ts`: `AgentHandle.dispose()` stops/drains the Agent and removes its live Session; it does not delete the durable session log.

Sampling found Host private bytes around 1.86-1.94 GiB over three minutes, with GC-associated falls. This establishes a large live footprint but does not prove all bytes are session Agents or demonstrate monotonically increasing RSS. Alpha2 worker memory and presentation reads are bounded independently.

## Related Implementations

No directly reusable DSH-compatible library was found. The relevant precedent is lifecycle design, not code import:

- VS Code's merged [agentHost release-idle-sessions PR](https://github.com/microsoft/vscode/pull/324854) releases provider SDK resources as well as state only after the final subscriber leaves, while preserving durable sessions for restore. Its provider/SDK interfaces differ from DSH.
- Mastra's merged [idle/released-session cleanup PR](https://github.com/mastra-ai/mastra/pull/30612) guards active runs, approvals, waits, streams, and open viewers before unloading in-memory state. Its Factory sandbox/session model is not drop-in for DSH.

These projects support reusing the invariants: explicit owner-controlled release, preserve durable history, account for subscribers and in-flight work, and validate restoration. Their implementation code is not imported.

## Options

1. Passive history opening only. This avoids creating new live Agents solely to view history, but does not reclaim Agents already resumed by user actions.
2. Owner-aware idle lifecycle only. This releases controller-owned Agents after the last viewer leaves, but history opens still create a live Agent first.
3. Combine passive opening with owner-aware idle release. This is selected because it prevents both needless activation on browse and retention after later interactive use.

Clearing alpha2's reader cache or calling GC is not an acceptable solution: neither can release the AgentLoop-owned Session graph, and arbitrary forced collection cannot invalidate live references.

## Behavior

- A history follow used to display an existing Session is passive and does not activate/resume an Agent.
- The first actual user operation (send prompt, queue edit that requires an Agent, or another explicit Agent action) continues through DSH's existing resolve/resume path.
- The manager tracks only ordinary Agents for which the session controller holds the exact AgentHandle. It never reclaims configured startup Agents, subagents, externally owned Agents, or Agents without proven ownership.
- A controller-owned Agent becomes an eviction candidate only when no history-follow viewers remain, status is `idle`, and both inbox queues are empty.
- The default idle delay is five minutes. The Plugin Manager GUI can select disabled, 1 minute, 5 minutes, or 15 minutes.
- A new viewer, new user operation, running status, or non-empty inbox cancels the pending eviction and advances a per-session generation token.
- At timeout the manager rechecks handle identity, generation, viewer count, Agent status, inbox, and in-flight controller work. It then calls the exact retained `AgentHandle.dispose()` once. The durable JSONL/Zstandard session artifact is untouched and is used on the next resume.
- Disposal errors are reported as bounded diagnostics; a failure must not delete the Agent's durable history or silently mark its handle released.
- Timers are one-shot, per candidate, and owned by a Cordis effect. There is no polling loop or forced GC.

## Ownership and Integration

This feature belongs at the session-controller/AgentHandle ownership boundary; implementing it only in the PTC worker is insufficient. The single `dsh-session-memory-manager` bundle will include alpha2's existing single-log presentation feature plus a version-checked session-controller lifecycle adapter. The adapter must preserve the existing Remote method surface and authorization behavior, retain the actual handles it creates/resumes, and expose no raw disposal capability to the Client.

History-follow viewer leases must be scoped to the stream's lifetime with `try/finally`, including abort, transport error, and consumer cancellation. Prompt admission and cleanup must serialize per session so a prompt cannot race past an eviction commit. If an API/layout cannot provide that ownership proof, the adapter fails closed and leaves the Agent untouched.

The implementation must not monkeypatch global prototypes or temporarily replace shared service methods. The adapter must verify the installed DSH/session-controller API shape before activation and stop if it differs. No installed DSH files or session logs are modified.

## GUI Configuration

Expose one configuration field in the bundle's normal Plugin Manager configuration UI:

- `idleReclaimMinutes`: enum `0 | 1 | 5 | 15`; default `5`; `0` disables automatic release.
- A label/description states that only controller-owned idle Agents with no viewers and no queued messages are eligible.
- Saving configuration applies through DSH's config editor; no hand-editing of profile YAML and no separate UI-only state store.

## Verification

Automated tests use real isolated DSH Agent/Session/Controller services and fake time where available:

- Opening a cold history follow is passive and creates no Agent.
- First prompt still resumes the Session and commits the message normally.
- Last-viewer close starts the grace period; a second viewer cancels/restarts it.
- An active turn, non-empty inbox, subagent, configured Agent, or foreign handle is never disposed.
- After the full grace period, an eligible controller-owned idle Agent is disposed exactly once and can be losslessly resumed from the unchanged durable log.
- A concurrent prompt and timeout cannot dispose the Agent between admission and enqueue.
- Plugin unload cancels timers and releases only plugin-owned bookkeeping.
- Alpha2's existing full regression suite and actual-Host smoke test pass.

Operational acceptance: view a session without activating an Agent; send a message and confirm normal resume; close the last viewer, allow the configured interval, confirm that the controller-owned Agent is gone but the session still opens from disk; verify active Agents and pending inboxes remain alive.

## Risks and Non-Goals

This changes Web session lifecycle behavior and therefore requires a cold restart. If preserving every existing built-in SessionController behavior requires copying a large internal provider, scope that work as an isolated, generated adapter with explicit structural checks rather than a silent broad fork.

This feature does not promise that OS RSS immediately falls after Agent disposal: V8 may retain released pages. Success is defined by dropping strong references/resources, bounded live Agent count, and lossless reactivation, not forcing memory back to the OS.
