import assert from 'node:assert/strict';
import {encodeCommand, NativeWorker} from './worker-client.mjs';
const worker = await NativeWorker.start(process.argv[2]);
const incoming = {rtpAddress:'127.0.0.1:9000',rtcpAddress:'127.0.0.1:9001',relayServer:'',audioCodec:'',extendData:''};
const states = [];
worker.on('callEvent',e=>{if(e.event==='onCallState')states.push(e);});
try {
  assert.throws(()=>encodeCommand(1,'callState',{state:402}),/media state/);
  assert.throws(()=>encodeCommand(1,'callState',{state:'SEND_407_SUCCESS'}),/media state/);
  assert.equal((await worker.request('callState',{state:'RINGING'})).code,-107);
  assert.equal((await worker.request('audioCodecs')).code,-107);
  await worker.request('initialize');
  const codecs = await worker.request('audioCodecs');
  assert.equal(codecs.code,0); assert.ok(Array.isArray(JSON.parse(codecs.data)));
  await worker.request('stop');
  await worker.request('configure',{userId:123,partnerId:456,session:'fixture',settings:'{}',zrtcConfig:'{}'});
  // Query only after applying CallConfig. This must not poison later calls.
  assert.equal((await worker.request('initialize')).code,0);
  const offer = JSON.parse((await worker.request('audioCodecs')).data);
  assert.deepEqual(offer,[{name:'opus/16000/1',payload:112,frmPtime:20,dynamicFptime:0}]);
  await worker.request('stop');
  const valid = {...incoming,audioCodec:JSON.stringify(offer)};
  for (let cycle = 0; cycle < 10; cycle++) {
    const reply = await worker.request('incomingCall',valid);
    assert.equal(reply.code,0); assert.equal(reply.initialized,true);
    assert.equal(reply.offline,true); assert.equal(reply.callReady,false);
    assert.deepEqual(JSON.parse((await worker.request('audioCodecs')).data),offer);
    await worker.request('callEvent',{event:'SEND_407_SUCCESS'});
    const count = states.length;
    assert.equal((await worker.request('callState',{state:'RINGING'})).code,0);
    assert.equal(states.length,count+1);
    assert.deepEqual(states.at(-1).args,[3]);
    assert.equal(states.at(-1).requestId,reply.id);
    // No PCM host is wired into this offline worker yet. Return an explicit
    // capability error instead of letting OpenSLES fallback kill the process.
    assert.equal((await worker.request('callState',{state:'EARLY'})).code,-95);
    assert.equal((await worker.request('callState',{state:'CONFIRMED'})).code,-95);
    assert.equal((await worker.request('configure',{userId:123})).code,-16);
    assert.equal((await worker.request('stop')).code,0);
  }
  for (let cycle = 0; cycle < 60; cycle++) {
    // Invalid address rejects before callback adoption; missing codecs rejects
    // later. Both must release the adapter and permit the next attempt.
    const args = cycle % 2 ? {...incoming,relayServer:'fixture-'.repeat(40)} : {...incoming,rtpAddress:'127.0.0.999:9000'};
    const reply = await worker.request('incomingCall',args);
    assert.equal(reply.code,-5); assert.equal(reply.initialized,false); assert.equal(reply.callReady,false);
  }
  for (let cycle = 0; cycle < 30; cycle++) {
    assert.equal((await worker.request('makeCall',{servers:cycle % 2 ? ' '.repeat(80)+'[]' : '[]'})).code,0);
    assert.equal((await worker.request('incomingCall',incoming)).code,-16);
    assert.equal((await worker.request('stop')).code,0);
  }
} finally { assert.deepEqual(await worker.close(),{code:0,signal:null}); }
console.log('PASS offline incoming: 10 negotiated/ringing callbacks, media capability guards, 60 failures, 30 outgoing retries; no connected call');
