import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {loadHostModules} from '../lib/host-libs.js';
import {loadPreparedNative} from '../lib/native-loader.js';

export async function nativeFixture({lineCount=80,lineLength=1600}={}){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-ptc-native-'));
 const root=path.join(temp,'sessions'),libs=await loadHostModules(process.env.DSH_INSTALL_DIR),prepared=await loadPreparedNative(libs.root);
 const native=prepared.native,ctx=new libs.cordis.Context();
 let fiber;
 const cleanup=async()=>{await fiber?.dispose();await prepared.close();await fs.rm(temp,{recursive:true,force:true});};
 try{
  fiber=ctx.plugin({name:'original-storage-fixture',apply:native.apply,Config:native.Config},{root,compression:'zstd'});
  await fiber.await();
  const backend=ctx.get('sessionPersistence');
  const header={version:4,id:'session-ptc-fixture',createdAt:1,isSeeded:false,delegationDepth:0,cwd:temp};
  const events=[];
  const push=(type,data,surfaceOp,sources)=>{const e={type,seq:events.length,time:events.length+10,data};if(surfaceOp)e.surfaceOp=surfaceOp;if(sources)e.sourceEventSeqs=sources;events.push(e);return e.seq;};
  push('turn/start',{turn:1});push('step/start',{turn:1,step:1});
  push('system/message',{turn:1,step:1,message:{id:'sys',role:'system',source:{kind:'system-prompt'},content:[{type:'text',text:'KEEP SYSTEM'}]}},'append');
  push('request/header',{turn:1,step:1,reason:'initial',header:{config:{provider:'fixture',model:'fixture'}}});
  push('user/message',{id:'user',role:'user',source:{kind:'user'},content:[{type:'text',text:'KEEP QUESTION'}]},'append');
  push('assistant/message',{turn:1,step:1,message:{id:'assistant',role:'assistant',source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'tool-call',id:'root-call',name:'run_code',arguments:'{"code":"read fixture"}'}]},stream:[]},'append');
  const call=push('tool/call',{turn:1,step:1,callId:'root-call',name:'run_code',arguments:'{"code":"read fixture"}'});
  const identity={rootCallId:'root-call',parentCallId:'root-call',subCallId:'root-call:ptc:1',name:'read',arguments:{file_path:'fixture.txt',offset:1,limit:lineCount}};
  push('tool/ptc-dispatch-start',identity);
  push('tool/ptc-dispatch',{...identity,isError:false,content:[{type:'text',text:'KEEP PTC CONTENT'}],meta:{path:'fixture.txt',offset:1,totalLines:lineCount,lang:'text',lines:Array.from({length:lineCount},(_,i)=>({number:i+1,text:crypto.randomBytes(Math.ceil(lineLength*0.75)).toString('base64')})),opaque:{keep:true}}});
  push('tool/result',{turn:1,step:1,message:{id:'result',role:'tool',source:{kind:'tool',callId:'root-call'},toolCallId:'root-call',content:[{type:'text',text:'KEEP PROGRAM RESULT'}]}},'append',[call]);
  push('step/end',{turn:1,step:1});push('turn/end',{turn:1,reason:{kind:'completed'}});
  const handle=await backend.create(header);await handle.append(events);await handle.flush();await handle.close();
  const file=await backend.resolveCurrentLog(header.id);
  return {temp,root,file,header,events,libs,native,backend,ctx,fiber,async cleanup(){await cleanup();}};
 }catch(error){await cleanup();throw error;}
}
