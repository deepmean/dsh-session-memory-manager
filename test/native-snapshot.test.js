import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
let libs={},prep={};
try{libs=await import('../lib/host-libs.js');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
try{prep=await import('../scripts/prepare-native.mjs');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
const dsh=process.env.DSH_INSTALL_DIR;

test('host resolver uses the installed DSH version and shares its Session constructor',async()=>{
 assert.equal(typeof libs.loadHostModules,'function','host module resolver missing');
 const modules=await libs.loadHostModules(dsh);
 const require=createRequire(path.join(dsh,'package.json'));
 const original=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href);
 assert.equal(modules.session.Session,original.Session);
 assert.equal(modules.version,JSON.parse(await fs.readFile(path.join(dsh,'package.json'),'utf8')).version);
});

test('native snapshot opens only private test storage and preserves native validation',async()=>{
 assert.equal(typeof prep.prepareNative,'function','isolated snapshot builder missing');
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'ptc-native-isolation-'));
 try{
  await fs.writeFile(path.join(temp,'package.json'),'{"type":"module","private":true}');
  const nativeDir=path.join(temp,'lib','native');
  const result=await prep.prepareNative({dshDir:dsh,outputDir:nativeDir});
  for(const filename of ['host-libs.js','compatibility.js'])await fs.copyFile(new URL(`../lib/${filename}`,import.meta.url),path.join(temp,'lib',filename));
  assert.match(result.sha256,/^[a-f0-9]{64}$/);
  assert.equal(result.version,JSON.parse(await fs.readFile(path.join(dsh,'package.json'),'utf8')).version);
  const native=await import(pathToFileURL(path.join(nativeDir,'jsonl.js')).href);
  assert.equal(typeof native.JsonlSessionPersistence,'function');assert.equal(typeof native.JsonlBackendTracker,'function');
  const {cordis}=await libs.loadHostModules(dsh);const ctx=new cordis.Context();
  const root=path.join(temp,'sessions');
  const fiber=ctx.plugin({name:'native-test',apply:native.apply,Config:native.Config},{root,compression:'zstd'});
  await fiber.await();
  try{
   const storage=ctx.get('sessionPersistence');
   const access=await storage.create({version:4,id:'session-isolated',cwd:temp,createdAt:1,isSeeded:false,delegationDepth:0});
   assert.equal(access.header.id,'session-isolated');
   await access.close();
   await assert.rejects(storage.open('session-missing','read'),/not found|does not exist/i);
  }finally{await fiber.dispose();}
  assert.ok(!(await fs.readdir(temp)).some(n=>n.startsWith('ptc-read-meta')));
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});
