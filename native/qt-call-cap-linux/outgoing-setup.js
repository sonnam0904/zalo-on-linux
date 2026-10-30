"use strict";
const {randomInt}=require('crypto');
const {peerName:normalizePeerName,peerAvatar:normalizePeerAvatar}=require('../android-zrtc/call-presentation.cjs');

function canceledError() {
    const error=new Error('Outgoing setup canceled');
    error.name='AbortError';
    return error;
}
function isOutgoingCancellation(error) {return error?.name==='AbortError';}

// First leg of outgoing setup. Authenticated HTTPS stays in the renderer.
// onConfig must validate/apply the decoded response; a 401 response is never
// treated as remote ringing. 416 must wait for actual native media readiness.
class OutgoingSetup {
    constructor(signaling,{onConfig,onPreparing=()=>async()=>{},onFailure=async()=>{},onPhase=()=>{},callId=()=>randomInt(1,0x80000000),allowVideo=false,getContext=()=>undefined}={}) {
        if(typeof onConfig!=='function') throw new TypeError('Missing native config consumer');
        if(typeof allowVideo!=='boolean')throw new TypeError('Video opt-in must be boolean');
        if(typeof getContext!=='function')throw new TypeError('Invalid setup context provider');
        if(typeof onPreparing!=='function')throw new TypeError('Invalid preparation callback');
        if(typeof onFailure!=='function')throw new TypeError('Invalid failure callback');
        this.onFailure=onFailure;
        this.onPreparing=onPreparing;
        this.getContext=getContext;
        this.allowVideo=allowVideo;
        this.signaling=signaling;this.onConfig=onConfig;this.onPhase=onPhase;
        this.callId=callId;this.active=null;this.generation=0;
    }
    start(data) {
        if(this.active) return Promise.reject(new Error('Outgoing setup busy'));
        if(!(data?.type===1 || this.allowVideo && data?.type===3) || !Array.isArray(data.partner) || data.partner.length!==1 ||
           typeof data.partner[0]?.id!=='string' || !/^[1-9][0-9]{0,19}$/.test(data.partner[0].id))
            return Promise.reject(new Error('Only one-to-one voice setup is supported'));
        const callId=this.callId();
        const calleeId=data.partner[0].id,type=data.type,video=type===3;
        const peerName=normalizePeerName(data.partner[0].name);
        const peerAvatar=normalizePeerAvatar(data.partner[0].avatar);
        if(!Number.isInteger(callId) || callId<1 || callId>0x7fffffff)
            return Promise.reject(new Error('Invalid outgoing call ID'));
        const generation=++this.generation;
        this.abort=new AbortController();
        const current=()=>{if(generation!==this.generation) throw canceledError();};
        // Publish busy before callbacks can re-enter start().
        this.active=Promise.resolve().then(async()=>{
            const signal=this.abort.signal;
            const cancel=()=>{if(generation===this.generation){++this.generation;this.abort.abort();this.signaling.cancel(401);}};
            let finishPreparing=async()=>{};
            try {
            current();
            finishPreparing=this.onPreparing({signal,video,peerName,peerAvatar,cancel});
            if(typeof finishPreparing!=='function')throw new TypeError('Missing preparation cleanup');
            const context=this.getContext();
            current();this.onPhase('requesting-config');current();
            const config=await this.signaling.request(401,{
                calleeId,callId,codec:'[]',type,
            });
            current();this.onPhase('received-config');current();
            const result=await this.onConfig(config,{callId,calleeId,video,peerName,peerAvatar,current,signal,context,finishPreparing});
            current();return result;
            } catch(error) {
                // onConfig has joined its worker/media cleanup before rejecting.
                // Release preparation before asking the same pipe to show error.
                try {if(typeof finishPreparing==='function')await finishPreparing();}catch {}
                const canceled=signal.aborted || generation!==this.generation || isOutgoingCancellation(error);
                if(!canceled)try {await this.onFailure({signal,video,peerName,peerAvatar});}catch {}
                throw canceled && !isOutgoingCancellation(error)?canceledError():error;
            } finally {if(typeof finishPreparing==='function')await finishPreparing();}
        });
        return this.active.finally(()=>{this.active=null;});
    }
    async stop() {
        ++this.generation;this.abort?.abort();this.signaling.cancel(401);
        if(this.active) await this.active.catch(()=>{});
    }
}
module.exports={OutgoingSetup,isOutgoingCancellation};
