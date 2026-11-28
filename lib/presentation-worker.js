import {parentPort,workerData} from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DiskHistoryReader} from './disk-reader.js';
import {loadHostModules} from './host-libs.js';
import {DISK_META_KEY,eligibleLines,linesPreview,hashValue,metadataWithoutLines} from './preview-policy.js';

const libs=await loadHostModules(workerData.dshDir);
const sources=new Map(),references=new Map(),knownTokens=new Map(),operations=new Map(),batchAcks=new Map();
const metrics={scans:0,detailReads:0,externalFilesWritten:0,sourceEvictions:0};
const maxSources=workerData.maxSources??2,maxReferences=workerData.maxReferences??50000,sourceIdleMs=workerData.sourceIdleMs??60_000;
const stamp=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
let closed=false,queue=Promise.resolve(),activeId=null,currentProgress={phase:'idle',rows:0},batchSequence=0;
function report(phase,rows=currentProgress.rows){
 currentProgress={phase,rows};
 if(activeId!==null){const m=process.memoryUsage();parentPort.postMessage({kind:'progress',id:activeId,phase,rows,rss:m.rss,heapUsed:m.heapUsed});}
}
process.on('uncaughtExceptionMonitor',error=>{
 try{parentPort.postMessage({kind:'fatal',id:activeId,exitCode:1,progress:{...currentProgress,...process.memoryUsage()},error:{name:error?.name??'Error',message:String(error?.message??'worker exception').slice(0,240),code:error?.code}});}catch{}
});
function check(signal){if(closed)throw new Error('disk presentation worker is closed');signal?.throwIfAborted();}
function cancelBatches(id,error){for(const[key,ack]of batchAcks){if(key.startsWith(`${id}:`)){batchAcks.delete(key);ack.reject(error);}}}
async function sendBatch(id,events){
 if(events.length===0)return;
 const batchId=++batchSequence;
 return new Promise((resolve,reject)=>{batchAcks.set(`${id}:${batchId}`,{resolve,reject});parentPort.postMessage({kind:'batch',id,batchId,events});});
}
async function fence(file){
 const absolute=path.resolve(file),relative=path.relative(workerData.root,absolute);
 if(!relative||relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative)||path.basename(file)!=='session.v4.jsonl.zstd')throw new Error('session path is outside configured storage root');
 const real=await fs.realpath(absolute);if(real.toLowerCase()!==absolute.toLowerCase())throw new Error('session source must not traverse a symlink or junction');
 return absolute;
}
function expireSource(file,source){
 if(closed||sources.get(file)!==source)return false;
 if(source.timer!==undefined)clearTimeout(source.timer);source.timer=undefined;
 sources.delete(file);source.reader.close();metrics.sourceEvictions++;
 return true;
}
function armSourceExpiry(file,source){
 if(source.timer!==undefined)clearTimeout(source.timer);
 source.lastUsedAt=Date.now();
 if(sourceIdleMs<0)return;
 source.timer=setTimeout(()=>{
  source.timer=undefined;
  if(closed||sources.get(file)!==source)return;
  if(operations.size!==0||source.reader.busy?.()){
   source.expirePending=true;return;
  }
  expireSource(file,source);
 },sourceIdleMs);
 source.timer.unref?.();
}
function expirePendingSources(){
 if(operations.size!==0)return;
 for(const[file,source]of sources)if(source.expirePending&&source.reader.busy?.()!==true)expireSource(file,source);
}
function stopSourceTimers(){for(const source of sources.values())if(source.timer!==undefined){clearTimeout(source.timer);source.timer=undefined;}}
function keepSource(file,source){
  const old=sources.get(file);if(old&&old!==source){if(old.timer!==undefined)clearTimeout(old.timer);old.reader.close();}
  sources.delete(file);source.expirePending=false;sources.set(file,source);armSourceExpiry(file,source);
  while(sources.size>maxSources){const first=sources.keys().next().value;const value=sources.get(first);expireSource(first,value);}
 }
