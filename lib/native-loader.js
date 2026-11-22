import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadHostModules} from './host-libs.js';
import {prepareNative} from '../scripts/prepare-native.mjs';

export function validateNativeShape(native){
 const Backend=native?.JsonlSessionPersistence,Tracker=native?.JsonlBackendTracker;
 if(typeof Backend!=='function'||typeof Tracker!=='function'
  ||typeof Backend.prototype.decodeStoredLog!=='function'
  ||typeof Backend.prototype.readZstdPrefix!=='function'
  ||typeof Backend.prototype.persistBatch!=='function'
  ||typeof Backend.prototype.encodeEventBatch!=='function'
  ||typeof Tracker.prototype.install!=='function')throw new Error('native persistence shape is incompatible with the PTC adapter');
 return true;
}

export async function loadPreparedNative(dshDir){
 const host=await loadHostModules(dshDir);
 const nativeDir=path.join(host.root,'node_modules','@deepseek-ai','dsh-session-persistence-jsonl');
 const nativeManifest=JSON.parse(await fs.readFile(path.join(nativeDir,'package.json'),'utf8'));
 if(nativeManifest.version!==host.version)throw new Error('session-persistence-jsonl does not match the installed DSH release');
 const snapshotRoot=await fs.mkdtemp(path.join(os.tmpdir(),`dsh-ptc-native-${process.pid}-`));
 try{
  await fs.writeFile(path.join(snapshotRoot,'package.json'),'{"type":"module"}\n',{mode:0o600});
  const helperRoot=path.join(snapshotRoot,'lib');await fs.mkdir(helperRoot,{recursive:true});
  for(const helper of ['host-libs.js','compatibility.js'])await fs.copyFile(new URL(`./${helper}`,import.meta.url),path.join(helperRoot,helper));
  const prepared=await prepareNative({dshDir:host.root,outputDir:path.join(helperRoot,'native')});
  if(prepared.version!==host.version)throw new Error('native snapshot was generated for a different DSH installation');
  const native=await import(pathToFileURL(path.join(helperRoot,'native','jsonl.js')).href);
  validateNativeShape(native);
  return {native,host,prepared,snapshotRoot,async close(){await fs.rm(snapshotRoot,{recursive:true,force:true});}};
 }catch(error){await fs.rm(snapshotRoot,{recursive:true,force:true});throw error;}
}
