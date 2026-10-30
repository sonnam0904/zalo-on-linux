import assert from 'node:assert/strict';
import {prepareIncomingAnswer} from './incoming-answer.mjs';
const data={callInfo:JSON.stringify({rtpAddress:'127.0.0.1:1234',rtcpAddress:'127.0.0.1:1235',sessionId:'fixture'}),
  audioCodecs:'[{"name":"opus/16000/1","payload":112}]',extendData:'{"callType":1,"video":{"codec":[{"name":"h264","payload":97}]}}'};
const options={callerId:'9999999999999999999',callId:789,video:true,current(){}};
const calls=[];const worker={request:async op=>{calls.push(op);return {code:0,data:data[op]};}};
const result=await prepareIncomingAnswer(worker,options);
assert.equal(result.callerId,options.callerId);assert.equal(result.callId,789);assert.equal(result.status,0);
assert.equal(result.session,'fixture');assert.equal(result.rtpAddress,'127.0.0.1:1234');
assert.deepEqual(calls,['callInfo','audioCodecs','extendData']);
for(const at of [1,2,3]) {
  const controller=new AbortController();let count=0;
  await assert.rejects(prepareIncomingAnswer({request:async op=>{if(++count===at)controller.abort();return {code:0,data:data[op]};}}, {...options,signal:controller.signal}),/canceled/);
  assert.equal(count,at);
}
await assert.rejects(prepareIncomingAnswer(worker,{...options,current(){throw new Error('stale owner');}}),/stale owner/);
for(const patch of [{callInfo:'{"private-session":'},{audioCodecs:'[]'},{extendData:'{}'},
  {callInfo:JSON.stringify({rtpAddress:'attacker.example:80',rtcpAddress:'127.0.0.1:1',sessionId:'fixture'})}]) {
  await assert.rejects(prepareIncomingAnswer({request:async op=>({code:0,data:({...data,...patch})[op]})},options),error=>!error.message.includes('private-session'));
}
await assert.rejects(prepareIncomingAnswer(worker,{...options,callerId:123}),/identity/);
await assert.rejects(prepareIncomingAnswer(worker,{...options,current:undefined}),/ownership/);
console.log('PASS incoming answer preparation: native data, exact desktop caller ID, cancellation at every query, no send/media, redacted validation');
