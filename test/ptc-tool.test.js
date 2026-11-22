import test from 'node:test';
import assert from 'node:assert/strict';
import {createPtcHistoryTool} from '../lib/ptc-tool.js';

test('agent detail tool reads only the caller session in explicit bounded pages',async()=>{
  const calls=[];
  const tool=createPtcHistoryTool(spec=>spec,{async readPtcLines(input){calls.push(input);return {seq:8,revision:'r',lines:[{number:1,text:'recoverable detail',textOffset:0,continued:false}],nextOffset:1,nextTextOffset:0,hasMore:false};}});
  assert.equal(tool.name,'ptc_history_read');
  assert.equal(tool.parameters.seq.required,true);
  assert.equal(tool.parameters.token.required,true);
  const exec={agent:{session:{id:'session-owned'}},signal:new AbortController().signal};
  const page=await tool.execute({seq:8,token:'signed-process-token',offset:0,textOffset:0,limit:100},exec);
  assert.equal(page.lines[0].text,'recoverable detail');
  assert.equal(page.sessionId,'session-owned');
  assert.deepEqual(calls[0],{sessionId:'session-owned',seq:8,token:'signed-process-token',offset:0,textOffset:0,limit:100,maxBytes:49152,signal:exec.signal});
});

test('agent detail tool refuses agentless calls and does not accept a session selector',async()=>{
  const tool=createPtcHistoryTool(spec=>spec,{async readPtcLines(){throw new Error('must stay behind owner session fence');}});
  await assert.rejects(tool.execute({seq:0,token:'x'},{}),/Agent-owned/i);
  assert.equal(tool.parameters.session_id,undefined,'the model cannot choose another session id');
});
