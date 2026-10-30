"use strict";
// Bind a native identity only to an authenticated 401 response for the current
// desktop account. Repeated init/device updates must not erase that binding;
// account switches must invalidate asynchronous responses from the old account.
function desktopId(value) {
  if(typeof value!=='string' || !/^[1-9][0-9]{0,19}$/.test(value))throw new Error('Invalid desktop identity');
  return value;
}
class NativeIdentity {
  constructor(){this.account=null;this.nativeId=null;this.generation=0;}
  setAccount(value) {
    let account=null;
    try {account=desktopId(value);}catch {}
    if(account!==this.account){this.account=account;this.nativeId=null;this.generation++;}
  }
  ticket(){return {account:this.account,generation:this.generation};}
  remember(ticket,nativeId) {
    if(!ticket?.account || ticket.account!==this.account || ticket.generation!==this.generation)
      throw new Error('Native identity account changed');
    if(!Number.isInteger(nativeId) || nativeId<1 || nativeId>0xffffffff)
      throw new Error('Invalid native identity');
    if(this.nativeId!==null && this.nativeId!==nativeId) {
      this.nativeId=null;this.generation++;
      throw new Error('Conflicting native identity');
    }
    this.nativeId=nativeId;
  }
  resolve(ticket=this.ticket()) {
    if(!ticket.account || ticket.account!==this.account || ticket.generation!==this.generation || this.nativeId===null)
      throw new Error('Verified native identity unavailable');
    return this.nativeId;
  }
}
module.exports={NativeIdentity};
