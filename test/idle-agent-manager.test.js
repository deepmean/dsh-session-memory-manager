import test from 'node:test';
import assert from 'node:assert/strict';
import {createIdleAgentManager} from '../lib/idle-agent-manager.js';

function fixture({idleMs=10,status='idle',nextTurn=[],nextStep=[],isCurrent=()=>true}={}){
 const timers=new Map();const allTimers=new Map();let nextTimer=0;let now=0;const disposed=[];const errors=[];
 const agent={status,inbox:{get nextTurn(){return nextTurn;},get nextStep(){return nextStep;}}};
 const handle={agent,dispose(){disposed.push(this);}};
 const manager=createIdleAgentManager({idleMs,isCurrent,onError:error=>errors.push(error),setTimer(callback,delay){const id=++nextTimer;const timer={callback,delay,due:now+delay};timers.set(id,timer);allTimers.set(id,timer);return id;},clearTimer(id){timers.delete(id);}});
 const fire=(until=Infinity)=>{for(const [id,timer] of [...timers])if(timer.due<=until&&timers.delete(id))timer.callback();};
 const advance=ms=>{now+=ms;fire(now);};
 return {agent,handle,manager,timers,allTimers,disposed,errors,fire,advance};
}

test('does not schedule while a viewer is attached',()=>{
 const f=fixture();f.manager.track({sessionId:'s',agent:f.agent,handle:f.handle,provenance:'owned'});
 const release=f.manager.viewerOpened('s');f.manager.noteActivity('s');
 assert.equal(f.timers.size,0);assert.equal(f.manager.isEvicting('s'),false);release();
});

test('releases once after last viewer and full idle grace',async()=>{
 const f=fixture();f.manager.track({sessionId:'s',agent:f.agent,handle:f.handle,provenance:'owned'});
 const release=f.manager.viewerOpened('s');
 assert.equal(f.timers.size,0);release();assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].delay,10);
 f.fire();await f.manager.waitUntilAvailable('s');assert.deepEqual(f.disposed,[f.handle]);
});

test('never releases running or nonempty inbox agent',async()=>{
 for(const state of [{status:'running'},{nextTurn:[{}]},{nextStep:[{}]}]){
  const f=fixture({...state});f.manager.track({sessionId:'s',agent:f.agent,handle:f.handle,provenance:'owned'});
  f.manager.noteActivity('s');f.fire();await f.manager.waitUntilAvailable('s');assert.deepEqual(f.disposed,[]);
 }
});

test('cancels stale timeout after prompt or viewer reopen',async()=>{
 const f=fixture();f.manager.track({sessionId:'s',agent:f.agent,handle:f.handle,provenance:'owned'});f.manager.noteActivity('s');
 const stale=[...f.timers.keys()][0];f.manager.noteActivity('s');f.allTimers.get(stale).callback();
 assert.deepEqual(f.disposed,[]);assert.equal(f.timers.size,1);
 const release=f.manager.viewerOpened('s');assert.equal(f.timers.size,0);f.fire();assert.deepEqual(f.disposed,[]);release();
});

test('ignores unowned configured agents and subagents',()=>{
 for(const provenance of ['configured','subagent']){
  const f=fixture();f.manager.track({sessionId:'s',agent:f.agent,handle:f.handle,provenance});
  f.manager.noteActivity('s');assert.equal(f.timers.size,0);f.fire();assert.deepEqual(f.disposed,[]);
 }
});

test('viewer opened before track is inherited by the tracked Agent',()=>{
 const f=fixture();const release=f.manager.viewerOpened('s');
 f.manager.track({sessionId:'s',agent:f.agent,handle:f.handle,provenance:'owned'});
 assert.equal(f.timers.size,0);release();
 assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].delay,10);
});

test('rearms after activity invalidates an in-flight timer callback',async()=>{
 const f=fixture();f.manager.track({sessionId:'s',agent:f.agent,handle:f.handle,provenance:'owned'});f.manager.noteActivity('s');
 f.fire();const oldEviction=f.manager.waitUntilAvailable('s');f.manager.noteActivity('s');
 await oldEviction;
 assert.equal(f.timers.size,1);
 f.fire();await f.manager.waitUntilAvailable('s');assert.deepEqual(f.disposed,[f.handle]);
});

