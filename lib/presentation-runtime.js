import fs from 'node:fs/promises';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {DISK_META_KEY} from './preview-policy.js';
import {formatWorkerFailure} from './worker-diagnostics.js';
export {DISK_META_KEY};

/** Explicit presentation operations; no getter performs I/O and no payload is externalized. */
export class DiskPresentationController{
 #worker;#pending=new Map();#next=0;#closed=false;#failure;#resolver;#progress={phase:'startup'};
 #counts={loads:0,detailReads:0,externalFilesWritten:0,batches:0,largestTransferBatch:0};
 constructor({dshDir,root,heapMiB=192,timeoutMs=45000,maxSources=2,maxReferences=50000,sourceIdleMs=60_000,maxFrameMiB=64,maxRowMiB=8,thresholdBytes=32768,previewBytes=4096,presentationBatchEvents=256}={}){
  if(!dshDir||!root)throw new Error('DSH installation and session root are required');
  this.root=path.resolve(root);this.timeoutMs=timeoutMs;
  this.#worker=new Worker(new URL('./presentation-worker.js',import.meta.url),{workerData:{dshDir,root:this.root,maxSources,maxReferences,sourceIdleMs,maxFrameMiB,maxRowMiB,thresholdBytes,previewBytes,presentationBatchEvents},resourceLimits:{maxOldGenerationSizeMb:heapMiB,maxYoungGenerationSizeMb:16,stackSizeMb:4}});
  this.#worker.on('message',message=>{
   if(message?.kind==='batch'){
    const operation=this.#pending.get(message.id);if(!operation)return;
    try{if(!Array.isArray(message.events)||typeof operation.onBatch!=='function')throw new Error('unexpected presentation batch');operation.onBatch(message.events);this.#counts.batches++;this.#counts.largestTransferBatch=Math.max(this.#counts.largestTransferBatch??0,message.events.length);this.#worker.postMessage({kind:'ack',id:message.id,batchId:message.batchId,ok:true});}
    catch(error){this.#worker.postMessage({kind:'ack',id:message.id,batchId:message.batchId,ok:false,error:String(error?.message??error)});}
    return;
   }
   if(message?.kind==='progress'&&typeof message.phase==='string'){
    this.#progress={phase:message.phase,rows:message.rows,rss:message.rss,heapUsed:message.heapUsed};return;
   }
   if(message?.kind==='fatal'){
    this.#failure=formatWorkerFailure({...this.#progress,...message.progress},message.exitCode??1,message.error);
    for(const operation of this.#pending.values()){operation.clean();operation.reject(this.#failure);}this.#pending.clear();return;
   }
   const operation=this.#pending.get(message.id);if(!operation)return;
   this.#pending.delete(message.id);operation.clean();
   if(message.ok)operation.resolve(message.value);
   else{const error=new Error(message.error.message+(message.error.cause?': '+message.error.cause:''));error.name=message.error.name;operation.reject(error);}
  });
  const fail=error=>{if(this.#failure)return;this.#failure=error;for(const operation of this.#pending.values()){operation.clean();operation.reject(error);}this.#pending.clear();};
  this.#worker.on('error',error=>fail(formatWorkerFailure(this.#progress,1,error)));
  this.#worker.on('exit',code=>{if(!this.#closed&&code!==0)fail(formatWorkerFailure(this.#progress,code));else if(!this.#closed&&code===0)fail(new Error(`disk presentation worker exited unexpectedly; phase=${this.#progress.phase}`));});
 }
 setResolver(resolveFile){if(typeof resolveFile!=='function')throw new TypeError('resolveFile must be a function');this.#resolver=resolveFile;}
 async #fence(file){
  if(typeof file!=='string')throw new Error('canonical session source required');
  const absolute=path.resolve(file),relative=path.relative(this.root,absolute);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||path.basename(absolute)!=='session.v4.jsonl.zstd')throw new Error('session source is outside configured root');
  const canonical=await fs.realpath(absolute);if(canonical.toLowerCase()!==absolute.toLowerCase())throw new Error('session source resolves through a symlink/junction');
  return absolute;
 }
 #call(kind,data,signal,onBatch){
  if(this.#closed)return Promise.reject(new Error('disk presentation controller is closed'));
  if(this.#failure)return Promise.reject(this.#failure);
  if(signal?.aborted)return Promise.reject(signal.reason??new Error('operation aborted'));
  if(this.#pending.size>=64)return Promise.reject(new Error('disk presentation request queue is full'));
  const id=++this.#next;
  return new Promise((resolve,reject)=>{
   const stop=reason=>{if(!this.#pending.delete(id))return;this.#worker.postMessage({kind:'cancel',id});clean();reject(reason);};
   const abort=()=>stop(signal.reason??new Error('operation aborted'));
   const timer=setTimeout(()=>stop(new Error(`disk presentation request timeout (${this.timeoutMs} ms)`)),this.timeoutMs);
   const clean=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
   signal?.addEventListener('abort',abort,{once:true});this.#pending.set(id,{resolve,reject,clean,onBatch});
   try{this.#worker.postMessage({kind,id,data});}catch(error){this.#pending.delete(id);clean();reject(error);}
  });
 }
 async readStoredPrefix({file,id,revision,buffer,signal}={}){
  if(this.#closed)throw new Error('disk presentation controller is closed');
  if(!Buffer.isBuffer(buffer))throw new TypeError('native stable snapshot buffer is required');
  file=await this.#fence(file);
  const expectedSha256=createHash('sha256').update(buffer).digest('hex');
  this.#counts.loads++;
  const events=[];const result=await this.#call('load',{file,id,revision,expectedSha256},signal,batch=>{events.push(...batch);});
  return {...result,events};
 }
 async restoreEvent(event,{ownerId,signal}={}){
  if(this.#closed)throw new Error('disk presentation controller is closed');
  const meta=event?.data?.meta;
  if(!meta||typeof meta!=='object'||!Object.hasOwn(meta,DISK_META_KEY))return event;
  this.#counts.detailReads++;
  let ownerFile;if(ownerId&&this.#resolver){const resolved=await this.#resolver(ownerId);if(resolved)ownerFile=await this.#fence(resolved);}
  return this.#call('restore',{event,ownerId,ownerFile},signal);
 }
 async readPtcLines({sessionId,seq,token,offset=0,textOffset=0,limit=100,maxBytes=65536,signal}={}){
  this.#counts.detailReads++;
  return this.#call('lines',{sessionId,seq,token,offset,textOffset,limit,maxBytes},signal);
 }
 async persisted(header,events){
  const references=[];for(const event of events){const marker=event.data?.meta?.[DISK_META_KEY];if(marker)references.push({token:marker.token,seq:event.seq});}
  if(!references.length)return;
  if(!this.#resolver)throw new Error('committed PTC relocation needs the owning backend resolver');
  const file=await this.#fence(await this.#resolver(header.id));
  return this.#call('persisted',{id:header.id,file,references});
 }
 metrics(){return {...this.#counts,closed:this.#closed,pending:this.#pending.size};}
 async workerMetrics(){return this.#call('metrics',{});}
 async close(){
  if(this.#closed)return;this.#closed=true;
  for(const operation of this.#pending.values()){operation.clean();operation.reject(new Error('disk presentation controller closed'));}this.#pending.clear();
  this.#worker.postMessage({kind:'close'});await this.#worker.terminate();
 }
}
