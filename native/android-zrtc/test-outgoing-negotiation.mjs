import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {negotiateOutgoing} from './outgoing-negotiation.mjs';
const mapped={configuration:{},arguments:{servers:'[]'}};
for(const mode of ['early','late','wrong-id','error','change','cancel','invalid','make-only']) {
  const worker=new EventEmitter(),abort=new AbortController();
  worker.request=async operation=>{
    if(operation==='configure') return {code:0,offline:false};
    assert.equal(operation,'makeCall');
    const event={requestId:mode==='wrong-id'?456:123,event:'onInitZrtpWithServer',args:['127.0.0.1:9000','127.0.0.1:9001']};
    if(mode==='error') event.event='onInitZrtpRequestFailed';
    if(mode==='change') event.event='onCallChangeZRTP';
    if(mode==='make-only') event.event='onMakeCall';
    if(mode==='invalid') event.args[0]='not-a-server';
    if(mode==='late') setImmediate(()=>worker.emit('callEvent',event));
    else if(mode==='cancel') setImmediate(()=>abort.abort());
    else worker.emit('callEvent',event);
    return {code:0,id:123};
  };
  const result=negotiateOutgoing(worker,mapped,{signal:abort.signal,timeoutMs:40});
  if(['early','late'].includes(mode)) {
    assert.deepEqual(await result,{requestId:123,rtpAddress:'127.0.0.1:9000',rtcpAddress:'127.0.0.1:9001',callReady:false});
  } else await assert.rejects(result,/timeout|failed|change|canceled|address/);
  assert.equal(worker.listenerCount('callEvent'),0);
}
console.log('PASS outgoing readiness gate: synthetic early/late callbacks, request correlation, error/change/cancel/timeout; onMakeCall is not readiness');
