const OWNED_PROVENANCE = 'owned';
const noop = () => {};

// isCurrent is a synchronous, side-effect-free predicate, used at scheduling and commit.
export function createIdleAgentManager({idleMs, setTimer, clearTimer, isCurrent, onError = noop}) {
 const records = new Map();
 const pendingEvictions = new Map();
 const viewers = new Map();
 const activities = new Map();
 const disposedHandles = new WeakSet();
 let disposed = false;
 let teardown;

 function report(error) {
  try { Promise.resolve(onError(error)).catch(noop); } catch {}
 }

 function invalidate(record) {
  record.generation++;
  const timer = record.timer;
  record.timer = undefined;
  if (timer !== undefined) clearTimer(timer);
 }

 function canSchedule(record, generation) {
  const {sessionId} = record;
  return !disposed && Number.isFinite(idleMs) && idleMs > 0 && !record.forgotten &&
   records.get(sessionId) === record && record.generation === generation &&
   !viewers.has(sessionId) && !activities.has(sessionId);
 }

 function eligibleDispose(record) {
  const {sessionId, agent, handle, owned} = record;
  if (!owned || disposedHandles.has(handle)) return;
  let error;
  try {
   if (agent.status !== 'idle' || agent.inbox?.nextTurn?.length !== 0 ||
       agent.inbox?.nextStep?.length !== 0 || handle.agent !== agent) return;
   const dispose = handle.dispose;
   if (typeof dispose !== 'function') return;
   const proof = isCurrent?.({sessionId, agent, handle});
   if (proof === true) return dispose;
   if (proof === false) return;
   // A mistaken async callback is not proof; also observe a possible rejection.
   Promise.resolve(proof).catch(noop);
   error = new Error('Idle eviction requires synchronous native eligibility proof');
  } catch (failure) {
   error = failure;
  }
  if (!record.proofReported) {
   record.proofReported = true;
   report(error);
  }
 }

 function arm(record) {
  const {sessionId, generation} = record;
  if (pendingEvictions.has(sessionId) || !canSchedule(record, generation) ||
      !eligibleDispose(record) || !canSchedule(record, generation)) return;
  record.timer = setTimer(() => {
   if (!canSchedule(record, generation) || record.timer === undefined) return;
   record.timer = undefined;
   evict(record, generation);
  }, idleMs);
 }

 function evict(record, generation) {
  const {sessionId, handle} = record;
  let succeeded = false;
  const pending = Promise.resolve().then(async () => {
   if (!canSchedule(record, generation)) return;
   const dispose = eligibleDispose(record);
   if (!dispose || !canSchedule(record, generation)) return;
   // Commit synchronously after the final checks; only completion is awaited.
   await dispose.call(handle);
   disposedHandles.add(handle);
   succeeded = true;
  }).catch(error => {
   report(error);
   throw error;
  }).finally(() => {
   pendingEvictions.delete(sessionId);
   if (disposed) return;
   if (succeeded || record.forgotten) {
    const replacement = record.replacement;
    if (replacement) {
     records.set(sessionId, replacement);
     arm(replacement);
    } else records.delete(sessionId);
   } else if (record.generation !== generation) arm(record);
  });
  pendingEvictions.set(sessionId, pending);
  pending.catch(noop);
 }

 function refresh(record) {
  if (!record) return;
  invalidate(record);
  arm(record);
 }

 function lookupByAgent(agent) {
  for (const record of records.values()) if (record.agent === agent) return record;
 }

 function releaseLease(leases, sessionId, token) {
  const tokens = leases.get(sessionId);
  if (!tokens?.delete(token) || tokens.size) return;
  leases.delete(sessionId);
  refresh(records.get(sessionId));
 }

 function holdLease(leases, sessionId) {
  if (disposed || !sessionId) return noop;
  let tokens = leases.get(sessionId);
  if (!tokens) leases.set(sessionId, tokens = new Set());
  const token = Symbol();
  tokens.add(token);
  const record = records.get(sessionId);
  if (record) invalidate(record);
  return () => releaseLease(leases, sessionId, token);
 }

 return {
  track({sessionId, agent, handle, provenance}) {
   if (disposed || !sessionId || !agent || !handle || disposedHandles.has(handle)) return false;
   const existing = records.get(sessionId);
   if (existing) {
    if (existing.agent === agent && existing.handle === handle) return !existing.forgotten;
    if (existing.replacement) return existing.replacement.agent === agent && existing.replacement.handle === handle;
    if (!pendingEvictions.has(sessionId)) return false;
   }
   for (const record of records.values()) {
    if (record.agent === agent || record.handle === handle ||
        record.replacement?.agent === agent || record.replacement?.handle === handle) return false;
   }
   const owned = provenance === OWNED_PROVENANCE && handle.agent === agent && typeof handle.dispose === 'function';
   const record = {sessionId, agent, handle, owned, generation: 0};
   if (existing) existing.replacement = record;
   else records.set(sessionId, record);
   return true;
  },
  forget({sessionId, agent}) {
   const record = records.get(sessionId);
   if (!record) return false;
   if (record.replacement && record.replacement.agent === agent) {
    record.replacement = undefined;
    return true;
   }
   if (record.agent !== agent || record.forgotten) return false;
   record.forgotten = true;
   invalidate(record);
   // Keep the old record until its attempt settles so a queued replacement can take over.
   if (!pendingEvictions.has(sessionId)) records.delete(sessionId);
   return true;
  },
  beginActivity(sessionId) { return holdLease(activities, sessionId); },
  viewerOpened(sessionId) { return holdLease(viewers, sessionId); },
  viewerClosed(sessionId) {
   const tokens = viewers.get(sessionId);
   if (tokens) releaseLease(viewers, sessionId, tokens.values().next().value);
  },
  noteActivity(sessionId) { refresh(records.get(sessionId)); },
  statusChanged(agent) { refresh(lookupByAgent(agent)); },
  inboxChanged(agent) { refresh(lookupByAgent(agent)); },
  isEvicting(sessionId) { return pendingEvictions.has(sessionId); },
  // Await or catch: a failed eviction rejects the pending promise returned here.
  waitUntilAvailable(sessionId) { return pendingEvictions.get(sessionId) ?? Promise.resolve(); },
  setIdleMs(ms) {
   if (disposed || idleMs === ms) return;
   idleMs = ms;
   for (const record of records.values()) refresh(record);
  },
  dispose() {
   if (teardown) return teardown;
   disposed = true;
   for (const record of records.values()) {
    invalidate(record);
    record.replacement = undefined;
   }
   records.clear();
   viewers.clear();
   activities.clear();
   teardown = Promise.allSettled(pendingEvictions.values()).then(noop);
   return teardown;
  }
 };
}
