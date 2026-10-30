"use strict";
// Passive schema capture: no scalar values, account identifiers, addresses,
// codec contents or session material are retained.
const fs=require('fs');
function schema(value,depth=0) {
    if(depth>10) return {type:'depth-limit'};
    if(value===null) return {type:'null'};
    if(Array.isArray(value)) return {type:'array',length:value.length,items:value.slice(0,3).map(v=>schema(v,depth+1))};
    if(typeof value==='object') {
        const fields={};let otherKeys=0;
        for(const key of Object.keys(value).slice(0,100)) {
            if(!/^[A-Za-z_][A-Za-z_0-9]{0,63}$/.test(key) || ['__proto__','constructor','prototype'].includes(key)) {otherKeys++;continue;}
            fields[key]=schema(value[key],depth+1);
        }
        return {type:'object',fields,otherKeys};
    }
    if(typeof value==='number') return {type:'number',uint32:Number.isInteger(value)&&value>=0&&value<=0xffffffff};
    if(typeof value==='string') {
        if(value.length<=65536 && /^[\[{]/.test(value)) {
            try {return {type:'json-string',schema:schema(JSON.parse(value),depth+1)};} catch (_) {}
        }
        return {type:'string',length:value.length,numeric:/^[0-9]+$/.test(value)};
    }
    return {type:typeof value};
}
function record(file,message) {
    if(!['control','recvSignal','recvSignalError','update','request'].includes(message?.type)) return;
    // Only retain known command names, never an arbitrary string from IPC.
    if(message.type==='request' && !['makeCall','endCall','listDevice'].includes(message.command)) return;
    const entry={time:new Date().toISOString(),type:message.type,schema:schema(message.data)};
    if(Number.isInteger(message.command)) entry.command=message.command;
    if(message.type==='request') entry.command=message.command;
    if(message.type==='update' && message.command==='linux-native-setup' &&
       ['requesting-config','received-config','configured-offline','setup-failed','unsupported-config',
        'call-id-mismatch','unsupported-video','unsupported-dynamic-zrtp',
        'negotiating-network','native-server-ready','native-negotiation-failed',
        'invite-sent','peer-ringing','peer-answer-observed','peer-codec-applied','answer-acknowledged','media-started','remote-cleanup-ack','remote-cleanup-failed'].includes(message.data?.phase)) {
        entry.command=message.command;entry.phase=message.data.phase;
    }
    if(message.type==='control' && ['request','answer','answer_ack','cancel','endcall','reject','decline','busy','peer_busy','ring_ring','ringring'].includes(message.data?.act)) entry.action=message.data.act;
    const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW,0o600);
    try {fs.fchmodSync(fd,0o600);fs.writeSync(fd,JSON.stringify(entry)+'\n');} finally {fs.closeSync(fd);}
}
module.exports={schema,record};
