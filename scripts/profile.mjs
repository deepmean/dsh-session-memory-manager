import {loadHostModules} from '../lib/host-libs.js';
import {DiskPresentationController,DISK_META_KEY} from '../lib/presentation-runtime.js';
import {nativeFixture} from '../test/native-fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const mode=process.argv[2]??'presentation';
const file=process.argv[3];
const installation=process.env.DSH_INSTALL_DIR;
const libs=await loadHostModules(installation);
const mib=n=>Number((n/1048576).toFixed(1));
const collect=()=>{globalThis.gc?.();globalThis.gc?.();};
if(!['presentation','synthetic-full','synthetic-presentation'].includes(mode))throw new Error('unsupported benchmark mode');
let fixture,controller,fiber;let events,handle;
try{
 let target=file;
 if(mode.startsWith('synthetic-')){fixture=await nativeFixture({lineCount:4000,lineLength:8000});target=fixture.file;}
 if(!target)throw new Error('provide one canonical session file');
 const stat=await fs.stat(target),root=fixture?.root??path.dirname(path.dirname(path.dirname(target)));
 collect();const before=process.memoryUsage();const started=performance.now();
 let ticks=0,longestDelayMs=0,last=performance.now();
 const timer=setInterval(()=>{const now=performance.now();longestDelayMs=Math.max(longestDelayMs,now-last-20);last=now;ticks++;},20);
 try{
  if(mode==='synthetic-full'){
   handle=await fixture.backend.open(fixture.header.id,'read');events=(await handle.read(0,undefined)).events;
  }else{
   controller=new DiskPresentationController({dshDir:libs.root,root,heapMiB:192,timeoutMs:90000,maxRowMiB:mode.startsWith('synthetic-')?64:8});
   const buffer=await fs.readFile(target);
   const fileId=path.basename(path.dirname(target));
   const decodedSummary=await controller.readStoredPrefix({file:target,id:fixture?.header.id??fileId,revision:'isolated-benchmark',buffer});
   events=decodedSummary.events;
  }
 }finally{clearInterval(timer);}
 const elapsedMs=performance.now()-started;
 collect();const after=process.memoryUsage();
 const previews=events.filter(e=>e.data?.meta?.[DISK_META_KEY]);
 const previewBytes=previews.reduce((n,e)=>n+Buffer.byteLength(JSON.stringify(e.data.meta.lines)),0);
 const originalMetaBytes=previews.reduce((n,e)=>n+e.data.meta[DISK_META_KEY].originalBytes,0);
 const output={mode,sourceModified:false,externalPayloadFilesCreated:0,compressedBytes:stat.size,events:events.length,ptcDiskPreviews:previews.length,previewBytes,originalMetaBytes,elapsedMs:Math.round(elapsedMs),mainLoopTicks:ticks,longestSampledMainLoopDelayMs:Math.round(longestDelayMs),processRssMiB:mib(after.rss),mainHeapBeforeMiB:mib(before.heapUsed),mainHeapAfterMiB:mib(after.heapUsed),mainHeapDeltaMiB:mib(after.heapUsed-before.heapUsed),arrayBuffersMiB:mib(after.arrayBuffers),workerOldGenerationLimitMiB:controller?192:0,controllerMetrics:controller?.metrics()};
 console.log(JSON.stringify(output,null,2));
}finally{await handle?.close();await controller?.close();await fiber?.dispose();await fixture?.cleanup();}
