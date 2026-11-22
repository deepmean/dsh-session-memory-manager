import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
let loader={};try{loader=await import('../lib/native-loader.js');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
const dsh=process.env.DSH_INSTALL_DIR;

test('activation derives native classes from the actual matching install and removes only generated code at disposal',async()=>{
 assert.equal(typeof loader.loadPreparedNative,'function');
 const installed=JSON.parse(await fs.readFile(path.join(dsh,'package.json'),'utf8'));
 const require=createRequire(path.join(dsh,'package.json'));
 const prepared=await loader.loadPreparedNative(dsh);
 try{
  assert.equal(prepared.prepared.version,installed.version);
  const original=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence')).href);
  assert.equal(Object.getPrototypeOf(prepared.native.JsonlSessionPersistence),original.SessionPersistence,'adapter shares the actual host Service base class');
  assert.equal(typeof prepared.native.JsonlBackendTracker,'function');
  assert.ok((await fs.stat(prepared.snapshotRoot)).isDirectory());
 }finally{await prepared.close();}
 await assert.rejects(fs.stat(prepared.snapshotRoot),{code:'ENOENT'});
});

test('a malformed or unsupported native service layout fails closed without a partial temp snapshot',async()=>{
 assert.equal(typeof loader.validateNativeShape,'function');
 assert.throws(()=>loader.validateNativeShape({}),/native persistence shape/i);
});
