import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {assertCompatibleDshVersion} from '../lib/compatibility.js';

const generated='// Generated isolated DSH native snapshot; do not edit by hand.\n';
async function writeGenerated(file,text){
 try{const current=await fs.readFile(file,'utf8');if(!current.startsWith(generated))throw new Error(`refusing to overwrite non-generated source: ${file}`);}catch(error){if(error.code!=='ENOENT')throw error;}
 await fs.writeFile(file,text,{mode:0o600});
}
export async function prepareNative({dshDir,outputDir}={}){
 if(!dshDir)throw new Error('provide the installed DSH package directory');
 dshDir=await fs.realpath(dshDir);outputDir=outputDir?path.resolve(outputDir):await fs.mkdtemp(path.join(os.tmpdir(),`dsh-ptc-native-check-${process.pid}-`));
 const manifest=JSON.parse(await fs.readFile(path.join(dshDir,'package.json'),'utf8'));
 if(manifest.name!=='@deepseek-ai/dsh')throw new Error('expected the installed @deepseek-ai/dsh package');
 assertCompatibleDshVersion(manifest.version);
 const nativeDir=path.join(dshDir,'node_modules','@deepseek-ai','dsh-session-persistence-jsonl');
 const nativeManifest=JSON.parse(await fs.readFile(path.join(nativeDir,'package.json'),'utf8'));
 if(nativeManifest.version!==manifest.version)throw new Error(`persistence package ${nativeManifest.version} does not match DSH ${manifest.version}`);
 const source=await fs.readFile(path.join(nativeDir,'lib','index.js'),'utf8');
 if(!source.includes('var JsonlSessionPersistence = class extends SessionPersistence')||!source.includes('var JsonlBackendTracker = class'))throw new Error('native class layout differs from the inspected build');
 let importCount=0;
 const rewritten=source.replace(/^import (.+?) from "([^"\n]+)";$/gm,(line,binding,spec)=>{
  if(spec.startsWith('node:'))return line;
  importCount++;
  if(binding.startsWith('{')&&binding.endsWith('}'))return `const ${binding.replace(/\bas\b/g,':')} = await __ptcHostImport(${JSON.stringify(spec)});`;
  if(/^[A-Za-z_$][\w$]*$/.test(binding))return `const { default: ${binding} } = await __ptcHostImport(${JSON.stringify(spec)});`;
  throw new Error(`unsupported native import binding for ${spec}`);
 }).replace(/\bimport\("([^"\n]+)"\)/g,(expression,spec)=>spec.startsWith('node:')?expression:`__ptcHostImport(${JSON.stringify(spec)})`);
 if(importCount<8)throw new Error('incomplete native dependency resolution');
 const sha256=createHash('sha256').update(source).digest('hex');
 const worker=await fs.readFile(path.join(nativeDir,'lib','worker.cjs'),'utf8');
 const workerSha256=createHash('sha256').update(worker).digest('hex');
 const proof={upstream:'https://github.com/deepseek-ai/deepseek-harness',version:manifest.version,installedRoot:dshDir,package:'@deepseek-ai/dsh-session-persistence-jsonl',sha256,workerSha256,modifications:['resolve imports from the same host installation','export existing native classes for an explicit isolated adapter']};
 await fs.mkdir(outputDir,{recursive:true,mode:0o700});
 await writeGenerated(path.join(outputDir,'jsonl.js'),generated+`import {hostImport as __ptcHostImport} from '../host-libs.js';\n`+rewritten+'\nexport { JsonlSessionPersistence, JsonlBackendTracker };\n');
 const cjsAnchor=`const __ptcProof = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname,'native-source.json'),'utf8'));\nrequire = require('node:module').createRequire(require('node:path').join(process.env.DSH_INSTALL_DIR || __ptcProof.installedRoot,'package.json'));\n`;
 await writeGenerated(path.join(outputDir,'worker.cjs'),generated+cjsAnchor+worker);
 await fs.writeFile(path.join(outputDir,'native-source.json'),JSON.stringify(proof,null,2)+'\n',{mode:0o600});
 await fs.writeFile(path.join(outputDir,'package.json'),'{"type":"module","private":true}\n',{mode:0o600});
 const license=await fs.readFile(path.join(nativeDir,'LICENSE'),'utf8');
 await fs.writeFile(path.join(outputDir,'LICENSE'),license,{mode:0o600});
 return {...proof,snapshotDir:outputDir};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 prepareNative({dshDir:process.argv[2]??process.env.DSH_INSTALL_DIR}).then(proof=>console.log(JSON.stringify(proof,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
