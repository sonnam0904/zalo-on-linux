'use strict';
const {randomUUID}=require('node:crypto');
const {peerName,peerAvatar}=require('../android-zrtc/call-presentation.cjs');
// Use the existing renderer contact lookup. A unique response ticket prevents
// delayed results from an earlier call/account from naming a new call.
class IncomingName {
  constructor(send,{timeoutMs=1500,onResult=()=>{}}={}) {
    if(typeof send!=='function' || !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>2000)throw new TypeError('Invalid name lookup');
    this.send=send;this.timeoutMs=timeoutMs;this.onResult=onResult;this.pending=null;
  }
  resolveContact(id,signal) {
    const empty={peerName:'',peerAvatar:''};
    if(this.pending || typeof id!=='string' || !/^[1-9][0-9]{0,19}$/.test(id) || !signal || signal.aborted)return Promise.resolve(empty);
    return new Promise(resolve=>{
      const requestId=randomUUID();
      const done=value=>{
        if(this.pending?.requestId!==requestId)return;
        clearTimeout(this.pending.timer);signal.removeEventListener('abort',abort);
        this.pending=null;try{this.onResult({name:!!value.peerName,avatar:!!value.peerAvatar,timedOut:value===empty});}catch{}resolve(value);
      };
      const abort=()=>done(empty);
      this.pending={id,requestId,done,timer:setTimeout(abort,this.timeoutMs)};
      signal.addEventListener('abort',abort,{once:true});
      try {this.send({type:'request',command:'getAliasName',data:{noisedId:id,requestId}});}
      catch {done(empty);}
    });
  }
  resolve(id,signal) {return this.resolveContact(id,signal).then(contact=>contact.peerName);}
  receive(message) {
    if(message?.type!=='response' || message.command!=='getAliasName')return false;
    const task=this.pending,data=message.data;
    if(task && data?.requestId===task.requestId && data.noisedId===task.id)task.done({
      peerName:peerName(data.aliasName),peerAvatar:peerAvatar(data.avatar)
    });
    return true;
  }
}
module.exports={IncomingName};