async function freshReader(file,id,signal){
 check(signal);file=await fence(file);
 const proof=stamp(await fs.stat(file,{bigint:true}));const existing=sources.get(file);
 if(existing?.proof===proof){keepSource(file,existing);return existing;}
 const reader=new DiskHistoryReader(file,{maxFrameMiB:workerData.maxFrameMiB??64,maxRowMiB:workerData.maxRowMiB??8,maxIndexEntries:workerData.maxIndexEntries??200000});
 try{
  const summary=await reader.scan({signal,onHeader:h=>{if(h.id!==id)throw new Error('session source identity changed');},onEvent:row=>libs.v4.assertV4RowAdmission(row,libs.session.KNOWN_SESSION_EVENT_TYPES)});
  metrics.scans++;const source={reader,summary,id,proof:stamp(await fs.stat(file,{bigint:true})),timer:undefined,lastUsedAt:Date.now()};keepSource(file,source);return source;
 }catch(error){reader.close();throw error;}
}
function registerReference(event,file,id,preview){
 const lines=event.data.meta.lines,linesHash=hashValue(lines),key=file+'\0'+event.seq+'\0'+linesHash;
 let token=knownTokens.get(key),reference=token&&references.get(token);
 if(!reference){
  if(references.size>=maxReferences)throw new Error('disk metadata reference budget exceeded');
  token=randomUUID();reference={token,markerSeq:event.seq,lineCount:lines.length,originalBytes:Buffer.byteLength(JSON.stringify(lines)),linesHash,extrasHash:hashValue(metadataWithoutLines(event.data.meta)),previewHash:hashValue(preview),sourceIdentity:{name:event.data.name,subCallId:event.data.subCallId,rootCallId:event.data.rootCallId,parentCallId:event.data.parentCallId},locations:[{file,id,seq:event.seq}]};references.set(token,reference);knownTokens.set(key,token);
 }
 return {version:1,token,seq:event.seq,lineCount:lines.length,originalBytes:Buffer.byteLength(JSON.stringify(lines))};
}
function checkedReference(event){
 const meta=event?.data?.meta;
 if(!meta||!Object.hasOwn(meta,DISK_META_KEY))return undefined;
 const marker=meta[DISK_META_KEY];
 const reference=marker&&typeof marker==='object'&&!Array.isArray(marker)&&marker.version===1&&references.get(marker.token);
 if(!reference||event.type!=='tool/ptc-dispatch'||event.data.name!=='read')throw new Error('invalid or expired disk metadata token/reference');
 if(marker.seq!==reference.markerSeq||marker.lineCount!==reference.lineCount||marker.originalBytes!==reference.originalBytes||Object.keys(marker).length!==5)throw new Error('disk metadata marker identity mismatch');
 for(const [key,value]of Object.entries(reference.sourceIdentity))if(event.data[key]!==value)throw new Error('disk metadata PTC call identity mismatch');
 if(hashValue(meta.lines)!==reference.previewHash||hashValue(metadataWithoutLines(meta))!==reference.extrasHash)throw new Error('disk metadata preview/reference was changed');
 return reference;
}
async function sourceEvent(reference,ownerId,ownerFile,logicalSeq,signal){
 const candidates=[...reference.locations];
 if(ownerId&&ownerFile)candidates.push({file:ownerFile,id:ownerId,seq:logicalSeq});
 let last;
 for(const location of candidates.reverse()){
  try{
   const source=await freshReader(location.file,location.id,signal);const event=await source.reader.readEvent(location.seq,{revision:source.summary.revision,signal});
   if(event.type!=='tool/ptc-dispatch'||event.data?.name!=='read'||hashValue(event.data.meta?.lines)!==reference.linesHash)throw new Error('source event metadata hash/identity mismatch');
   for(const [key,value]of Object.entries(reference.sourceIdentity))if(event.data[key]!==value)throw new Error('source PTC call identity mismatch');
   return {event,location,source};
  }catch(error){if(signal?.aborted)throw error;last=error;}
 }
 throw new Error('complete original PTC metadata unavailable; refusing to write a preview',{cause:last});
}
async function load(request,signal){
 check(signal);const file=await fence(request.file),reader=new DiskHistoryReader(file,{maxFrameMiB:workerData.maxFrameMiB??64,maxRowMiB:workerData.maxRowMiB??8});
 let decoder,header,batch=[],rows=0;const batchLimit=workerData.presentationBatchEvents??256;report('physical-scan-start',rows);
 const sink={emitRun(){throw new Error('native V4 packed event rows are unsupported');},emitEvent(event){
  rows++;if((rows&255)===0)report('event-scan',rows);
  if(eligibleLines(event,workerData.thresholdBytes??32768)){
   const preview=linesPreview(event.data.meta.lines,workerData.previewBytes??4096);
   const marker=registerReference(event,file,request.id,preview);
   event={...event,data:{...event.data,meta:{...event.data.meta,lines:preview,[DISK_META_KEY]:marker}}};
  }
  batch.push(event);
 }};
 try{
  const summary=await reader.scan({signal,onHeader:value=>{
   report('header-validated',rows);
   if(value.id!==request.id)throw new Error('session source identity mismatch');header=value;decoder=libs.v4.releasedV4SessionFormatCodec.createDecoder(value,'strict');
  },onEvent:async row=>{
   libs.v4.assertV4RowAdmission(row,libs.session.KNOWN_SESSION_EVENT_TYPES);decoder.decodeRow(row,sink);
   if(batch.length>=batchLimit){const transfer=batch;batch=[];await sendBatch(activeId,transfer);}
  }});
  if(summary.compressedSha256!==request.expectedSha256)throw new Error('source snapshot hash changed before presentation decode');
  report('v4-finish',rows);
  const inheritedEventCount=decoder.finish(sink);
  report('v4-relationships',rows);
  if(batch.length){const transfer=batch;batch=[];await sendBatch(activeId,transfer);}
  metrics.scans++;keepSource(file,{reader,summary,id:request.id,proof:stamp(await fs.stat(file,{bigint:true}))});
  return {meta:decoder.header,inheritedEventCount,tornTruncateTo:undefined,recoveredTail:[]};
 }catch(error){reader.close();throw error;}
}
async function execute(kind,data,signal){
 check(signal);
 if(kind==='load')return load(data,signal);
 if(kind==='restore'){
  const reference=checkedReference(data.event);if(!reference)return data.event;
  metrics.detailReads++;
  const {event}=await sourceEvent(reference,data.ownerId,data.ownerFile,data.event.seq,signal);
  const meta={...data.event.data.meta,lines:event.data.meta.lines};delete meta[DISK_META_KEY];return {...data.event,data:{...data.event.data,meta}};
 }
 if(kind==='lines'){
  const reference=references.get(data.token);if(!reference)throw new Error('invalid disk metadata token');
  const location=reference.locations.find(item=>item.id===data.sessionId&&(item.seq===data.seq||reference.markerSeq===data.seq));
  if(!location)throw new Error('disk metadata token does not belong to requested session/seq');
  metrics.detailReads++;const {source,location:readLocation}=await sourceEvent(reference,data.sessionId,location.file,location.seq,signal);
  const page=await source.reader.readPtcLines(readLocation.seq,{revision:source.summary.revision,offset:data.offset??0,textOffset:data.textOffset??0,limit:data.limit??100,maxBytes:data.maxBytes??65536,signal});
  return {...page,seq:data.seq};
 }
 if(kind==='persisted'){
  for(const item of data.references){const reference=references.get(item.token);if(!reference)throw new Error('invalid committed metadata reference');if(!reference.locations.some(loc=>loc.file===data.file&&loc.seq===item.seq)){reference.locations.push({file:data.file,id:data.id,seq:item.seq});if(reference.locations.length>8)reference.locations.shift();}}
  const old=sources.get(data.file);if(old){if(old.timer!==undefined)clearTimeout(old.timer);old.reader.close();sources.delete(data.file);}return true;
 }
 if(kind==='metrics')return {...metrics,readers:sources.size,indexEntries:[...sources.values()].reduce((sum,source)=>sum+(source.summary.indexEntries??0),0),references:references.size};
 throw new Error('unknown disk presentation operation');
}
parentPort.on('message',message=>{
 if(message.kind==='cancel'){operations.get(message.id)?.abort(new Error('operation cancelled'));cancelBatches(message.id,new Error('operation cancelled'));return;}
 if(message.kind==='ack'){
  const key=`${message.id}:${message.batchId}`,ack=batchAcks.get(key);if(!ack)return;batchAcks.delete(key);
  if(message.ok)ack.resolve();else ack.reject(new Error(message.error??'presentation batch rejected'));return;
 }
 if(message.kind==='close'){
  closed=true;for(const operation of operations.values())operation.abort();for(const source of sources.values()){if(source.timer!==undefined)clearTimeout(source.timer);source.reader.close();}sources.clear();references.clear();knownTokens.clear();
  for(const ack of batchAcks.values())ack.reject(new Error('worker closed during batch transfer'));batchAcks.clear();return;
 }
 const abort=new AbortController();operations.set(message.id,abort);
 queue=queue.then(async()=>{
  try{activeId=message.id;report(`start-${message.kind}`,0);const value=await execute(message.kind,message.data,abort.signal);parentPort.postMessage({id:message.id,ok:true,value});}
  catch(error){parentPort.postMessage({id:message.id,ok:false,error:{name:error.name,message:error.message,cause:error.cause?.message}});}
  finally{operations.delete(message.id);cancelBatches(message.id,new Error('presentation operation completed'));expirePendingSources();activeId=null;currentProgress={phase:'idle',rows:0};}
 });
});
