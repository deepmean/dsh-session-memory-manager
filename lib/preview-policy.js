import {createHash} from 'node:crypto';
export const DISK_META_KEY='__dshDiskPtc';
export const hashValue=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function eligibleLines(event,threshold=32768){
 if(event?.type!=='tool/ptc-dispatch'||event.data?.name!=='read')return false;
 const meta=event.data.meta;
 if(!meta||typeof meta!=='object'||Array.isArray(meta))return false;
 if(Object.hasOwn(meta,DISK_META_KEY))throw new Error('persisted PTC locator is forbidden: raw logs must retain complete metadata');
 const lines=meta.lines;
 if(!Array.isArray(lines)||!lines.length)return false;
 let previous=0;
 for(const line of lines){if(!line||typeof line!=='object'||!Number.isSafeInteger(line.number)||line.number<=previous||typeof line.text!=='string')return false;previous=line.number;}
 return Buffer.byteLength(JSON.stringify(lines))>threshold;
}
export function linesPreview(lines,budget=4096){
 const selected=lines.length===1?[lines[0]]:[lines[0],lines.at(-1)];
 const preview=selected.map((line,i)=>({number:line.number,text:i===0?'[Disk-backed PTC preview] ':''}));
 let room=budget-Buffer.byteLength(JSON.stringify(preview));
 if(room<0)throw new Error('PTC preview byte budget is too small');
 for(let i=0;i<selected.length;i++){
  const text=selected[i].text,allowance=Math.floor(room/(selected.length-i));
  let low=0,high=Math.min(text.length,allowance);
  const part=n=>{if(n>0&&n<text.length&&/[\uD800-\uDBFF]/u.test(text[n-1]))n--;return text.slice(0,n)+(n<text.length?'...':'');};
  while(low<high){const n=Math.ceil((low+high)/2);if(Buffer.byteLength(JSON.stringify(part(n)))-2<=allowance)low=n;else high=n-1;}
  const appended=part(low);
  if(Buffer.byteLength(JSON.stringify(appended))-2>allowance)continue;
  preview[i].text+=appended;room-=Buffer.byteLength(JSON.stringify(appended))-2;
 }
 return preview;
}
export function metadataWithoutLines(meta){const copy={...meta,lines:[]};delete copy[DISK_META_KEY];return copy;}
