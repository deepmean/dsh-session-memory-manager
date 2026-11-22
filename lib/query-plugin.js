import {loadHostModules} from './host-libs.js';
import {createQueryClass} from './consumer-adapters.js';
const libs=await loadHostModules();
const {SqliteSessionQueryEngine}=await libs.hostImport('@deepseek-ai/dsh-session-query-sqlite');
const DiskSessionQuery=createQueryClass(SqliteSessionQueryEngine);
export default DiskSessionQuery;
export {DiskSessionQuery};
