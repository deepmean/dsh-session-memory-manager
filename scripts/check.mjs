import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
async function walk(dir){const list=[];for(const item of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())list.push(...await walk(file));else if(/\.(?:js|mjs|cjs)$/.test(item.name))list.push(file);}return list;}
const manifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
if(manifest.name!=='@local/dsh-session-memory-manager'||manifest.version!=='0.1.0-alpha.5'||manifest.private!==true||manifest.engines.dsh!=='>=0.2.2-rc.5')throw new Error('invalid bundle identity/API baseline');
for(const target of Object.values(manifest.exports)){if(typeof target==='string'&&!target.includes('*'))await fs.access(path.join(root,target));}
for(const file of [...await walk(path.join(root,'lib')),...await walk(path.join(root,'scripts'))]){
 const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(result.error)throw result.error;if(result.status)process.exit(result.status);
}
for(const lang of ['zh','en']){const locale=JSON.parse(await fs.readFile(path.join(root,'locale',lang+'.json'),'utf8'));if(!locale.meta?.title||!locale.meta?.description)throw new Error('missing locale metadata');}
const svg=await fs.readFile(path.join(root,'icon.svg'),'utf8');if(!svg.includes('<svg')||/<(?:script|image|foreignObject)\b|\bon\w+=/i.test(svg))throw new Error('invalid self-contained icon');
console.log('PASS: runtime syntax, explicit exports, API baseline, locale metadata and self-contained SVG');
