import test from 'node:test';
import assert from 'node:assert/strict';
import {createIdleAgentManager} from '../lib/idle-agent-manager.js';

function fixture({idleMs=10,status='idle',nextTurn=[],nextStep=[]}={}){
 const timers=new Map();const allTimers=new Map();let nextTimer=0;const disposed=[];const errors=[];
 const agent={status,inbox:{nextTurn:[...nextTurn],nextStep:[...nextStep]}};
 const handle={agent,dispose(){disposed.push(this);}};
 const manager=createIdleAgentManager({idleMs,onError:error=>errors.push(error),setTimer(callback,delay){const id=++nextTimer;const timer={callback,delay};timers.set(id,timer);allTimers.set(id,timer);return id;},clearTimer(id){timers.delete(id);}});
 const fire=()=>{const due=[...timers.values()];timers.clear();for(const timer of due)timer.callback();};
 return {agent,handle,manager,timers,allTimers,disposed,errors,fire};
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
