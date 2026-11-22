import {createDetailsHandler} from './details-route.js';
export const name='ptc-disk-history';
export const inject=['connection','sessionPersistence'];
export function apply(ctx){
 const controller=ctx.sessionPersistence.diskController;
 if(!controller)throw new Error('PTC disk history requires its version-pinned persistence adapter; restart with the complete bundle');
 ctx.effect(()=>ctx.connection.fetch.register({path:'/api/ptc-disk-history/lines',methods:['POST'],requestBody:'buffered',fetch:createDetailsHandler(controller)}),'ptc disk history: owner-only lines route');
}
