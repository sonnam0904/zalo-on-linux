import assert from 'node:assert/strict';
import {activeCallControls} from './native-call-ui.mjs';
const controller=new AbortController(),states=[],requests=[];
const worker={request:async(op,args)=>{requests.push([op,args]);return {code:0};}};
await activeCallControls(worker,{signal:controller.signal},async(kind,options)=>{
  assert.equal(kind,'active');assert.equal(options.muteControl,true);states.push(options.muted);
  return states.length===3?'end':'toggle';
});
assert.deepEqual(states,[false,true,false]);
assert.deepEqual(requests,[['microphoneMute',{muted:true}],['microphoneMute',{muted:false}]]);
for(const failure of ['reject','code']) {
  let shown=0;
  await assert.rejects(activeCallControls({request:async()=>{
    if(failure==='reject')throw Error('private native detail');return {code:-1};
  }},{signal:controller.signal},async()=>{shown++;return 'toggle';}),/^Error: Microphone control unavailable$/);
  assert.equal(shown,1,'no optimistic muted state');
}
{
  const c=new AbortController();let reply,entered;
  const waiting=new Promise(resolve=>{entered=resolve;});let settled=false,shown=0;
  const running=activeCallControls({request:()=>{entered();return new Promise(resolve=>{reply=resolve;});}},
    {signal:c.signal},async()=>{shown++;return 'toggle';}).finally(()=>{settled=true;});
  await waiting;c.abort();await Promise.resolve();assert.equal(settled,false);
  reply({code:0});await running;assert.equal(shown,1);
}
console.log('PASS active controls: acknowledged mute/unmute, end, redacted failure, abort joins pending request');
