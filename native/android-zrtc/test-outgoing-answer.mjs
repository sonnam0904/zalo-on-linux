import assert from 'node:assert/strict';
import {decodeOutgoingAnswer,acceptOutgoingAnswer} from './outgoing-answer.mjs';
const configuration={callId:789,partnerId:456};
const media={codec:'[{"name":"opus/16000/1","payload":112}]',extendData:'{}'};
const control={act_type:'voip',act:'answer',data:{callId:'789',uidFrom:'456',status:'0',params:JSON.stringify(media)}};
assert.deepEqual(decodeOutgoingAnswer(control,configuration),{audioCodec:media.codec,extendData:'{}'});
for(const change of [{status:'1'},{status:''},{status:false},{uidFrom:'457'},{callId:'790'},
  {params:'[]'},{params:JSON.stringify({...media,codec:'[]'})},{params:JSON.stringify({...media,extendData:'null'})}])
  assert.throws(()=>decodeOutgoingAnswer({...control,data:{...control.data,...change}},configuration));
for(const mode of ['ok','codec-failed','ack-failed','media-failed','abort']) {
  const steps=[],phases=[],abort=new AbortController();
  const worker={request:async(op)=>{
    steps.push(op);
    if(mode==='abort') abort.abort();
    return {code:mode==='codec-failed' && op==='updateCallerInfo' || mode==='media-failed' && op==='callState'?-5:0};
  }};
  const signaling={request:async(cmd,data)=>{
    steps.push(cmd);assert.deepEqual(data,{calleeId:'9999999999999999999',callId:789});
    if(mode==='ack-failed') throw new Error('ACK failed');
  }};
  const pending=acceptOutgoingAnswer(worker,signaling,control,configuration,
    {calleeId:'9999999999999999999',signal:abort.signal,onPhase:p=>phases.push(p)});
  if(mode==='ok') {assert.equal((await pending).callReady,false);assert.equal(phases.at(-1),'media-started');}
  else {await assert.rejects(pending);assert.ok(!phases.includes('media-started'));}
  assert.deepEqual(steps,mode==='codec-failed'||mode==='abort'?['updateCallerInfo']:
    mode==='ack-failed'?['updateCallerInfo',408]:['updateCallerInfo',408,'callState']);
}
console.log('PASS answer validation and codec → 408 → media ordering, failure/cancel gates; synthetic signaling only');
