const response=(status,value)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
export function createDetailsHandler(controller){
 return async request=>{
  if(request.method!=='POST')return response(405,{error:'POST required'});
  let value;try{const text=await request.text();if(Buffer.byteLength(text)>4096)return response(413,{error:'request too large'});value=JSON.parse(text);}catch{return response(400,{error:'invalid JSON request'});}
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['sessionId','seq','token','offset','textOffset','limit','maxBytes'].includes(key)))return response(400,{error:'invalid pagination request'});
  const {sessionId,seq,token,offset=0,textOffset=0,limit=100,maxBytes=65536}=value;
  if(typeof sessionId!=='string'||!/^[-a-zA-Z0-9]{1,160}$/.test(sessionId)||!integer(seq,0,100000000)||typeof token!=='string'||!/^[-a-zA-Z0-9]{1,160}$/.test(token)||!integer(offset,0,100000000)||!integer(textOffset,0,100000000)||!integer(limit,1,500)||!integer(maxBytes,1024,65536))return response(400,{error:'invalid pagination bounds or identity'});
  try{
   const page=await controller.readPtcLines({sessionId,seq,token,offset,textOffset,limit,maxBytes,signal:request.signal});
   if(Buffer.byteLength(JSON.stringify(page))>maxBytes)return response(500,{error:'detail page exceeded its byte budget'});
   return response(200,page);
  }catch(error){
   if(request.signal?.aborted)return response(499,{error:'detail request cancelled'});
   if(/stale|token|reference|unavailable|changed|closed/i.test(error.message))return response(409,{error:'original history changed or detail reference expired; reopen the session'});
   return response(422,{error:'the original detail could not be read or validated'});
  }
 };
}
