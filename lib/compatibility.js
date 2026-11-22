function parseVersion(value){
 if(typeof value!=='string')return null;
 const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
 if(!match)return null;
 if(match[4]?.split('.').some(identifier=>/^\d+$/.test(identifier)&&identifier.length>1&&identifier.startsWith('0')))return null;
 return {major:Number(match[1]),minor:Number(match[2]),patch:Number(match[3]),prerelease:match[4]??''};
}
const BASELINE=parseVersion('0.2.2-rc.5');
function compare(a,b){
 for(const key of ['major','minor','patch'])if(a[key]!==b[key])return a[key]<b[key]?-1:1;
 if(a.prerelease===''||b.prerelease==='')return a.prerelease===b.prerelease?0:a.prerelease===''?1:-1;
 const left=a.prerelease.split('.'),right=b.prerelease.split('.');
 for(let i=0;i<Math.max(left.length,right.length);i++){
  if(left[i]===undefined)return -1;if(right[i]===undefined)return 1;if(left[i]===right[i])continue;
  const leftNum=/^(0|[1-9]\d*)$/.test(left[i]),rightNum=/^(0|[1-9]\d*)$/.test(right[i]);
  if(leftNum&&rightNum)return Number(left[i])<Number(right[i])?-1:1;
  if(leftNum!==rightNum)return leftNum?-1:1;
  return left[i]<right[i]?-1:1;
 }
 return 0;
}
export function assertCompatibleDshVersion(version){
 const parsed=parseVersion(version);
 if(!parsed)throw new Error(`invalid DSH semantic version: ${String(version)}`);
 if(compare(parsed,BASELINE)<0)throw new Error(`DSH ${version} is older than the minimum API baseline 0.2.2-rc.5`);
 return version;
}
