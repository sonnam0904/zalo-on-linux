import assert from 'node:assert/strict';
import {decodeIncomingVoice,incomingControlKey} from './incoming-control.mjs';
import {IncomingSession} from './incoming-session.mjs';
import {NativeWorker} from './worker-client.mjs';

// Synthetic values in the captured envelope's shape. No saved credentials.
const codec=JSON.stringify([{name:'opus/16000/1',payload:112,frmPtime:20,dynamicFptime:0}]);
const params={id:789,protocol:1,sessId:'fixture-session',settings:{},zrtc_config:{},
  rtpIP:'127.0.0.1:9000',rtcpIP:'127.0.0.1:9001',rtpSerIp:'',
  codec:'[]',extendData:'{}',video:{enable:0}};
const request={type:'control',data:{act_type:'voip',act:'request',data:{
  uidFrom:'456',uidTo:'123',uidN:'9999999999999999999',callId:'789',codec,params:JSON.stringify(params)}}};
const context={nativeLocalId:123,clientVersion:'681'};
const withParams=p=>({...request,data:{...request.data,data:{...request.data.data,params:JSON.stringify({...params,...p})}}});
const withData=p=>({...request,data:{...request.data,data:{...request.data.data,...p}}});
const cancel=(callId='789',uidFrom='456')=>({type:'control',data:{act_type:'voip',act:'cancel',data:{callId,uidFrom}}});
const answeredElsewhere=(callId='789',uidFrom='456')=>({type:'control',data:{act_type:'voip',act:'answer',data:{callId,uidFrom}}});
const mapped=decodeIncomingVoice(request,context);
assert.equal(mapped.config.fromId,123);assert.equal(mapped.config.toId,456);
assert.equal(mapped.config.audioConfig,codec);assert.equal(mapped.config.rtpIP,params.rtpIP);
assert.ok(!JSON.stringify(mapped).includes('9999999999999999999'));
assert.throws(()=>decodeIncomingVoice(request),/verified local identity/);
assert.throws(()=>decodeIncomingVoice(request,{nativeLocalId:'9999999999999999999'}),/uint32/);
assert.throws(()=>decodeIncomingVoice(request,{nativeLocalId:124}),/recipient/);
assert.throws(()=>decodeIncomingVoice(withParams({id:790}),context),/call ID/);
for(const video of [undefined,{}, {enable:1},{enable:'0'}])
  assert.throws(()=>decodeIncomingVoice(withParams({video}),context),/media/);
for(const uidFrom of ['9999999999999999999','0456',-1,2**32,NaN])
  assert.throws(()=>decodeIncomingVoice(withData({uidFrom}),context),/uint32/);
for(const p of [{params:'{"secret-session":'}, {params:' '.repeat(65537)}, {codec:'not-json'}, {codec:'[]'}]) {
  assert.throws(()=>decodeIncomingVoice(withData(p),context),error=>{
    assert.ok(!error.message.includes('secret-session'));return true;
  });
}
assert.throws(()=>decodeIncomingVoice(withParams({changeZRTP:{enable:1}}),context),/switching/);
assert.equal(incomingControlKey(cancel()).action,'cancel');
assert.equal(incomingControlKey(answeredElsewhere()).action,'answer');

const worker=await NativeWorker.start(process.argv[2]);
let sent=0;
const session=new IncomingSession(worker,{request(){sent++;throw new Error('Must not signal without real readiness');},cancel(){}},
  {readyTimeoutMs:1000});
try {
  await assert.rejects(session.control(request),/verified local identity/);
  assert.equal((await worker.request('status')).configured,false);
  for(let attempt=0;attempt<3;attempt++) {
    let notify;
    const waiting=new Promise(resolve=>{notify=phase=>{if(phase==='awaiting-native') resolve();};});
    session.on('phase',notify);
    const active=session.control(request,context);
    // Register rejection handler before canceling the operation.
    const canceled=assert.rejects(active,/canceled/);
    await waiting;session.off('phase',notify);
    assert.equal((await session.control(request,context)).duplicate,true);
    assert.equal((await session.control(cancel('790'),context)).handled,false);
    assert.equal((await session.control(cancel('789','457'),context)).handled,false);
    assert.equal(session.phase,'awaiting-native');
    const stop1=session.control(cancel(),context),stop2=session.control(cancel(),context);
    await Promise.all([stop1,stop2,canceled]);
    assert.equal(session.phase,'idle');
    assert.equal((await worker.request('status')).initialized,false);
  }
  assert.equal(sent,0);
} finally {await session.dispose();assert.deepEqual(await worker.close(),{code:0,signal:null});}
console.log('PASS incoming control: strict identity/media/config validation; 3 real offline native attempts, duplicate/stale/parallel cancel handling; no network or PCM');