test('track replacement waits for old handle disposal before switching records',async()=>{
 const f=fixture();let finishOldDispose;let oldDisposeCalls=0;let newDisposeCalls=0;
 const oldHandle={agent:f.agent,dispose(){oldDisposeCalls++;return new Promise(resolve=>{finishOldDispose=resolve;});}};
 const replacementAgent={status:'idle',inbox:{nextTurn:[],nextStep:[]}};
 const replacementHandle={agent:replacementAgent,dispose(){newDisposeCalls++;}};
 f.manager.track({sessionId:'s',agent:f.agent,handle:oldHandle,provenance:'owned'});
 f.manager.noteActivity('s');f.fire();
 assert.equal(f.manager.isEvicting('s'),true);
 const oldEviction=f.manager.waitUntilAvailable('s');let settled=false;oldEviction.then(()=>{settled=true;});
 f.manager.track({sessionId:'s',agent:replacementAgent,handle:replacementHandle,provenance:'owned'});
 assert.equal(f.manager.isEvicting('s'),true);assert.equal(settled,false);
 await Promise.resolve();assert.equal(oldDisposeCalls,1);assert.equal(settled,false);
 finishOldDispose();await oldEviction;assert.equal(settled,true);
 f.manager.noteActivity('s');assert.equal(f.timers.size,1);
 f.fire();await f.manager.waitUntilAvailable('s');
 assert.equal(oldDisposeCalls,1);assert.equal(newDisposeCalls,1);
});
test('failed handle disposal stays observable and retryable',async()=>{
 const f=fixture();let attempts=0;const failure=new Error('controller refused disposal');
 f.handle.dispose=()=>{attempts++;if(attempts===1)throw failure;f.disposed.push(f.handle);};
 f.manager.track({sessionId:'s',agent:f.agent,handle:f.handle,provenance:'owned'});f.manager.noteActivity('s');f.fire();
 await assert.rejects(f.manager.waitUntilAvailable('s'),failure);
 assert.deepEqual(f.errors,[failure]);assert.equal(f.manager.isEvicting('s'),false);
 f.manager.noteActivity('s');f.fire();await f.manager.waitUntilAvailable('s');assert.equal(attempts,2);
});

test('viewerClosed arms grace after the last counted viewer closes',()=>{
 const f=fixture();f.manager.track({sessionId:'s',agent:f.agent,handle:f.handle,provenance:'owned'});
 f.manager.viewerOpened('s');f.manager.viewerClosed('s');
 assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].delay,10);
});

test('dispose cancels all timers',async()=>{
 const f=fixture();f.manager.track({sessionId:'s',agent:f.agent,handle:f.handle,provenance:'owned'});f.manager.noteActivity('s');
 f.manager.dispose();assert.equal(f.timers.size,0);f.fire();await f.manager.waitUntilAvailable('s');assert.deepEqual(f.disposed,[]);
});

function trackOwned(f, sessionId = 's') {
 return f.manager.track({sessionId, agent:f.agent, handle:f.handle, provenance:'owned'});
}

test('overlapping activity leases protect a slow prompt starting before track', async () => {
 const f = fixture();
 assert.equal(typeof f.manager.beginActivity, 'function');
 const finishPrompt = f.manager.beginActivity('s');
 await f.manager.waitUntilAvailable('s');
 trackOwned(f);
 const finishOther = f.manager.beginActivity('s');
 f.advance(30);
 f.manager.statusChanged(f.agent);
 assert.equal(f.timers.size, 0);
 finishOther();
 finishOther();
 assert.equal(f.timers.size, 0);
 assert.deepEqual(f.disposed, []);
 finishPrompt();
 f.advance(9);
 assert.deepEqual(f.disposed, []);
 f.advance(1);
 await f.manager.waitUntilAvailable('s');
 assert.deepEqual(f.disposed, [f.handle]);
});

test('a handle not bound to its agent at track cannot gain ownership later', async () => {
 const f = fixture();
 f.handle.agent = {};
 trackOwned(f);
 f.handle.agent = f.agent;
 f.manager.noteActivity('s');
 f.fire();
 await f.manager.waitUntilAvailable('s');
 assert.deepEqual(f.disposed, []);
});

