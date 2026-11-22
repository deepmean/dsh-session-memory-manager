import test from 'node:test';
import assert from 'node:assert/strict';
let compatibility={};try{compatibility=await import('../lib/compatibility.js');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}

test('later DSH releases are eligible for a fresh install-specific native snapshot',()=>{
 assert.equal(typeof compatibility.assertCompatibleDshVersion,'function');
 for(const version of ['0.2.2-rc.5','0.2.2','0.2.3-rc.1','0.2.9','0.3.0-rc.1','0.3.1','0.9.0','1.0.0'])assert.equal(compatibility.assertCompatibleDshVersion(version),version);
});
test('malformed release versions are rejected before resolving private runtime APIs',()=>{
 for(const version of ['broken','','v0.3.0','0.3','01.2.3','0.2.2-'])assert.throws(()=>compatibility.assertCompatibleDshVersion(version),/semantic|version/i);
});
