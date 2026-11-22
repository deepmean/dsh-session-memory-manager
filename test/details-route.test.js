import test from 'node:test';
import assert from 'node:assert/strict';
let routes={};try{routes=await import('../lib/details-route.js');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}

test('details route accepts only validated bounded explicit pagination',async()=>{
 assert.equal(typeof routes.createDetailsHandler,'function');let calls=0;
 const handler=routes.createDetailsHandler({async readPtcLines(input){calls++;assert.equal(input.sessionId,'session-a');assert.equal(input.maxBytes,2048);return {seq:3,revision:'r',lines:[{number:1,text:'exact',textOffset:0,continued:false}],nextOffset:1,nextTextOffset:0,hasMore:false};}});
 const response=await handler(new Request('http://localhost/api/ptc-disk-history/lines',{method:'POST',body:JSON.stringify({sessionId:'session-a',seq:3,token:'token',maxBytes:2048})}));
 assert.equal(response.status,200);assert.equal((await response.json()).lines[0].text,'exact');assert.equal(calls,1);
 for(const data of [{sessionId:'../escape',seq:3,token:'token'}, {sessionId:'session-a',seq:-1,token:'token'}, {sessionId:'session-a',seq:3,token:'token',maxBytes:99999999}]){
  const failed=await handler(new Request('http://localhost/api/ptc-disk-history/lines',{method:'POST',body:JSON.stringify(data)}));assert.equal(failed.status,400);
 }
 assert.equal(calls,1);
});
test('details route contains source failures and uses no-store responses',async()=>{
 assert.equal(typeof routes.createDetailsHandler,'function');const handler=routes.createDetailsHandler({async readPtcLines(){throw new Error('stale disk metadata token');}});
 const response=await handler(new Request('http://localhost/api/ptc-disk-history/lines',{method:'POST',body:JSON.stringify({sessionId:'session-a',seq:3,token:'expired'})}));
 assert.equal(response.status,409);assert.equal(response.headers.get('cache-control'),'no-store');
});