test('activity acquired before the commit invalidates the old eviction', async () => {
 const f = fixture();
 assert.equal(typeof f.manager.beginActivity, 'function');
 trackOwned(f);
 f.manager.noteActivity('s');
 f.fire();
 const release = f.manager.beginActivity('s');
 await f.manager.waitUntilAvailable('s');
 assert.deepEqual(f.disposed, []);
 assert.equal(f.timers.size, 0);
 release();
 assert.deepEqual([...f.timers.values()].map(timer => timer.delay), [10]);
});

test('live idle delay cancels stale timers at zero and starts fresh grace when enabled', async () => {
 const f = fixture();
 assert.equal(typeof f.manager.setIdleMs, 'function');
 trackOwned(f);
 f.manager.noteActivity('s');
 const first = [...f.timers.values()][0];
 f.manager.setIdleMs(0);
 f.manager.noteActivity('s');
 first.callback();
 assert.equal(f.timers.size, 0);
 assert.deepEqual(f.disposed, []);
 f.manager.setIdleMs(20);
 assert.deepEqual([...f.timers.values()].map(timer => timer.delay), [20]);
 const second = [...f.timers.values()][0];
 f.manager.setIdleMs(30);
 second.callback();
 assert.deepEqual([...f.timers.values()].map(timer => timer.delay), [30]);
 f.fire();
 await f.manager.waitUntilAvailable('s');
 assert.deepEqual(f.disposed, [f.handle]);
});

test('turning the idle delay off before committing cancels a pending attempt', async () => {
 const f = fixture();
 assert.equal(typeof f.manager.setIdleMs, 'function');
 trackOwned(f);
 f.manager.noteActivity('s');
 f.fire();
 f.manager.setIdleMs(0);
 await f.manager.waitUntilAvailable('s');
 assert.deepEqual(f.disposed, []);
 assert.equal(f.timers.size, 0);
});

test('missing or non-boolean native proof never permits eviction', async () => {
 for (const isCurrent of [null, () => undefined, () => 1, () => Promise.resolve(true), () => Promise.reject(new Error('async proof')), () => { throw new Error('missing proof'); }]) {
  const f = fixture({isCurrent});
  trackOwned(f);
  for (let repeat = 0; repeat < 3; repeat++) {
   f.manager.noteActivity('s');
   f.fire();
   await f.manager.waitUntilAvailable('s');
  }
  assert.deepEqual(f.disposed, []);
  assert.equal(f.errors.length, 1);
 }
});

test('native proof is rechecked before commit when idle status masks maintenance', async () => {
 let maintenance = false;
 const f = fixture({isCurrent: record => {
  assert.deepEqual(record, {sessionId:'s', agent:f.agent, handle:f.handle});
  return !maintenance;
 }});
 trackOwned(f);
 f.manager.noteActivity('s');
 assert.equal(f.timers.size, 1);
 f.fire();
 maintenance = true;
 await f.manager.waitUntilAvailable('s');
 assert.deepEqual(f.disposed, []);
 assert.equal(f.timers.size, 0);
});

test('unsupported duplicate track keeps the exact original until it is forgotten', async () => {
 const f = fixture();
 const replacement = fixture();
 assert.equal(trackOwned(f), true);
 const candidate = {sessionId:'s', agent:replacement.agent, handle:replacement.handle, provenance:'owned'};
 assert.equal(f.manager.track(candidate), false);
 assert.equal(f.manager.forget({sessionId:'s', agent:replacement.agent}), false);
 f.manager.noteActivity('s');
 const stale = [...f.timers.values()][0];
 assert.equal(f.manager.forget({sessionId:'s', agent:f.agent}), true);
 assert.equal(f.manager.track(candidate), true);
 stale.callback();
 f.manager.noteActivity('s');
 f.fire();
 await f.manager.waitUntilAvailable('s');
 assert.deepEqual(f.disposed, []);
 assert.deepEqual(replacement.disposed, [replacement.handle]);
});

