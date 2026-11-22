export function createPtcHistoryTool(defineTool,controller){
 if(typeof defineTool!=='function'||typeof controller?.readPtcLines!=='function')throw new TypeError('PTC detail tool requires defineTool and DiskPresentationController');
 return defineTool({
  name:'ptc_history_read',
  description:'Read one bounded page of an oversized PTC read-result history from the original session log. Use the disk token shown on a PTC history preview; only the calling Agent\'s own session is accessible. Continue with nextOffset/nextTextOffset; each page is under 48 KiB. Reading details is explicit and does not add the entire result to model context.',
  parameters:{
   seq:{type:'number',required:true,description:'Original tool/ptc-dispatch event sequence printed on the preview.'},
   token:{type:'string',required:true,description:'Process-local detail token on that same preview; it expires on restart or source change.'},
   offset:{type:'number',description:'Zero-based metadata line index; defaults to 0.'},
   textOffset:{type:'number',description:'UTF-16 character offset for continuing a single very long line; defaults to 0.'},
   limit:{type:'number',description:'Metadata lines to request, from 1 to 128; defaults to 64.'},
  },
  output:{schema:{type:'object',additionalProperties:false,properties:{sessionId:{type:'string',required:true},seq:{type:'integer',required:true},revision:{type:'string',required:true},lines:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{number:{type:'integer',required:true},text:{type:'string',required:true},textOffset:{type:'integer',required:true},continued:{type:'boolean',required:true}}}},nextOffset:{type:'integer',required:true},nextTextOffset:{type:'integer',required:true},hasMore:{type:'boolean',required:true}}},render:(_args,page)=>[{type:'text',text:JSON.stringify(page)}]},
  async execute(args,exec){
   const sessionId=exec?.agent?.session?.id;
   if(typeof sessionId!=='string'||!sessionId)throw new Error('ptc_history_read requires an Agent-owned session');
   const limit=args.limit===undefined?64:args.limit;
   const offset=args.offset===undefined?0:args.offset;
   const textOffset=args.textOffset===undefined?0:args.textOffset;
   if(!Number.isSafeInteger(args.seq)||args.seq<0||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(textOffset)||textOffset<0||!Number.isSafeInteger(limit)||limit<1||limit>128||typeof args.token!=='string'||!args.token)throw new Error('ptc_history_read arguments are outside their bounds');
   const page=await controller.readPtcLines({sessionId,seq:args.seq,token:args.token,offset,textOffset,limit,maxBytes:48*1024,signal:exec.signal});
   return {sessionId,...page};
  },
 });
}
