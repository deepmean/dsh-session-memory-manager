const OWNED_PROVENANCE = 'owned';

export function createIdleAgentManager({idleMs, setTimer, clearTimer, onError = () => {}}) {
 const records = new Map();
 const viewerCounts = new Map();
 let disposed = false;

 function cancelTimer(record) {
  if (record.timer !== undefined) {
   clearTimer(record.timer);
   record.timer = undefined;
  }
 }

 function eligible(record) {
  return !disposed && record.owned && record.viewers === 0 &&
   record.agent.status === 'idle' &&
   record.agent.inbox?.nextTurn?.length === 0 &&
   record.agent.inbox?.nextStep?.length === 0 &&
   record.handle.agent === record.agent &&
   typeof record.handle.dispose === 'function';
 }

 function arm(record) {
  cancelTimer(record);
  if (disposed || idleMs === 0 || !eligible(record) || record.pending) return;
  const generation = ++record.generation;
  const agent = record.agent;
  const handle = record.handle;
  let timerId;
  timerId = setTimer(() => {
   if (record.timer === timerId) record.timer = undefined;
   if (records.get(record.sessionId) !== record || record.generation !== generation ||
       record.agent !== agent || record.handle !== handle || !eligible(record)) return;
   const pending = Promise.resolve().then(() => {
    if (records.get(record.sessionId) !== record || record.generation !== generation ||
        record.agent !== agent || record.handle !== handle || !eligible(record)) return;
    return handle.dispose();
   }).then(() => {
    if (records.get(record.sessionId) === record && record.generation === generation) {
     records.delete(record.sessionId);
    }
   }).catch(error => {
    try { onError(error); } catch {}
    throw error;
   }).finally(() => {
    if (record.pending === pending) {
     record.pending = undefined;
     if (records.get(record.sessionId) === record && record.generation !== generation) arm(record);
    }
   });
   record.pending = pending;
   pending.catch(() => {});
  }, idleMs);
  record.timer = timerId;
 }

 function lookupByAgent(agent) {
  for (const record of records.values()) if (record.agent === agent) return record;
  return undefined;
 }

 return {
  track({sessionId, agent, handle, provenance}) {
   if (disposed || !sessionId || !agent || !handle) return false;
   const existing = records.get(sessionId);
   if (existing && existing.agent === agent && existing.handle === handle) return true;
   if (existing) cancelTimer(existing);
   const record = {
    sessionId, agent, handle,
    owned: provenance === OWNED_PROVENANCE && handle.agent === agent && typeof handle.dispose === 'function',
    viewers: viewerCounts.get(sessionId) ?? 0,
    generation: (existing?.generation ?? 0) + 1,
    timer: undefined, pending: undefined
   };
   records.set(sessionId, record);
   return true;
  },
  viewerOpened(sessionId) {
   const viewers = (viewerCounts.get(sessionId) ?? 0) + 1;
   viewerCounts.set(sessionId, viewers);
   const record = records.get(sessionId);
   if (record) {
    record.viewers = viewers;
    record.generation++;
    cancelTimer(record);
   }
   let released = false;
   return () => {
    if (released) return;
    released = true;
    const remaining = Math.max(0, (viewerCounts.get(sessionId) ?? 0) - 1);
    if (remaining === 0) viewerCounts.delete(sessionId);
    else viewerCounts.set(sessionId, remaining);
    const current = records.get(sessionId);
    if (!current) return;
    current.viewers = remaining;
    current.generation++;
    if (remaining === 0) arm(current);
   };
  },
  viewerClosed(sessionId) {
   const remaining = Math.max(0, (viewerCounts.get(sessionId) ?? 0) - 1);
   if (remaining === 0) viewerCounts.delete(sessionId);
   else viewerCounts.set(sessionId, remaining);
   const record = records.get(sessionId);
   if (!record) return;
   record.viewers = remaining;
   record.generation++;
   if (remaining === 0) arm(record);
  },
  noteActivity(sessionId) {
   const record = records.get(sessionId);
   if (!record) return;
   record.generation++;
   cancelTimer(record);
   arm(record);
  },
  statusChanged(agent) {
   const record = lookupByAgent(agent);
   if (!record) return;
   record.generation++;
   cancelTimer(record);
   arm(record);
  },
  inboxChanged(agent) {
   const record = lookupByAgent(agent);
   if (!record) return;
   record.generation++;
   cancelTimer(record);
   arm(record);
  },
  isEvicting(sessionId) { return Boolean(records.get(sessionId)?.pending); },
  waitUntilAvailable(sessionId) { return records.get(sessionId)?.pending ?? Promise.resolve(); },
  dispose() {
   disposed = true;
   for (const record of records.values()) {
    record.generation++;
    cancelTimer(record);
   }
   records.clear();
   viewerCounts.clear();
  }
 };
}
