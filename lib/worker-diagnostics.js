const phaseOf=value=>typeof value?.phase==='string'?value.phase.slice(0,64):'unknown';
function mib(value){return Number.isFinite(value)&&value>=0?`${Math.round(value/1048576)}MiB`:undefined;}
export function formatWorkerFailure(progress,exitCode,cause){
 const parts=[`disk presentation worker exited (${Number.isInteger(exitCode)?exitCode:'unknown'})`,`phase=${phaseOf(progress)}`];
 if(Number.isSafeInteger(progress?.rows)&&progress.rows>=0)parts.push(`rows=${progress.rows}`);
 const rss=mib(progress?.rss),heap=mib(progress?.heapUsed);if(rss)parts.push(`rss=${rss}`);if(heap)parts.push(`heap=${heap}`);
 if(typeof cause?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(cause.code))parts.push(`code=${cause.code}`);
 if(cause?.message&&cause.code)parts.push(`detail=${String(cause.message).slice(0,180)}`);
 return new Error(parts.join('; '),cause?{cause}:undefined);
}
