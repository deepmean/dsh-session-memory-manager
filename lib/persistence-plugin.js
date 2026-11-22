import {zstdCompressSync,constants} from 'node:zlib';
import {createBackendClass} from './backend-adapter.js';
import {DiskPresentationController} from './presentation-runtime.js';
import {loadHostModules} from './host-libs.js';
import {loadPreparedNative} from './native-loader.js';

const libs=await loadHostModules();
const z=libs.schema;
export const name='ptc-disk-history-persistence';
export const Config=z.object({
 root:z.string().required(),compression:z.const('zstd').default('zstd'),listConcurrency:z.natural().min(1).default(3),
 workerHeapMiB:z.natural().min(128).max(512).default(192),requestTimeoutMs:z.natural().min(1000).max(180000).default(45000),
 maxFrameMiB:z.natural().min(4).max(128).default(64),previewBytes:z.natural().min(256).max(8192).default(4096),
 thresholdBytes:z.natural().min(8192).default(32768),
});
/** Each Host activation prepares a private native adapter from that Host's installed DSH. */
export async function apply(ctx,config){
 const prepared=await loadPreparedNative(libs.root);
 let controller,service,tracker;
 try{
  const {JsonlSessionPersistence,JsonlBackendTracker}=prepared.native;
  controller=new DiskPresentationController({dshDir:libs.root,root:config.root,heapMiB:config.workerHeapMiB??192,timeoutMs:config.requestTimeoutMs??45000,maxFrameMiB:config.maxFrameMiB??64,previewBytes:config.previewBytes??4096,thresholdBytes:config.thresholdBytes??32768});
  const Backend=createBackendClass(JsonlSessionPersistence,controller,{catalog:libs.catalog,compressFrame:raw=>zstdCompressSync(raw,{params:{[constants.ZSTD_c_checksumFlag]:1,[constants.ZSTD_c_compressionLevel]:3}})});
  ctx.effect(function*(){
   yield async()=>{await controller.close();await prepared.close();};
   tracker=new JsonlBackendTracker('session-persistence-jsonl');
   yield tracker.install(ctx);
   service=ctx.plugin({name:'ptc-disk-history-native-storage',apply(serviceCtx){
    const storage=new Backend(serviceCtx,config,tracker);storage.diskController=controller;
    controller.setResolver(id=>storage.resolveCurrentLog(id));
   }});
   yield service.dispose;
  },'ptc-disk-history ordered storage resources');
  await service.await();
 }catch(error){await controller?.close();await prepared.close();throw error;}
}
