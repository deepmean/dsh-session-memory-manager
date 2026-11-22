import test from 'node:test';
import assert from 'node:assert/strict';
let diagnostics={};try{diagnostics=await import('../lib/worker-diagnostics.js');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const {formatWorkerFailure}=diagnostics;

test('worker exit reports the last phase and bounded memory diagnostics, never event content',()=>{
 const error=formatWorkerFailure({phase:'v4-relationships',rows:2048,rss:512*1048576,heapUsed:180*1048576},1);
 assert.match(error.message,/worker exited \(1\)/);assert.match(error.message,/v4-relationships/);assert.match(error.message,/rows=2048/);assert.match(error.message,/rss=512MiB/);assert.match(error.message,/heap=180MiB/);
 assert.doesNotMatch(error.message,/secret-content|meta\.lines|full-text/i);
});

test('worker runtime errors preserve their original cause and stage',()=>{
 const cause=new Error('allocation failed');cause.code='ERR_WORKER_OUT_OF_MEMORY';
 const error=formatWorkerFailure({phase:'scan-zstd',rows:100},1,cause);
 assert.match(error.message,/scan-zstd/);assert.match(error.message,/ERR_WORKER_OUT_OF_MEMORY/);assert.equal(error.cause,cause);
});
