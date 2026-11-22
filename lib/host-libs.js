import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {assertCompatibleDshVersion} from './compatibility.js';

const imports=new Map();
async function findHost(explicit){
 const candidates=[explicit,process.env.DSH_INSTALL_DIR];
 if(process.argv[1])candidates.push(path.resolve(path.dirname(process.argv[1]),'..'));
 for(const candidate of candidates.filter(Boolean)){
  let manifest;try{manifest=JSON.parse(await fs.readFile(path.join(candidate,'package.json'),'utf8'));}catch(error){if(candidate===explicit)throw new Error(`DSH installation cannot be read: ${error.message}`);continue;}
  if(manifest.name!=='@deepseek-ai/dsh'){if(candidate===explicit)throw new Error('expected the installed @deepseek-ai/dsh package');continue;}
  assertCompatibleDshVersion(manifest.version);
  return {root:await fs.realpath(candidate),version:manifest.version};
 }
 throw new Error('DSH installation unavailable; set DSH_INSTALL_DIR or run inside the DSH Host');
}
export async function hostImport(specifier,explicit){
 const {root}=await findHost(explicit);const key=root+'\0'+specifier;
 if(!imports.has(key)){
  const require=createRequire(path.join(root,'package.json'));
  imports.set(key,import(pathToFileURL(require.resolve(specifier)).href));
 }
 return imports.get(key);
}
export async function loadHostModules(explicit){
 const host=await findHost(explicit);
 const specs=['@deepseek-ai/cordis','@deepseek-ai/schemastery','@deepseek-ai/dsh-session','@deepseek-ai/dsh-session-format-catalog','@deepseek-ai/dsh-session-format-v3-to-v4','@deepseek-ai/dsh-llm'];
 const [cordis,schema,session,catalogModule,v4,llm]=await Promise.all(specs.map(spec=>hostImport(spec,host.root)));
 return {...host,cordis,schema:schema.default,session,catalog:catalogModule.sessionFormatCatalog,catalogModule,v4,llm,hostImport:spec=>hostImport(spec,host.root)};
}
