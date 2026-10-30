"use strict";
// Renderer handleSendSignal/handleRecvSignal owns authenticated HTTPS. No
// account session key crosses this boundary. Numeric commands are not ZRTC
// enum ordinals. Most responses carry only command; 401 additionally carries
// its call ID. Allow one request per command and correlate 401 explicitly.
const {EventEmitter} = require('events');
const FIELDS = Object.freeze({
    401:['calleeId','callId','codec','type'],
    416:['calleeId','rtcpAddress','rtpAddress','codec','extendData','session','callId'],
    407:['callerId','callId'],
    408:['calleeId','callId'],
    402:['callerId','callId','status','codec','extendData','rtcpAddress','rtpAddress','session'],
    405:['toId','callId','callType'],
    409:['toId','callId'],
    // Renderer /api/voicecall/conf: current mic/camera state for the peer.
    12006:['calleeId','callId','isOnCam','isOnMic','data'],
});
class DesktopSignaling extends EventEmitter {
    constructor(send, {timeoutMs=15000}={}) {
        super();
        if(typeof send!=='function' || !Number.isInteger(timeoutMs) || timeoutMs<1)
            throw new TypeError('Invalid signaling transport');
        this.send=send; this.timeoutMs=timeoutMs; this.pending=new Map();
        this.expired=new Set(); this.closed=false;
        this.configurationIds=new Set();
    }
    request(command,data) {
        const started=Date.now();
        const trace=(note)=>{
            if(process.env.ZALO_ZCALL_LOG==='0')return;
            try{require('fs').appendFileSync(require('path').join(require('os').homedir(),'.config','ZaloData','zcall-agent.log'),
                `${new Date().toISOString()} [signaling] ${command} ${note} +${Date.now()-started}ms\n`);}catch{}
        };
        trace('request');
        return this.requestInner(command,data).then(value=>{trace('ok');return value;},error=>{trace('failed: '+String(error&&error.message).slice(0,80)+' code='+(error&&error.code));throw error;});
    }
    requestInner(command,data) {
        if(this.closed) return Promise.reject(new Error('Signaling transport closed'));
        if(!Number.isInteger(command) || !Object.hasOwn(FIELDS,command) ||
            !data || typeof data!=='object' || Array.isArray(data))
            return Promise.reject(new Error('Unsupported signaling request'));
        if(this.pending.has(command) || this.expired.has(command))
            return Promise.reject(new Error('Signaling command busy or expired'));
        const fields=FIELDS[command], payload={};
        if(Object.keys(data).some(k=>!fields.includes(k)))
            return Promise.reject(new Error('Unexpected signaling field'));
        for(const key of fields) {
            if(key==='extendData' && data[key]===undefined) continue;
            const kinds=command===12006 && (key==='isOnCam' || key==='isOnMic')?['boolean']:['string','number'];
            if(!Object.hasOwn(data,key) || !kinds.includes(typeof data[key]) ||
                (typeof data[key]==='number' && !Number.isFinite(data[key])))
                return Promise.reject(new Error('Missing or invalid signaling field: '+key));
            payload[key]=data[key];
        }
        if(command===401) {
            const id=String(payload.callId);
            if(!/^[1-9][0-9]{0,9}$/.test(id) || Number(id)>0x7fffffff ||
                this.configurationIds.has(id) || this.configurationIds.size>=4096)
                return Promise.reject(new Error('Invalid, reused or exhausted configuration ID'));
            this.configurationIds.add(id);
        }
        return new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>{
                this.pending.delete(command);
                // Late command-only responses require a fresh connection.
                // A 401 retry is safe only with a fresh, never-reused call ID.
                if(command!==401 && command!==12006)this.expired.add(command);
                reject(new Error('Signaling response timeout'));
            },this.timeoutMs);
            this.pending.set(command,{resolve,reject,timer,callId:String(payload.callId)});
            try { this.send({type:'sendSignal',command,data:payload}); }
            catch(error) {
                clearTimeout(timer);this.pending.delete(command);
                if(command!==401)this.expired.add(command);reject(error);
            }
        });
    }
    receive(message) {
        if(this.closed || !message || typeof message!=='object') return false;
        if(message.type==='control') {
            const control=message.data;
            if(!control || typeof control!=='object' || control.act_type!=='voip' ||
                typeof control.act!=='string' || !control.data || typeof control.data!=='object') return false;
            this.emit('control',control); return true;
        }
        if(!['recvSignal','recvSignalError'].includes(message.type) || !Number.isInteger(message.command)) return false;
        const entry=this.pending.get(message.command);
        if(!entry) return false;
        // Unlike older command-only replies, 401 carries the requested ID.
        // Never consume a replacement request with a canceled call's config.
        if(message.command===401 && message.type==='recvSignal' &&
            (!Number.isInteger(message.data?.id) || String(message.data.id)!==entry.callId))return false;
        if(message.type==='recvSignalError') {
            if(!message.data || String(message.data.callId)!==entry.callId) return false;
            this.pending.delete(message.command);clearTimeout(entry.timer);
            const error=new Error('Desktop signaling API failed');
            error.command=message.command;
            error.code=Number.isInteger(message.data.errorCode)?message.data.errorCode:null;
            entry.reject(error);return true;
        }
        this.pending.delete(message.command);clearTimeout(entry.timer);
        // The renderer's kCOK response decoder already decrypted/validated
        // both envelopes and supplies r.data here. Do not unwrap data again.
        // Delivery still does not imply media negotiation or a connected call.
        entry.resolve(message.data);return true;
    }
    close() {
        this.closed=true;
        for(const entry of this.pending.values()) {
            clearTimeout(entry.timer);entry.reject(new Error('Signaling transport closed'));
        }
        this.pending.clear();this.removeAllListeners();
    }
    reset() {
        for(const entry of this.pending.values()) {
            clearTimeout(entry.timer);entry.reject(new Error('Signaling transport reset'));
        }
        this.pending.clear();
        this.expired.clear();
    }
    cancel(command) {
        const entry=this.pending.get(command);
        if(!entry) return false;
        this.pending.delete(command);clearTimeout(entry.timer);
        // Retire command-only requests on this connection. 401 has an ID and
        // can be retried, but configurationIds prevents reuse of an old ID.
        if(command!==401)this.expired.add(command);
        entry.reject(new Error('Signaling request canceled'));return true;
    }
}
module.exports={DesktopSignaling};