test('forget preserves an observed disposal and a queued replacement held by a viewer', async () => {
 const f = fixture();
 const replacement = fixture();
 let finish;
 f.handle.dispose = () => new Promise(resolve => { finish = resolve; });
 trackOwned(f);
 f.manager.noteActivity('s');
 f.fire();
 await Promise.resolve();
 assert.equal(typeof f.manager.forget, 'function');
 const release = f.manager.viewerOpened('s');
 const pending = f.manager.waitUntilAvailable('s');
 assert.equal(f.manager.track({sessionId:'s', agent:replacement.agent, handle:replacement.handle, provenance:'owned'}), true);
 assert.equal(f.manager.forget({sessionId:'s', agent:{}}), false);
 assert.equal(f.manager.forget({sessionId:'s', agent:f.agent}), true);
 assert.strictEqual(f.manager.waitUntilAvailable('s'), pending);
 finish();
 await pending;
 assert.equal(f.manager.isEvicting('s'), false);
 assert.equal(f.timers.size, 0);
 release();
 assert.deepEqual([...f.timers.values()].map(timer => timer.delay), [10]);
 f.fire();
 await f.manager.waitUntilAvailable('s');
 assert.deepEqual(replacement.disposed, [replacement.handle]);
});

test('forgetting a queued agent prevents its promotion after old disposal', async () => {
 const f = fixture();
 const replacement = fixture();
 let finish;
 f.handle.dispose = () => new Promise(resolve => { finish = resolve; });
 trackOwned(f);
 f.manager.noteActivity('s');
 f.fire();
 await Promise.resolve();
 const pending = f.manager.waitUntilAvailable('s');
 assert.equal(f.manager.track({sessionId:'s', agent:replacement.agent, handle:replacement.handle, provenance:'owned'}), true);
 const forgotten = f.manager.forget({sessionId:'s', agent:replacement.agent});
 assert.strictEqual(f.manager.waitUntilAvailable('s'), pending);
 finish();
 await pending;
 f.fire();
 await f.manager.waitUntilAvailable('s');
 assert.deepEqual(replacement.disposed, []);
 assert.equal(forgotten, true);
});

test('unload between the timer callback and its microtask prevents disposal', async () => {
 const f = fixture();
 trackOwned(f);
 f.manager.noteActivity('s');
 f.fire();
 const teardown = f.manager.dispose();
 assert.equal(f.manager.isEvicting('s'), true);
 assert.deepEqual(f.disposed, []);
 await teardown;
 assert.equal(f.manager.isEvicting('s'), false);
 assert.deepEqual(f.disposed, []);
});

test('a successfully disposed handle cannot be tracked for another disposal', async () => {
 const f = fixture();
 trackOwned(f);
 f.manager.noteActivity('s');
 f.fire();
 await f.manager.waitUntilAvailable('s');
 assert.equal(trackOwned(f), false);
 f.manager.noteActivity('s');
 f.fire();
 await f.manager.waitUntilAvailable('s');
 assert.deepEqual(f.disposed, [f.handle]);
});

test('unload awaits running disposal rejection but never commits a pending timer', async () => {
 const f = fixture();
 const other = fixture();
 const failure = new Error('deferred disposal failure');
 let rejectDisposal;
 f.handle.dispose = () => new Promise((resolve, reject) => { rejectDisposal = reject; });
 trackOwned(f);
 f.manager.noteActivity('s');
 f.fire();
 await Promise.resolve();
 const pending = f.manager.waitUntilAvailable('s');
 const observedFailure = assert.rejects(pending, failure);
 f.manager.track({sessionId:'other', agent:other.agent, handle:other.handle, provenance:'owned'});
 f.manager.noteActivity('other');
 f.fire();
 const teardown = f.manager.dispose();
 assert.equal(typeof teardown?.then, 'function');
 assert.strictEqual(f.manager.dispose(), teardown);
 assert.strictEqual(f.manager.waitUntilAvailable('s'), pending);
 const lateView = f.manager.viewerOpened('after-unload');
 lateView();
 lateView();
 assert.equal(trackOwned(f, 'after-unload'), false);
 let ended = false;
 teardown.then(() => { ended = true; });
 await Promise.resolve();
 assert.equal(ended, false);
 assert.deepEqual(other.disposed, []);
 rejectDisposal(failure);
 await observedFailure;
 await teardown;
 assert.equal(f.manager.isEvicting('s'), false);
 assert.equal(f.timers.size, 0);
 assert.deepEqual(f.errors, [failure]);
 assert.deepEqual(other.disposed, []);
});
