import {loadHostModules} from './host-libs.js';
import {createAgentLoopClass} from './consumer-adapters.js';
const libs=await loadHostModules();
const {AgentLoop}=await libs.hostImport('@deepseek-ai/dsh-agent-loop');
const DiskAgentLoop=createAgentLoopClass(AgentLoop);
export default DiskAgentLoop;
export {DiskAgentLoop};
