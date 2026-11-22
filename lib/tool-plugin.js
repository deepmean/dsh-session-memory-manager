import {createPtcHistoryTool} from './ptc-tool.js';
import {loadHostModules} from './host-libs.js';
const libs=await loadHostModules();
const {defineTool}=await libs.hostImport('@deepseek-ai/dsh-tools');
export const name='ptc-disk-history-tools';
export const inject=['tools','sessionPersistence'];
export function apply(ctx){
 const controller=ctx.sessionPersistence.diskController;
 if(!controller)throw new Error('PTC history tool requires the matching disk-presentation persistence adapter');
 ctx.tools.register(createPtcHistoryTool(defineTool,controller));
}
