'use strict';
// Keep the call window responsive while config/network/native startup is pending.
// finish joins cancellation acknowledgement before the dialing owner takes over.
function outgoingPreparation(dialog,{signal,video,peerName,cancel}) {
  const stage=new AbortController();
  const abort=()=>stage.abort();
  signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted)abort();
  let failure;
  const task=Promise.resolve().then(()=>{
    if(!stage.signal.aborted)return dialog('preparing',{signal:stage.signal,video,peerName});
  }).then(()=>{if(!stage.signal.aborted)cancel();})
    .catch(error=>{if(!stage.signal.aborted){failure=error;cancel();}})
    .finally(()=>signal.removeEventListener('abort',abort));
  return async()=>{stage.abort();await task;if(failure)throw failure;};
}
module.exports={outgoingPreparation};
